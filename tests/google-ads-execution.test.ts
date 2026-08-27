// Phase E.1-for-Google: Google Ads adapter execution contract against its
// in-process simulator (google-ads-api v24 Customer surface: nested-row GAQL
// + mutateResources). No real account, no real money.
//
//   * sync: campaigns + 28-day metrics + keywords → local mirror
//   * campaign_status → write → read-back → VERIFIED
//   * bids_factor → write → read-back (±1 micro) → VERIFIED
//   * negative_keywords → write → read-back → VERIFIED
//   * delete_campaign_tree → provider remove → read-back REMOVED → mirror cleanup
//
// Isolation: scratch rows ("GA-SIM-*") are created per suite and deleted in
// afterAll; the simulator is fresh per test. All DB access runs in
// withTenant(org 1) (FORCE RLS).

import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { eq, and, inArray } from "drizzle-orm";
import { db, withTenant } from "@/db";
import { campaigns, keywords, metricsDaily, negativeKeywords } from "@/db/schema";
import { createGoogleClient } from "@/lib/adapters/google-ads/client";
import { createGoogleSimulator, type GoogleSimulator } from "@/lib/adapters/google-ads/simulator";

const ctx = { orgId: 1, userId: null, role: "admin" } as const;
const SIM_CAMPAIGN_ID = 900111;
const SIM_CRIT_ID = 770011;

let sim: GoogleSimulator;
let scratchCampId = 0;
let scratchKwId = 0;

beforeAll(async () => {
  // The adapter builds resource names from the customer id; with the simulator
  // injected the value only needs to be a well-formed 10-digit id.
  process.env.GOOGLE_ADS_CUSTOMER_ID = "1234567890";
  await withTenant(ctx, async () => {
    // Self-clean leftovers from a previously crashed run: match by externalId,
    // NOT by name (a prior sync renames the row to the sim's name, so a name
    // pattern would miss it and the stale row would shadow the fresh one in
    // sync's externalId lookup).
    const stale = await db
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(and(eq(campaigns.platform, "google"), inArray(campaigns.externalId, [String(SIM_CAMPAIGN_ID)])));
    for (const s of stale) {
      await db.delete(negativeKeywords).where(eq(negativeKeywords.campaignId, s.id));
      await db.delete(metricsDaily).where(eq(metricsDaily.campaignId, s.id));
      await db.delete(keywords).where(eq(keywords.campaignId, s.id));
      await db.delete(campaigns).where(eq(campaigns.id, s.id));
    }
    const [camp] = await db
      .insert(campaigns)
      .values({
        organizationId: 1,
        platform: "google",
        kind: "campaign",
        externalId: String(SIM_CAMPAIGN_ID),
        name: `GA-SIM scratch ${Date.now()}`,
        status: "active",
        budgetDaily: 1,
        strategy: "GA-SIM",
      })
      .returning();
    scratchCampId = camp.id;
    const [kw] = await db
      .insert(keywords)
      .values({ campaignId: camp.id, externalId: String(SIM_CRIT_ID), text: "га сим ключ", bid: 10 })
      .returning();
    scratchKwId = kw.id;
  });
});

afterAll(async () => {
  await withTenant(ctx, async () => {
    await db.delete(negativeKeywords).where(eq(negativeKeywords.campaignId, scratchCampId));
    await db.delete(metricsDaily).where(eq(metricsDaily.campaignId, scratchCampId));
    await db.delete(keywords).where(eq(keywords.campaignId, scratchCampId));
    // By id, not name: a sync mid-suite renames the scratch row.
    await db.delete(campaigns).where(eq(campaigns.id, scratchCampId));
  });
});

beforeEach(() => {
  sim = createGoogleSimulator({
    campaigns: [
      {
        id: SIM_CAMPAIGN_ID,
        name: "GA Sim Campaign",
        status: "ENABLED",
        budgetMicros: 5_000_000_000, // 5000 ₽/day
      },
    ],
    criteria: [{ id: SIM_CRIT_ID, campaignId: SIM_CAMPAIGN_ID, text: "га сим ключ", bidMicros: 15_000_000 }],
    negatives: [],
  });
});

const client = () => createGoogleClient({ makeCustomer: async () => sim.client });

