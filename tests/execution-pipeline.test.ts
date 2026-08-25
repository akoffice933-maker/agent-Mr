// Phase E (E4/E6/E7): execution pipeline — write → provider response → read-back → verified.
//
// Tests the Yandex Direct adapter's EXECUTION contract against its in-process
// simulator (no real account, no real money):
//   E4  write → read-back → VERIFIED (and NOT verified on mismatch)
//   E6  idempotency (re-applying an already-verified action is a no-op)
//   E7  retry on transient failures, no retry on permanent failures
//
// The simulator implements the same {method, params} → {result, errors}
// provider contract as the real Direct API v5 (State ON/SUSPENDED, Budget,
// per-item ActionResult errors), so the read-back verification (E4) and
// retry (E7) semantics are exercised against a faithful provider contract.
//
// Requires a real PostgreSQL instance (DATABASE_URL must point to a working DB
// with the schema applied). Skips gracefully when unavailable.

import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { createSimulator, type SimCampaign } from "@/lib/adapters/yandex-direct/simulator";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { campaigns } from "@/db/schema";

// Check if the database is reachable before running integration tests.
let dbAvailable = false;
try {
  const { rawDbPool } = await import("@/lib/tenant/pool");
  const client = await rawDbPool.connect();
  await client.query("SELECT 1");
  client.release();
  dbAvailable = true;
} catch {
  // Database not available — skip integration tests.
}

const simCampaigns: SimCampaign[] = [
  { Id: 100, Name: "Sim Camp A", State: "ON", Budget: 1000, Type: "TEXT_CAMPAIGN" },
  { Id: 200, Name: "Sim Camp B", State: "ON", Budget: 2000, Type: "TEXT_CAMPAIGN" },
];

// Local mirror campaign ids (inserted into the DB so the client can map local→external).
let localA = 0;
let localB = 0;

beforeAll(async () => {
  // Insert the local mirror campaigns with externalIds matching the simulator's Ids.
  const rows = await db
    .insert(campaigns)
    .values([
      { organizationId: 1, platform: "yandex", kind: "campaign", externalId: "100", name: "Sim Camp A", status: "active", budgetDaily: 1000, strategy: "test" },
      { organizationId: 1, platform: "yandex", kind: "campaign", externalId: "200", name: "Sim Camp B", status: "active", budgetDaily: 2000, strategy: "test" },
    ])
    .returning();
  localA = rows[0].id;
  localB = rows[1].id;
});

// Reset local mirror status before each test — the `it()` blocks below must
// not depend on side effects left by previous tests (each scenario assumes
// a known starting state).
beforeEach(async () => {
  if (!dbAvailable) return;
  await db.update(campaigns).set({ status: "active" }).where(inArray(campaigns.id, [localA, localB]));
});

afterAll(async () => {
  await db.delete(campaigns).where(inArray(campaigns.id, [localA, localB])).catch(() => undefined);
});

import { createYandexClient } from "@/lib/adapters/yandex-direct/client";

function clientWith(sim: ReturnType<typeof createSimulator>) {
  return createYandexClient({ simulated: true, transport: sim.transport });
}

