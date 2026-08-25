// Integration security tests (Phase C.1). Run against a real database when
// DATABASE_TEST_URL is set; skipped otherwise (CI without a DB stays green).
//
// Covers:
//   1. RLS audit: FORCE RLS + policies + NOT NULL org columns + no SECURITY
//      DEFINER functions + no raw api-key column + no unknown tables
//      (regression guard against new unprotected tables).
//   2. set_config regression: the tenant context is SET LOCAL inside a
//      transaction — it cannot survive on a pooled connection.
//   3. Fail-closed: a query issued WITHOUT a tenant context sees 0 rows.

import { describe, expect, it } from "vitest";
import { Pool } from "pg";

const dbUrl = process.env.DATABASE_TEST_URL;

interface PgLike {
  query(q: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}

describe.skipIf(!dbUrl)("tenant security (requires DATABASE_TEST_URL)", () => {
  it("database reachable", async () => {
    const p = new Pool({ connectionString: dbUrl, connectionTimeoutMillis: 1500 });
    try {
      const c = await p.connect();
      c.release();
    } finally {
      await p.end();
    }
  });

  it("RLS audit: tenant tables protected, no definers, no raw keys, no unknown tables", async () => {
    const pool = new Pool({ connectionString: dbUrl });
    try {
      const { runRlsAudit } = await import("../../scripts/rls-audit");
      const report = await runRlsAudit((sql, params) =>
        pool.query(sql, (params ?? []) as unknown[]).then((r) => ({ rows: r.rows as Record<string, unknown>[] }))
      );
      expect(report.violations, report.violations.join(" | ")).toEqual([]);
      expect(report.tables.unknown).toEqual([]);
      expect(report.securityDefinerFunctions).toEqual([]);
    } finally {
      await pool.end();
    }
  });

  it("set_config regression: tenant context is transaction-scoped and cannot leak", async () => {
    const { withTenant, identityPool: rawDbPool, db } = await import("../../src/lib/tenant/pool");
    const { sql } = await import("drizzle-orm");

    const sessionSetting = async (c: PgLike) => (await c.query("SELECT current_setting('app.org_id', true) AS v")).rows[0].v as string | null;

    // 1) inside withTenant, drizzle queries (routed to the pinned connection,
    //    inside the tenant transaction) see the context
    await withTenant({ orgId: 1, userId: null, role: "admin" }, async () => {
      const r = await db.execute(sql`SELECT current_setting('app.org_id', true) AS v`);
      const v = (r as unknown as { rows: { v: string | null }[] }).rows[0].v;
      expect(v, "drizzle query must run in the tenant context").toBe("1");
    });

    // 2) after withTenant (COMMIT): every live pooled client is clean —
    //    SET LOCAL vanishes with the transaction, nothing is left behind
    const total = rawDbPool.totalCount;
    for (let i = 0; i < total; i++) {
      const c = (await rawDbPool.connect()) as unknown as PgLike;
      try {
        expect(await sessionSetting(c) ?? "", `pooled connection #${i} leaked tenant context`).toBe("");
      } finally {
        c.release();
      }
    }

    // 3) raw session-level misuse on a pooled client does NOT affect the app
    //    path: withTenant opens its own transaction where SET LOCAL shadows
    //    any session value
    const c3 = (await rawDbPool.connect()) as unknown as PgLike;
    await c3.query("SELECT set_config('app.org_id', $1, false)", ["777"]);
    try {
      await withTenant({ orgId: 1, userId: null, role: "admin" }, async () => {
        const r = await db.execute(sql`SELECT current_setting('app.org_id', true) AS v`);
        const v = (r as unknown as { rows: { v: string | null }[] }).rows[0].v;
        expect(v, "app path must be immune to stale session values").toBe("1");
      });
    } finally {
      // Clean up the deliberate misuse BEFORE releasing, so the shared pool
      // is never left with a poisoned session value.
      await c3.query("SELECT set_config('app.org_id', NULL, false)").catch(() => undefined);
      c3.release();
    }
    // and the pool is fully clean afterwards (no stale values on any client)
    for (let i = 0; i < rawDbPool.totalCount; i++) {
      const c = (await rawDbPool.connect()) as unknown as PgLike;
      try {
        expect(await sessionSetting(c) ?? "", `pooled connection #${i} leaked tenant context`).toBe("");
      } finally {
        c.release();
      }
    }
  });

  it("fail-closed: a query without tenant context sees 0 campaigns (never errors)", async () => {
    // Dedicated pool: this test deliberately probes "no context" and "empty
    // context" states on a live connection — it must not run on (or poison)
    // the app's shared pool.
    const p = new Pool({ connectionString: dbUrl, connectionTimeoutMillis: 1500 });
    try {
      const c = await p.connect();
      // A fresh connection has no tenant context at all.
      expect(
        (await c.query("SELECT current_setting('app.org_id', true) AS v")).rows[0].v,
        "fresh connection must have no tenant context"
      ).toBeNull();
      const r = await c.query("SELECT count(*)::text AS n FROM campaigns");
      expect(r.rows[0].n, "no context → 0 rows").toBe("0");
      // An explicitly EMPTY context must fail closed the same way — and must
      // NOT raise (NULLIF in the policy, see drizzle/0002).
      await c.query("SELECT set_config('app.org_id', $1, false)", [""]);
      const r2 = await c.query("SELECT count(*)::text AS n FROM campaigns");
      expect(r2.rows[0].n, "empty context → 0 rows, no error").toBe("0");
      c.release();
    } finally {
      await p.end();
    }
  });
});

// Identity / role source of truth (E.1 P0-5): the effective role ALWAYS comes
// from org_members (per-tenant membership), never from the deprecated
// users.role column. A corrupted/legacy users.role must not change anything.
describe("role source of truth (org_members, not users.role)", () => {
  it("users.role=admin + org_members.role=viewer → effective role is viewer", async () => {
    const { resolveSessionContext } = await import("../../src/lib/tenant/resolve");
    const { identityPool } = await import("../../src/lib/tenant/pool");
    const stamp = Date.now();
    const org = (await identityPool.query(`INSERT INTO organizations (name) VALUES ($1) RETURNING id`, [`E1 role ${stamp}`])) as any;
    const orgId = org.rows[0].id as number;
    const user = (await identityPool.query(
      `INSERT INTO users (email, password_hash, role) VALUES ($1, 'h', 'admin') RETURNING id`,
      [`e1-role-${stamp}@test.local`]
    )) as any;
    const userId = user.rows[0].id as number;
    await identityPool.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'viewer')`, [orgId, userId]);
    const sid = `role-test-${userId}-${stamp.toString(16)}`;
    await identityPool.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')`, [sid, userId]);

    try {
      const ctx = await resolveSessionContext(new Request("http://t.local/x", { headers: { cookie: `agentmr_sid=${sid}` } }));
      expect(ctx, "session must resolve").toBeTruthy();
      expect(ctx!.orgId).toBe(orgId);
      expect(ctx!.userId).toBe(userId);
      expect(ctx!.role, "effective role must come from org_members (viewer), not users.role (admin)").toBe("viewer");
    } finally {
      await identityPool.query(`DELETE FROM sessions WHERE id = $1`, [sid]).catch(() => undefined);
      await identityPool.query(`DELETE FROM users WHERE id = $1`, [userId]).catch(() => undefined);
      await identityPool.query(`DELETE FROM organizations WHERE id = $1`, [orgId]).catch(() => undefined);
    }
  });
});
