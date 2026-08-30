// User-flow review: reloading /agent brought the "Подтвердить / Отклонить"
// buttons back under actions that were already executed.
//
// The chat hides those buttons for any action it knows to be resolved, but
// that knowledge lived only in React state and reset on every mount. The
// history endpoint now ships `pendingStates` alongside the messages so the
// client can restore it.
//
// Money was never at risk (resolvePending only accepts 'pending'/'failed') —
// the failure was that a click on a stale button did nothing visible at all.
// These tests pin the state map that fixes it.

import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, withTenant } from "@/db";
import { pendingActions } from "@/db/schema";
import { identityPool } from "@/lib/tenant/pool";
import { getPendingStates } from "@/lib/agent/run";

const dbUrl = process.env.DATABASE_TEST_URL ?? process.env.DATABASE_URL;
const d = dbUrl ? describe : describe.skip;

const ctx = { orgId: 1, userId: null, role: "admin" } as const;
const MARKER = "pending-states-test";

// Review bug (found while verifying this commit): the "leaks another org"
// test originally hardcoded orgId 2 for the foreign organization. Org 1 is
// the seeded default and always exists, but org 2 is not guaranteed to —
// other integration test files create organizations dynamically with
// auto-incrementing ids, so a bare literal 2 depends on run order and fails
// with a foreign-key violation whenever anything else has already created
// two or more orgs first. Create it for real instead.
let foreignOrgId: number;

async function insertPending(status: string, orgId = 1) {
  const [row] = await withTenant({ ...ctx, orgId }, () =>
    db
      .insert(pendingActions)
      .values({
        organizationId: orgId,
        tool: "set_campaign_status",
        params: { marker: MARKER },
        preview: { kind: "preview", title: "t", changes: [], verdict: "pending" },
        costDaily: 0,
        idempotencyKey: `${MARKER}-${Math.random().toString(36).slice(2)}`,
        status,
        source: MARKER,
      })
      .returning()
  );
  return row;
}

afterAll(async () => {
  if (!dbUrl) return;
  const orgs = [1, ...(foreignOrgId ? [foreignOrgId] : [])];
  for (const org of orgs) {
    await withTenant({ ...ctx, orgId: org }, () => db.delete(pendingActions).where(eq(pendingActions.source, MARKER)));
  }
  if (foreignOrgId) await identityPool.query("DELETE FROM organizations WHERE id = $1", [foreignOrgId]);
});

d("getPendingStates: restoring resolved actions after a reload", () => {
  it("reports a verified action as applied", async () => {
    const row = await insertPending("verified");
    const states = await withTenant(ctx, () => getPendingStates());
    expect(states[row.id]).toBe("applied");
  });

  it("reports rejected and expired actions", async () => {
    const rejected = await insertPending("rejected");
    const expired = await insertPending("expired");
    const states = await withTenant(ctx, () => getPendingStates());
    expect(states[rejected.id]).toBe("rejected");
    expect(states[expired.id]).toBe("expired");
  });

  it("reports an in-flight action as executing", async () => {
    // The buttons must not reappear mid-execution and invite a second click.
    const row = await insertPending("executing");
    const states = await withTenant(ctx, () => getPendingStates());
    expect(states[row.id]).toBe("executing");
  });

  it("does NOT report actions still awaiting a decision", async () => {
    // This is the whole point: a genuinely pending action must keep its
    // buttons after a reload.
    const row = await insertPending("pending");
    const states = await withTenant(ctx, () => getPendingStates());
    expect(states[row.id]).toBeUndefined();
  });

  it("reports a failed action, which stays retryable", async () => {
    // Surfaced so the badge can show it, but the UI deliberately treats
    // 'failed' as non-final: a retry resumes rather than duplicates.
    const row = await insertPending("failed");
    const states = await withTenant(ctx, () => getPendingStates());
    expect(states[row.id]).toBe("failed");
  });

  it("NEVER leaks another organization's actions", async () => {
    const org = (await identityPool.query("INSERT INTO organizations (name) VALUES ($1) RETURNING id", [
      "Pending States Test Org",
    ])) as { rows: { id: number }[] };
    foreignOrgId = org.rows[0].id;
    const otherCtx = { orgId: foreignOrgId, userId: null, role: "admin" } as const;

    const foreign = await insertPending("verified", foreignOrgId);
    const states = await withTenant(ctx, () => getPendingStates());
    expect(states[foreign.id]).toBeUndefined();

    // ...and the other org does see its own.
    const own = await withTenant(otherCtx, () => getPendingStates());
    expect(own[foreign.id]).toBe("applied");
  });
});
