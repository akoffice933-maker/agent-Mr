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
    const { withTenant, rawDbPool, db } = await import("../../src/lib/tenant/pool");
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
    c3.release();
    await withTenant({ orgId: 1, userId: null, role: "admin" }, async () => {
      const r = await db.execute(sql`SELECT current_setting('app.org_id', true) AS v`);
      const v = (r as unknown as { rows: { v: string | null }[] }).rows[0].v;
      expect(v, "app path must be immune to stale session values").toBe("1");
    });
    // and the app path still leaves its own connection clean
    for (let i = 0; i < rawDbPool.totalCount; i++) {
      const c = (await rawDbPool.connect()) as unknown as PgLike;
      try {
        const v = await sessionSetting(c);
        if (v !== null && v !== "" && v !== "777") {
          throw new Error(`unexpected tenant context '${v}' on pooled connection #${i}`);
        }
      } finally {
        c.release();
      }
    }
  });

  it("fail-closed: a query without tenant context sees 0 campaigns", async () => {
    const { rawDbPool } = await import("../../src/lib/tenant/pool");
    const c = (await rawDbPool.connect()) as unknown as PgLike;
    try {
      await c.query("SELECT set_config('app.org_id', $1, false)", [""]);
      const r = await c.query("SELECT count(*)::text AS n FROM campaigns");
      expect(r.rows[0].n).toBe("0");
    } finally {
      c.release();
    }
  });
});
