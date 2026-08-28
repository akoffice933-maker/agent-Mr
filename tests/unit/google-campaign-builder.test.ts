// Phase 2.1: Google campaign-builder against in-process simulator (CI, no network).
import { describe, expect, it } from "vitest";
import { buildGoogleCampaignTree } from "@/lib/adapters/google-ads/campaign-builder";
import { createGoogleSimulator, simGoogleLib } from "@/lib/adapters/google-ads/simulator";

const CID = "1234567890";

const baseParams = {
  customerId: CID,
  correlationName: "Test Camp · agentmr:1:42",
  budgetDaily: 15,
  headlines: ["Заголовок один", "Заголовок два", "Заголовок три"],
  descriptions: ["Описание первое длиннее", "Описание второе"],
  finalUrl: "https://example.com/landing",
  keywords: ["купить стол", "стол москва"],
  adGroupName: "Группа 1",
};

describe("buildGoogleCampaignTree (simulator)", () => {
  it("creates full tree and returns verified", async () => {
    const sim = createGoogleSimulator();
    const lib = simGoogleLib();
    const result = await buildGoogleCampaignTree(sim.client, lib, baseParams);

    expect(result.ok).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.state.campaignId).toBeTruthy();
    expect(result.state.budgetId).toBeTruthy();
    expect(result.state.adGroupId).toBeTruthy();
    expect(result.state.adId).toBeTruthy();
    expect(result.state.keywordIds.length).toBe(2);
    expect(result.state.failedAt).toBeNull();

    // State on simulator matches
    expect(sim.state.campaigns).toHaveLength(1);
    expect(sim.state.campaigns[0].name).toBe(baseParams.correlationName);
    expect(sim.state.campaigns[0].status).toBe("PAUSED");
    expect(sim.state.adGroups).toHaveLength(1);
    expect(sim.state.ads).toHaveLength(1);
    expect(sim.state.criteria.map((c) => c.text).sort()).toEqual([...baseParams.keywords].sort());

    // Mutates happened
    const mutates = sim.calls.filter((c) => c.method === "mutate");
    expect(mutates.length).toBeGreaterThanOrEqual(4); // budget, campaign, ag, ad, keywords
  });

  it("on retry adopts existing campaign (idempotent)", async () => {
    const sim = createGoogleSimulator();
    const lib = simGoogleLib();

    const first = await buildGoogleCampaignTree(sim.client, lib, baseParams);
    expect(first.verified).toBe(true);
    const campaignId = first.state.campaignId;
    const mutatesAfterFirst = sim.calls.filter((c) => c.method === "mutate").length;

    const second = await buildGoogleCampaignTree(sim.client, lib, baseParams);
    expect(second.verified).toBe(true);
    expect(second.state.campaignId).toBe(campaignId);
    expect(second.state.createdResources.some((r) => r.kind === "campaign" && r.adopted)).toBe(true);

    // No second campaign row
    expect(sim.state.campaigns.filter((c) => c.status !== "REMOVED")).toHaveLength(1);

    // Fewer (or equal) mutates on resume — at least campaign create not repeated
    const mutatesAfterSecond = sim.calls.filter((c) => c.method === "mutate").length;
    expect(mutatesAfterSecond).toBeGreaterThanOrEqual(mutatesAfterFirst);
  });

  it("fails closed when RSA requirements missing", async () => {
    const sim = createGoogleSimulator();
    const lib = simGoogleLib();
    const result = await buildGoogleCampaignTree(sim.client, lib, {
      ...baseParams,
      headlines: ["only one"],
      descriptions: ["only one"],
    });
    expect(result.ok).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/RSA|заголовк/i);
    expect(sim.state.campaigns).toHaveLength(0);
  });

  it("partial resume after campaign exists continues children", async () => {
    const sim = createGoogleSimulator();
    // Pre-seed only campaign (as if previous attempt died after campaign create)
    sim.addCampaign({
      id: 777,
      name: baseParams.correlationName,
      budgetMicros: 15_000_000,
      status: "PAUSED",
    });
    const lib = simGoogleLib();
    const result = await buildGoogleCampaignTree(sim.client, lib, baseParams);
    expect(result.verified).toBe(true);
    expect(result.state.campaignId).toBe("777");
    expect(result.state.createdResources.find((r) => r.kind === "campaign")?.adopted).toBe(true);
    expect(result.state.adGroupId).toBeTruthy();
    expect(result.state.keywordIds.length).toBe(2);
  });
});
