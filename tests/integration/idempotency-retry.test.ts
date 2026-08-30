// Review P1.2 regression: an idempotency key must not permanently burn.
//
// The bug: `idempotency_key` carried a GLOBAL unique constraint. The key is
// derived from (tool, params, org), so once a user REJECTED an action — or it
// expired/failed — that exact action could never be proposed again: the insert
// died with a raw 23505 and the agent reported an internal error. "Pause
// campaign X" was a one-shot operation for the lifetime of the organization.
//
// The fix (drizzle/0010) narrows uniqueness to ACTIVE rows only:
//   UNIQUE (idempotency_key) WHERE status IN ('pending','executing')
// so duplicate protection still holds while an action is in flight, but a
// terminal action releases the key.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import { db, withTenant } from "@/db";
import { campaigns, organizations, pendingActions } from "@/db/schema";
import { createPendingAction } from "@/lib/agent/run";

const ORG = 1;
const ctx = { orgId: ORG, userId: null, role: "admin" };

let campaignId = 0;

/** Same tool+params ⇒ same derived idempotency key. */
function propose() {
  return withTenant(ctx, () =>
    createPendingAction({
      org: ORG,
      tool: "set_campaign_status",
      params: { campaignId, status: "paused" },
      preview: { kind: "text", text: "pause" },
      costDaily: 0,
      source: "test",
    })
  );
}

async function setStatus(id: number, status: string) {
  await withTenant(ctx, () => db.update(pendingActions).set({ status }).where(eq(pendingActions.id, id)));
}

beforeAll(async () => {
  await withTenant(ctx, async () => {
    const org = await db.select().from(organizations).where(eq(organizations.id, ORG)).limit(1);
    if (org.length === 0) await db.insert(organizations).values({ name: "Test" }).onConflictDoNothing();
    const row = (
      await db
        .insert(campaigns)
        .values({
          organizationId: ORG,
          name: "Idempotency Retry Test",
          platform: "yandex",
          status: "active",
          budgetDaily: 1000,
        })
        .returning()
    )[0];
    campaignId = row.id;
  });
});

beforeEach(async () => {
  await withTenant(ctx, () => db.delete(pendingActions).where(eq(pendingActions.organizationId, ORG)));
});

describe("pending action idempotency (review P1.2)", () => {
  it("proposing the same action twice while pending returns the SAME action", async () => {
    const first = await propose();
    const second = await propose();
    // Deduplicated rather than crashing with a raw 23505.
    expect(second.duplicateOf ?? second.id).toBe(first.id);

    const rows = await withTenant(ctx, () =>
      db.select().from(pendingActions).where(eq(pendingActions.organizationId, ORG))
    );
    expect(rows).toHaveLength(1);
  });

  it("after REJECTING, the same action can be proposed again", async () => {
    const first = await propose();
    await setStatus(first.id, "rejected");

    // This is the exact scenario that used to fail permanently.
    const retry = await propose();
    expect(retry.id).not.toBe(first.id);
    expect(retry.duplicateOf).toBeUndefined();

    const fresh = await withTenant(ctx, async () =>
      (await db.select().from(pendingActions).where(eq(pendingActions.id, retry.id)))[0]
    );
    expect(fresh.status).toBe("pending");
  });

  it("after a FAILED attempt, the action can be retried", async () => {
    const first = await propose();
    await setStatus(first.id, "failed");
    const retry = await propose();
    expect(retry.id).not.toBe(first.id);
  });

  it("after VERIFIED completion, the same action can be requested again later", async () => {
    const first = await propose();
    await setStatus(first.id, "verified");
    const retry = await propose();
    expect(retry.id).not.toBe(first.id);
  });

  it("an EXECUTING action still blocks a duplicate (in-flight protection holds)", async () => {
    const first = await propose();
    await setStatus(first.id, "executing");
    const second = await propose();
    expect(second.duplicateOf ?? second.id).toBe(first.id);

    const rows = await withTenant(ctx, () =>
      db.select().from(pendingActions).where(eq(pendingActions.organizationId, ORG)).orderBy(desc(pendingActions.id))
    );
    expect(rows).toHaveLength(1);
  });
});
