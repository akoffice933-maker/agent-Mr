// Regression (E.2): intent params are camelCase (LLM resolver and rule parser
// both emit camelCase) — createCampaign must carry the responsive-ad surface
// (UTM, price, callouts, images, titles) into the pending params and the
// preview. The original bug: tools.ts read snake_case (tracking_params), so
// values merged by the rule parser were silently dropped.
import { describe, expect, it } from "vitest";
import { createCampaign } from "@/lib/agent/tools";
import type { ParsedIntent } from "@/lib/agent/router";

const intent = (params: Record<string, unknown>): ParsedIntent => ({
  tool: "create_campaign",
  platforms: ["yandex"],
  period: { days: 7, from: "2026-08-20", to: "2026-08-26" },
  params,
});

describe("createCampaign — E.2 responsive ad surface", () => {
  it("carries camelCase intent params (UTM/price/callouts/images/titles) into pending + preview", async () => {
    const out = await createCampaign(
      intent({
        name: "agent-Mr",
        budget: 3333,
        url: "https://agent-mr.example/",
        title: "H1",
        text: "Текст объявления",
        titles: ["H1", "H2", "H3"],
        callouts: ["Уточ 1", "Уточ 2"],
        priceRubles: 99000,
        priceOldRubles: 149000,
        priceQualifier: "from",
        trackingParams: "utm_source=agentmr",
        images: [{ url: "https://cdn.example.com/a.jpg", name: "a" }],
      })
    );
    const p = out.pending?.params ?? {};
    expect(p.trackingParams).toBe("utm_source=agentmr");
    expect(p.priceRubles).toBe(99000);
    expect(p.priceOldRubles).toBe(149000);
    expect(p.priceQualifier).toBe("from");
    expect(p.callouts).toEqual(["Уточ 1", "Уточ 2"]);
    expect(p.images).toEqual([{ url: "https://cdn.example.com/a.jpg", name: "a" }]);
    expect(p.titles).toEqual(["H1", "H2", "H3"]);

    const changes = (out.result as { changes: { entity: string; name?: string }[] }).changes;
    expect(changes.some((c) => c.entity === "UTM-параметры")).toBe(true);
    expect(changes.some((c) => c.entity === "Цена" && /от 99[\s\u00a0]000/.test(c.name ?? ""))).toBe(true);
    expect(changes.some((c) => c.entity === "Уточнения")).toBe(true);
    expect(changes.some((c) => c.entity === "Изображения")).toBe(true);
    const adRow = changes.find((c) => c.entity === "Объявление");
    expect(adRow && /3 заголовка/.test(JSON.stringify(adRow))).toBe(true);
  });

  it("accepts snake_case (raw LLM arg names) as a fallback", async () => {
    const out = await createCampaign(
      intent({
        name: "X",
        budget: 100,
        title: "T",
        text: "D",
        url: "https://e.com",
        tracking_params: "utm_x=1",
        price_rubles: 500,
        price_qualifier: "up_to",
      })
    );
    const p = out.pending?.params ?? {};
    expect(p.trackingParams).toBe("utm_x=1");
    expect(p.priceRubles).toBe(500);
    expect(p.priceQualifier).toBe("up_to");
  });

  it("a bare create stays minimal (no guessed E.2 fields)", async () => {
    const out = await createCampaign(intent({ name: "X", budget: 200 }));
    const p = out.pending?.params ?? {};
    expect(p.trackingParams).toBeUndefined();
    expect(p.priceRubles).toBeUndefined();
    expect(p.titles).toBeUndefined();
    expect(p.images).toBeUndefined();
  });
});
