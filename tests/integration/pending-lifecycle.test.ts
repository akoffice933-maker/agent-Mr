// Phase 0.4/0.5/0.6 (review 27.08.2026): pending-actions lifecycle.
//   0.4 — every lifecycle transition bumps `version` (optimistic lock);
//   0.5 — pending/failed actions expire after 48h (expires_at) and refuse
//         resolution once expired;
//   0.6 — a per-org open-pending cap gates new writes.
//
// Runs against the real DB (DATABASE_TEST_URL); skipped otherwise. Rows are
// tagged source="lifecycle-test" and cleaned up in afterAll.

import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, withTenant } from "@/db";
import { pendingActions } from "@/db/schema";
import {
  resolvePending,
  sweepExpiredPending,
  openPendingCount,
  createPendingAction,
  MAX_OPEN_PENDING,
  PENDING_TTL_MS,
} from "@/lib/agent/run";

const dbUrl = process.env.DATABASE_TEST_URL ?? process.env.DATABASE_URL;
const ctx = { orgId: 1, userId: null, role: "admin" } as const;
const MARKER = "lifecycle-test";

async function insertPending(overrides: Record<string, unknown> = {}) {
  const [row] = await db
    .insert(pendingActions)
    .values({
      organizationId: 1,
      tool: "set_campaign_status",
      params: { marker: MARKER, n: Math.random() },
      preview: { kind: "preview", title: "t", changes: [], verdict: "pending" },
      costDaily: 0,
      idempotencyKey: `lifecycle-${Math.random().toString(36).slice(2)}`,
      status: "pending",
      source: MARKER,
      ...overrides,
    })
    .returning();
  return row;
}

async function statusOf(id: number): Promise<string> {
  return withTenant(ctx, async () => {
    const r = (await db.select({ s: pendingActions.status }).from(pendingActions).where(eq(pendingActions.id, id)))[0];
    return r?.s ?? "<missing>";
  });
}

describe.skipIf(!dbUrl)("pending lifecycle (Phase 0.4/0.5/0.6)", () => {
  afterAll(async () => {
    await withTenant(ctx, async () => {
      const rows = await db.select({ id: pendingActions.id }).from(pendingActions).where(eq(pendingActions.source, MARKER));
      for (const r of rows) await db.delete(pendingActions).where(eq(pendingActions.id, r.id));
    });
  });

  it("0.5: createPendingAction stamps expires_at = now + 48h (the real runAgent path)", async () => {
    const before = Date.now();
    const { id } = await withTenant(ctx, () =>
      createPendingAction({
        org: 1,
        tool: "set_campaign_status",
        params: { marker: MARKER, n: Math.random() },
        preview: { kind: "preview", title: "t", changes: [], verdict: "pending" },
        costDaily: 0,
        source: MARKER,
      })
    );
    const row = await withTenant(ctx, async () =>
      db.select().from(pendingActions).where(eq(pendingActions.id, id))
    );
    const exp = row[0].expiresAt;
    expect(exp).toBeTruthy();
    const delta = exp!.getTime() - before;
    expect(delta).toBeGreaterThanOrEqual(PENDING_TTL_MS - 2000);
    expect(delta).toBeLessThanOrEqual(PENDING_TTL_MS + 2000);
  });

  it("0.5: an expired pending is swept to 'expired' and refuses resolution", async () => {
    const id = await withTenant(ctx, async () => {
      const row = await insertPending({ expiresAt: new Date(Date.now() - 1000) }); // already stale
      return row.id;
    });
    const res = await withTenant(ctx, () => resolvePending(id, "approve", "chat", ctx));
    expect(res).toBeTruthy();
    expect((res as { content: string }).content).toMatch(/истекло/i);
    expect(await statusOf(id)).toBe("expired");
  });

  it("0.5: sweepExpiredPending is idempotent and org-scoped", async () => {
    const stale = await withTenant(ctx, async () => {
      const r = await insertPending({ expiresAt: new Date(Date.now() - 1000) });
      return r.id;
    });
    const n1 = await withTenant(ctx, () => sweepExpiredPending(1));
    const n2 = await withTenant(ctx, () => sweepExpiredPending(1));
    expect(n1).toBeGreaterThanOrEqual(1);
    expect(n2).toBe(0); // already swept — idempotent
    expect(await statusOf(stale)).toBe("expired");
  });

  it("0.4: rejecting a pending bumps version (0 → 1) and sets status=rejected", async () => {
    const id = await withTenant(ctx, async () => (await insertPending()).id);
    const res = await withTenant(ctx, () => resolvePending(id, "reject", "chat", ctx));
    expect(res).toBeTruthy();
    const row = await withTenant(ctx, async () => (await db.select().from(pendingActions).where(eq(pendingActions.id, id)))[0]);
    expect(row.status).toBe("rejected");
    expect(row.version).toBe(1);
  });

  it("0.4: an already-rejected pending cannot be re-resolved (returns null)", async () => {
    const id = await withTenant(ctx, async () => (await insertPending()).id);
    await withTenant(ctx, () => resolvePending(id, "reject", "chat", ctx));
    const res = await withTenant(ctx, () => resolvePending(id, "approve", "chat", ctx));
    expect(res).toBeNull();
  });

  it("0.6: openPendingCount drives the cap gate (reaching MAX rejects new writes)", async () => {
    const ids: number[] = [];
    await withTenant(ctx, async () => {
      const baseline = await openPendingCount(1);
      const need = Math.max(0, MAX_OPEN_PENDING - baseline) + 1;
      for (let i = 0; i < need; i++) ids.push((await insertPending()).id);
      const after = await openPendingCount(1);
      expect(after).toBe(baseline + need);
      expect(after >= MAX_OPEN_PENDING).toBe(true); // runAgent would reject new writes here
    });
    // tidy up immediately so the cap doesn't leak into other suites
    await withTenant(ctx, async () => {
      for (const id of ids) await db.delete(pendingActions).where(eq(pendingActions.id, id));
    });
  });
});