describe("google-ads adapter: sync (mirror)", () => {
  it("pulls campaigns, 28-day metrics and keywords into the local mirror", async () => {
    await withTenant(ctx, async () => {
      await client().sync();
      const camp = (await db.select().from(campaigns).where(eq(campaigns.id, scratchCampId)))[0];
      expect(camp?.name).toBe("GA Sim Campaign");
      expect(camp?.status).toBe("active");
      expect(camp?.budgetDaily).toBeCloseTo(5000, 0);

      const kw = (await db.select().from(keywords).where(eq(keywords.id, scratchKwId)))[0];
      expect(kw?.text).toBe("га сим ключ");
      expect(kw?.bid).toBeCloseTo(15, 0);

      const { metricsDaily } = await import("@/db/schema");
      const metrics = await db
        .select()
        .from(metricsDaily)
        .where(eq(metricsDaily.campaignId, scratchCampId));
      expect(metrics.length).toBe(28);
      expect(metrics.every((m) => m.impressions > 0 && m.spend > 0)).toBe(true);
    });
  });
});

describe("google-ads adapter: campaign_status (E4 read-back)", () => {
  it("pause → VERIFIED, provider state PAUSED", async () => {
    const r = await withTenant(ctx, () =>
      client().execute({ kind: "campaign_status", campaignIds: [scratchCampId], status: "paused" })
    );
    expect(r.ok).toBe(true);
    expect(r.verified).toBe(true);
    expect(sim.state.campaigns[0].status).toBe("PAUSED");
  });

  it("resume after pause → VERIFIED, provider state ENABLED", async () => {
    sim.state.campaigns[0].status = "PAUSED";
    const r = await withTenant(ctx, () =>
      client().execute({ kind: "campaign_status", campaignIds: [scratchCampId], status: "active" })
    );
    expect(r.verified).toBe(true);
    expect(sim.state.campaigns[0].status).toBe("ENABLED");
  });
});

describe("google-ads adapter: bids_factor (E4 read-back)", () => {
  it("×1.2 → provider bids updated and read-back matches (±1 micro)", async () => {
    // Deterministic baseline (the sync test above renames/reprices the scratch
    // row — reset the bid before asserting a factor against a known value).
    await withTenant(ctx, async () => {
      await db.update(keywords).set({ bid: 10 }).where(eq(keywords.id, scratchKwId));
      sim.state.criteria[0].bidMicros = 10_000_000;
    });
    const r = await withTenant(ctx, () =>
      client().execute({ kind: "bids_factor", keywordIds: [scratchKwId], factor: 1.2 })
    );
    expect(r.ok).toBe(true);
    expect(r.verified).toBe(true);
    // 10 ₽ × 1.2 = 12 ₽ = 12_000_000 micros
    expect(sim.state.criteria[0].bidMicros).toBe(12_000_000);
  });
});

describe("google-ads adapter: negative_keywords (E4 read-back)", () => {
  it("adds campaign-level negatives and verifies each word via read-back", async () => {
    const r = await withTenant(ctx, () =>
      client().execute({ kind: "negative_keywords", campaignId: scratchCampId, words: ["га-минус-1", "га-минус-2"] })
    );
    expect(r.ok).toBe(true);
    expect(r.verified).toBe(true);
    const texts = sim.state.negatives.map((n) => n.text);
    expect(texts).toContain("га-минус-1");
    expect(texts).toContain("га-минус-2");
  });
});

describe("google-ads adapter: delete_campaign_tree (compensation)", () => {
  it("removes the campaign at the provider (read-back REMOVED); mirror cleanup is the agent flow's job", async () => {
    const r = await withTenant(ctx, () => client().execute({ kind: "delete_campaign_tree", campaignId: scratchCampId }));
    expect(r.ok).toBe(true);
    expect(r.verified).toBe(true);
    expect(sim.state.campaigns[0].status).toBe("REMOVED");
    // Adapter does NOT touch the local mirror (run.ts applyLocal does, incl. metrics).
    const camp = (await withTenant(ctx, () => db.select().from(campaigns).where(eq(campaigns.id, scratchCampId))))[0];
    expect(camp).toBeDefined();
  });
});
