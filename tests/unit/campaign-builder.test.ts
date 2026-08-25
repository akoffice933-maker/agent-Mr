// Phase E.1 — Yandex campaign builder: idempotency (adoption), partial-failure
// (saga state), deterministic strategy mapping, money conversion, naming.
//
// Pure provider-contract tests against the in-process simulator — no DB, no
// network. The DB-side (mirror row, pending_actions.readback) is covered by
// the execution-pipeline integration test.

import { describe, it, expect } from "vitest";
import { createSimulator } from "@/lib/adapters/yandex-direct/simulator";
import { DirectApi } from "@/lib/adapters/yandex-direct/api";
import { buildCampaignTree, type BuildParams } from "@/lib/adapters/yandex-direct/campaign-builder";
import { correlationName, parseCorrelation } from "@/lib/adapters/yandex-direct/naming";
import { resolveStrategy, STRATEGIES, buildBiddingStrategy } from "@/lib/adapters/yandex-direct/strategy";
import { rublesToMicros, microsToRubles, dailyRublesToWeeklyMicros } from "@/lib/money";

function apiFor(sim: ReturnType<typeof createSimulator>) {
  return new DirectApi(async () => "sim-token", "https://sim.invalid/v5", sim.transport);
}

const baseParams: Omit<BuildParams, "correlationName"> = {
  budgetDaily: 1000,
  strategy: "maximum_clicks",
  adGroupName: "Группа 1",
  title: "Тестовое объявление",
  text: "Текст объявления",
  url: "https://example.com",
  keywords: ["кухни", "мебель на заказ"],
  negativeKeywords: ["бывшие"],
  regionIds: [0],
};

describe("campaign-builder: idempotent creation (E.1 P0-1)", () => {
  it("builds a full tree once and ADOPTS it on retry — no duplicates", async () => {
    const sim = createSimulator();
    const api = apiFor(sim);
    const corr = correlationName(1, 42, "Кухни под заказ");

    const first = await buildCampaignTree(api, { ...baseParams, correlationName: corr });
    expect(first.ok).toBe(true);
    expect(first.verified).toBe(true);
    expect(first.state.campaign?.adopted).toBe(false);
    expect(first.state.createdResources.map((r) => r.kind).sort()).toEqual(["ad", "adgroup", "campaign", "keyword", "keyword"]);

    // Same action retried (e.g. after a timeout): must adopt, not duplicate.
    const retry = await buildCampaignTree(api, { ...baseParams, correlationName: corr });
    expect(retry.ok).toBe(true);
    expect(retry.verified).toBe(true);
    expect(retry.state.campaign?.adopted).toBe(true);
    expect(retry.state.adGroup?.adopted).toBe(true);
    expect(retry.state.ads.every((a) => a.adopted)).toBe(true);
    expect(retry.state.keywords.every((k) => k.adopted)).toBe(true);

    // Exactly ONE of each at the provider.
    expect(sim.state.campaigns).toHaveLength(1);
    expect(sim.state.adGroups).toHaveLength(1);
    expect(sim.state.ads).toHaveLength(1);
    expect(sim.state.keywords).toHaveLength(2);
    expect(retry.detail).toContain("идемпотентный повтор");
  });

  it("retried build with MORE keywords adds only the missing ones", async () => {
    const sim = createSimulator();
    const api = apiFor(sim);
    const corr = correlationName(1, 7, "Настолки");
    const p = { ...baseParams, correlationName: corr, keywords: ["настольные игры"] };

    await buildCampaignTree(api, p);
    const more = await buildCampaignTree(api, { ...p, keywords: ["настольные игры", "квесты"] });
    expect(more.ok).toBe(true);
    expect(sim.state.keywords).toHaveLength(2);
    expect(more.state.keywords.filter((k) => k.adopted)).toHaveLength(1);
    expect(more.state.keywords.filter((k) => !k.adopted)).toHaveLength(1);
  });
});

describe("campaign-builder: partial failure / saga state (E.1 P0-2)", () => {
  it("failure at keywords step records createdResources + failedAt; retry resumes", async () => {
    const sim = createSimulator();
    const api = apiFor(sim);
    const corr = correlationName(1, 99, "Частичный прогон");
    const p = { ...baseParams, correlationName: corr };

    // Sustained outage at the keywords service (500s through all 3 retries):
    // campaign+adgroup+ad get created, keywords does not.
    sim.failWrites("keywords", Infinity, "Simulated sustained outage");
    const failed = await buildCampaignTree(api, p);
    expect(failed.ok).toBe(false);
    expect(failed.verified).toBe(false);
    expect(failed.state.failedAt).toBe("keywords");
    expect(failed.state.campaign?.adopted).toBe(false);
    const kinds = failed.state.createdResources.map((r) => r.kind).sort();
    expect(kinds).toEqual(["ad", "adgroup", "campaign"]);
    // nothing was lost: the provider holds exactly the 3 resources
    expect(sim.state.campaigns).toHaveLength(1);
    expect(sim.state.adGroups).toHaveLength(1);
    expect(sim.state.ads).toHaveLength(1);
    expect(sim.state.keywords).toHaveLength(0);

    // Outage cleared. Resume: same correlation name → adopts the 3 resources,
    // adds keywords.
    sim.clearWriteFailures();
    const resumed = await buildCampaignTree(api, p);
    expect(resumed.ok).toBe(true);
    expect(resumed.verified).toBe(true);
    expect(resumed.state.campaign?.adopted).toBe(true);
    expect(resumed.state.keywords.every((k) => !k.adopted)).toBe(true);
    expect(sim.state.campaigns).toHaveLength(1);
    expect(sim.state.keywords).toHaveLength(2);
    expect(resumed.readback).toBeTruthy();
  });

  it("failure at adgroup step: only the campaign exists", async () => {
    const sim = createSimulator();
    const api = apiFor(sim);
    const corr = correlationName(2, 5, "Сбой на группе");
    sim.failWrites("adgroups", Infinity, "boom");
    const failed = await buildCampaignTree(api, { ...baseParams, correlationName: corr });
    expect(failed.ok).toBe(false);
    expect(failed.state.failedAt).toBe("adgroup");
    expect(failed.state.createdResources.map((r) => r.kind)).toEqual(["campaign"]);
    expect(sim.state.campaigns).toHaveLength(1);
    expect(sim.state.adGroups).toHaveLength(0);
  });
});

