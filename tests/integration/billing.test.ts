// Subscription state, entitlements and webhook idempotency.
//
// The expensive failure modes here are: a retried webhook applied twice, and a
// lapsed subscription still granting paid capacity.

import { afterAll, describe, expect, it } from "vitest";
import { identityPool } from "@/lib/tenant/pool";
import {
  applyPlanUpdate,
  ensureSubscription,
  entitlements,
  getSubscription,
  markEventProcessed,
  recordEventOnce,
} from "@/lib/billing/subscription";
import { PLANS, planLimits, statusGrantsAccess } from "@/lib/billing/plans";

const dbUrl = process.env.DATABASE_TEST_URL ?? process.env.DATABASE_URL;
const d = dbUrl ? describe : describe.skip;

const orgIds: number[] = [];
const EVENT_PREFIX = `billingtest-${Math.random().toString(36).slice(2, 8)}`;

async function newOrg(name = "Billing Test Org"): Promise<number> {
  const res = (await identityPool.query("INSERT INTO organizations (name) VALUES ($1) RETURNING id", [name])) as {
    rows: { id: number }[];
  };
  const id = res.rows[0].id;
  orgIds.push(id);
  return id;
}

afterAll(async () => {
  if (!dbUrl) return;
  await identityPool.query("DELETE FROM payment_events WHERE event_id LIKE $1", [`${EVENT_PREFIX}%`]);
  if (orgIds.length) {
    await identityPool.query("DELETE FROM payment_events WHERE org_id = ANY($1)", [orgIds]);
    await identityPool.query("DELETE FROM subscriptions WHERE org_id = ANY($1)", [orgIds]);
    await identityPool.query("DELETE FROM organizations WHERE id = ANY($1)", [orgIds]);
  }
});

describe("plan table (pure)", () => {
  it("an unknown plan falls back to FREE, never to a paid one", () => {
    // A corrupt row or an unexpected provider value must not grant capacity.
    expect(planLimits("enterprise-typo").id).toBe("free");
    expect(planLimits(null).id).toBe("free");
    expect(planLimits(undefined).id).toBe("free");
  });

  it("pro is strictly more generous than free", () => {
    expect(PLANS.pro.maxAccounts).toBeGreaterThan(PLANS.free.maxAccounts);
    expect(PLANS.pro.maxWriteActionsPerMonth).toBeGreaterThan(PLANS.free.maxWriteActionsPerMonth);
    expect(PLANS.pro.maxMembers).toBeGreaterThan(PLANS.free.maxMembers);
  });

  it("past_due keeps access; canceled does not", () => {
    // Dunning should nag, not cut an advertiser off mid-campaign.
    expect(statusGrantsAccess("past_due")).toBe(true);
    expect(statusGrantsAccess("active")).toBe(true);
    expect(statusGrantsAccess("canceled")).toBe(false);
    expect(statusGrantsAccess("unpaid")).toBe(false);
  });
});

d("subscriptions", () => {
  it("a new org defaults to the free plan", async () => {
    const org = await newOrg();
    await ensureSubscription(org);
    const limits = await entitlements(org);
    expect(limits.id).toBe("free");
  });

  it("an org with NO subscription row still works (treated as free)", async () => {
    // Orgs created before billing existed must not break.
    const org = await newOrg();
    expect((await entitlements(org)).id).toBe("free");
  });

  it("applies an upgrade", async () => {
    const org = await newOrg();
    await applyPlanUpdate(org, {
      plan: "pro",
      status: "active",
      provider: "stripe",
      providerCustomerId: "cus_x",
      providerSubscriptionId: "sub_x",
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    });
    expect((await entitlements(org)).id).toBe("pro");
    const sub = await getSubscription(org);
    expect(sub?.provider).toBe("stripe");
  });

  it("keeps only ONE subscription row per org", async () => {
    const org = await newOrg();
    await applyPlanUpdate(org, { plan: "pro", status: "active", provider: "stripe" });
    await applyPlanUpdate(org, { plan: "pro", status: "active", provider: "yookassa" });
    const rows = (await identityPool.query("SELECT count(*)::int AS n FROM subscriptions WHERE org_id = $1", [org])) as {
      rows: { n: number }[];
    };
    // An ambiguous entitlement lookup is how orgs end up silently on the wrong
    // plan.
    expect(rows.rows[0].n).toBe(1);
  });

  it("a CANCELED subscription loses paid capacity", async () => {
    const org = await newOrg();
    await applyPlanUpdate(org, { plan: "pro", status: "active", provider: "stripe" });
    expect((await entitlements(org)).id).toBe("pro");

    await applyPlanUpdate(org, { plan: "free", status: "canceled", provider: "stripe" });
    expect((await entitlements(org)).id).toBe("free");
  });

  it("an EXPIRED period loses paid capacity even if the status still says active", async () => {
    // The provider stopped renewing but never sent a cancellation: access must
    // still lapse rather than become free-forever pro.
    const org = await newOrg();
    await applyPlanUpdate(org, {
      plan: "pro",
      status: "active",
      provider: "yookassa",
      currentPeriodEnd: new Date(Date.now() - 1000),
    });
    expect((await entitlements(org)).id).toBe("free");
  });

  it("past_due retains access", async () => {
    const org = await newOrg();
    await applyPlanUpdate(org, {
      plan: "pro",
      status: "past_due",
      provider: "stripe",
      currentPeriodEnd: new Date(Date.now() + 24 * 3600 * 1000),
    });
    expect((await entitlements(org)).id).toBe("pro");
  });

  it("organizations do not affect each other's plans", async () => {
    const a = await newOrg("A");
    const b = await newOrg("B");
    await applyPlanUpdate(a, { plan: "pro", status: "active", provider: "stripe" });
    expect((await entitlements(a)).id).toBe("pro");
    expect((await entitlements(b)).id).toBe("free");
  });
});

d("webhook idempotency", () => {
  it("records an event once and reports duplicates", async () => {
    const org = await newOrg();
    const eventId = `${EVENT_PREFIX}-dup`;

    const first = await recordEventOnce({ provider: "stripe", eventId, eventType: "checkout.session.completed", orgId: org });
    const second = await recordEventOnce({ provider: "stripe", eventId, eventType: "checkout.session.completed", orgId: org });

    // Providers retry; the second delivery must be a no-op.
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("the same event id from DIFFERENT providers is not a duplicate", async () => {
    const org = await newOrg();
    const eventId = `${EVENT_PREFIX}-shared`;
    expect(await recordEventOnce({ provider: "stripe", eventId, eventType: "x", orgId: org })).toBe(true);
    expect(await recordEventOnce({ provider: "yookassa", eventId, eventType: "x", orgId: org })).toBe(true);
  });

  it("survives CONCURRENT deliveries of one event (exactly one wins)", async () => {
    // Providers really do deliver in parallel on retry storms.
    const org = await newOrg();
    const eventId = `${EVENT_PREFIX}-race`;
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        recordEventOnce({ provider: "stripe", eventId, eventType: "invoice.payment_succeeded", orgId: org })
      )
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("marks an event processed", async () => {
    const org = await newOrg();
    const eventId = `${EVENT_PREFIX}-proc`;
    await recordEventOnce({ provider: "stripe", eventId, eventType: "x", orgId: org });
    await markEventProcessed("stripe", eventId);
    const row = (await identityPool.query(
      "SELECT processed_at FROM payment_events WHERE provider = 'stripe' AND event_id = $1",
      [eventId]
    )) as { rows: { processed_at: Date | null }[] };
    expect(row.rows[0].processed_at).not.toBeNull();
  });
});