describe.skipIf(!dbAvailable)("Phase E: execution pipeline (write → read-back → verified)", () => {
  it("E4: suspend → provider response → read-back → VERIFIED", async () => {
    const sim = createSimulator({ campaigns: simCampaigns.map((c) => ({ ...c })) });
    const client = clientWith(sim);
    const res = await client.execute({ kind: "campaign_status", campaignIds: [localA, localB], status: "paused" });
    expect(res.ok).toBe(true);
    expect(res.verified).toBe(true);
    expect(res.providerResponse).toBeTruthy();
    expect(res.readback).toBeTruthy();
    // The simulator's state (the provider's source of truth) must reflect the suspension.
    expect(sim.state.campaigns.find((c) => c.Id === 100)?.State).toBe("SUSPENDED");
    expect(sim.state.campaigns.find((c) => c.Id === 200)?.State).toBe("SUSPENDED");
    // The local mirror must be consistent with the provider's read-back truth.
    const localA2 = (await db.select().from(campaigns).where(eq(campaigns.id, localA)))[0];
    expect(localA2?.status).toBe("paused");
  });

  it("E4: resume → read-back → VERIFIED (state returns to ON)", async () => {
    const sim = createSimulator({ campaigns: simCampaigns.map((c) => ({ ...c })) });
    const client = clientWith(sim);
    await client.execute({ kind: "campaign_status", campaignIds: [localA], status: "paused" });
    expect(sim.state.campaigns.find((c) => c.Id === 100)?.State).toBe("SUSPENDED");
    const res = await client.execute({ kind: "campaign_status", campaignIds: [localA], status: "active" });
    expect(res.ok).toBe(true);
    expect(res.verified).toBe(true);
    expect(sim.state.campaigns.find((c) => c.Id === 100)?.State).toBe("ON");
  });

  it("E7: transient provider failure → retry → VERIFIED", async () => {
    const sim = createSimulator({ campaigns: simCampaigns.map((c) => ({ ...c })) });
    sim.injectTransientFailures(2); // first 2 write attempts fail with a transient error
    const client = clientWith(sim);
    const res = await client.execute({ kind: "campaign_status", campaignIds: [localA], status: "paused" });
    // maxAttempts=3: attempts 1 and 2 fail (transient), attempt 3 succeeds.
    expect(res.ok).toBe(true);
    expect(res.verified).toBe(true);
    expect(sim.state.campaigns.find((c) => c.Id === 100)?.State).toBe("SUSPENDED");
  });

  it("E7: permanent provider failure → FAILED (no retry, not verified, state unchanged)", async () => {
    const sim = createSimulator({ campaigns: simCampaigns.map((c) => ({ ...c })) });
    sim.injectPermanentFailure("Campaign locked by moderation");
    const client = clientWith(sim);
    const res = await client.execute({ kind: "campaign_status", campaignIds: [localA], status: "paused" });
    expect(res.ok).toBe(false);
    expect(res.verified).toBe(false);
    expect(res.error).toContain("Campaign locked by moderation");
    // The provider's state must NOT have changed (the write failed).
    expect(sim.state.campaigns.find((c) => c.Id === 100)?.State).toBe("ON");
    // The local mirror must also be unchanged (read-back failed → no local update).
    const localA2 = (await db.select().from(campaigns).where(eq(campaigns.id, localA)))[0];
    expect(localA2?.status).toBe("active");
  });

  it("E4: read-back mismatch (provider rejected a campaign) → NOT verified, state unchanged", async () => {
    const sim = createSimulator({ campaigns: [{ Id: 100, Name: "Sim Camp A", State: "ON", Budget: 1000, Type: "TEXT_CAMPAIGN" }] });
    const client = clientWith(sim);
    // The local mirror has localB (externalId 200), but the simulator has no campaign 200.
    // The provider returns a per-item error (270 not found) → read-back mismatch → NOT verified.
    const res = await client.execute({ kind: "campaign_status", campaignIds: [localB], status: "paused" });
    expect(res.ok).toBe(false);
    expect(res.verified).toBe(false);
    expect(res.error).toContain("200");
    // The provider's state is unchanged; the local mirror must also be unchanged.
    expect(sim.state.campaigns.find((c) => c.Id === 200)?.State).toBeUndefined();
    const localB2 = (await db.select().from(campaigns).where(eq(campaigns.id, localB)))[0];
    expect(localB2?.status).toBe("active");
  });

  it("E6: idempotency — re-applying an already-verified suspend is a no-op", async () => {
    const sim = createSimulator({ campaigns: simCampaigns.map((c) => ({ ...c })) });
    const client = clientWith(sim);
    const first = await client.execute({ kind: "campaign_status", campaignIds: [localA], status: "paused" });
    expect(first.verified).toBe(true);
    // Re-apply the same suspend: the provider already has it SUSPENDED → read-back matches → verified (idempotent).
    const second = await client.execute({ kind: "campaign_status", campaignIds: [localA], status: "paused" });
    expect(second.verified).toBe(true);
    expect(sim.state.campaigns.find((c) => c.Id === 100)?.State).toBe("SUSPENDED");
  });
});