describe("campaign-builder: deterministic strategy mapping (E.1 P0-6)", () => {
  it("maximum_conversions produces WB_MAXIMUM_CONVERSIONS, not the hardcoded WB_MAXIMUM_CLICKS", async () => {
    const sim = createSimulator();
    const api = apiFor(sim);
    const corr = correlationName(1, 11, "Конверсии");
    const r = await buildCampaignTree(api, { ...baseParams, correlationName: corr, strategy: "maximum_conversions", keywords: [] });
    expect(r.ok).toBe(true);
    const addReq = sim.lastRequests.find((q) => q.service === "campaigns" && q.method === "add");
    const bs = (addReq?.params as any)?.Campaigns?.[0]?.TextCampaign?.BiddingStrategy?.Search;
    expect(bs?.BiddingStrategyType).toBe("WB_MAXIMUM_CONVERSIONS");
    expect(bs?.WbMaximumConversions?.WeeklySpendLimit).toBe(dailyRublesToWeeklyMicros(1000));
  });

  it("resolveStrategy is total and never escalates on garbage", () => {
    expect(resolveStrategy("maximum_clicks")).toBe("maximum_clicks");
    expect(resolveStrategy("WB_MAXIMUM_CLICKS")).toBe("maximum_clicks");
    expect(resolveStrategy("максимум кликов (автостратегия)")).toBe("maximum_clicks");
    expect(resolveStrategy("maximum_conversions")).toBe("maximum_conversions");
    expect(resolveStrategy("target_cpa")).toBe("target_cpa");
    expect(resolveStrategy("")).toBe("maximum_clicks");
    expect(resolveStrategy(null)).toBe("maximum_clicks");
    expect(resolveStrategy("garbage_value")).toBe("maximum_clicks");
    expect(STRATEGIES.maximum_conversions.label).toMatch(/конверси/i);
  });

  it("buildBiddingStrategy maps each strategy to its Direct type", () => {
    const weekly = dailyRublesToWeeklyMicros(500);
    expect((buildBiddingStrategy("maximum_clicks", weekly) as any).Search.BiddingStrategyType).toBe("WB_MAXIMUM_CLICKS");
    expect((buildBiddingStrategy("maximum_conversions", weekly) as any).Search.BiddingStrategyType).toBe("WB_MAXIMUM_CONVERSIONS");
    expect((buildBiddingStrategy("manual_cpc", weekly, 25) as any).Search.ManualCpc.MaxCpc).toBe(rublesToMicros(25));
    expect((buildBiddingStrategy("target_cpa", weekly, undefined, 300) as any).Search.TargetCpa.DefaultMaxCpa).toBe(rublesToMicros(300));
  });
});

describe("money module (E.1 P1-11)", () => {
  it("rubles → integer micros (no float drift)", () => {
    expect(rublesToMicros(1)).toBe(1_000_000);
    expect(rublesToMicros(123.456)).toBe(123_456_000);
    expect(rublesToMicros(0.1 + 0.2)).toBe(300_000);
    expect(dailyRublesToWeeklyMicros(1000)).toBe(7_000_000_000);
    expect(() => rublesToMicros(-1)).toThrow();
    expect(() => rublesToMicros(Infinity)).toThrow();
    expect(microsToRubles(123_456_000)).toBe(123.456);
    expect(() => microsToRubles(1.5)).toThrow();
  });
});

describe("correlation naming (E.1 P0-1)", () => {
  it("round-trips org/action and survives 255-char names", () => {
    const name = correlationName(3, 42, "Кухни под заказ Москва");
    expect(name).toContain("agentmr:3:42");
    expect(parseCorrelation(name)).toEqual({ orgId: 3, actionId: 42 });
    const long = correlationName(1, 9, "Очень ".repeat(40) + "название");
    expect(long.length).toBeLessThanOrEqual(255);
    expect(parseCorrelation(long)).toEqual({ orgId: 1, actionId: 9 });
    expect(parseCorrelation("обычная кампания без тега")).toBeNull();
  });
});
