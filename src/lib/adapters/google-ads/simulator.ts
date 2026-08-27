// In-process simulator of the google-ads-api v24 Customer surface — the
// contract subset used by the adapter (E.1 for Google): the GAQL queries the
// adapter issues + the mutateResources operations it sends. Mirrors the real
// response shapes (nested rows: res.results[].row.campaign.id, etc.) so the
// adapter code is exercised exactly as in production.
//
// Like the Yandex simulator: deterministic, no network, same {query,
// mutateResources} surface — the adapter's clientFactory seam swaps it in.

import type { GoogleAdsCustomerLike } from "./client";

export interface SimCampaign {
  id: number;
  name: string;
  status: "ENABLED" | "PAUSED" | "REMOVED";
  budgetMicros: number;
}
export interface SimCriterion {
  id: number;
  campaignId: number;
  adGroup: string; // customers/{cid}/adGroups/{adgId}
  text: string;
  bidMicros: number;
}
export interface SimNegative {
  campaignId: number;
  text: string;
  matchType: string;
}
export interface SimState {
  campaigns: SimCampaign[];
  criteria: SimCriterion[];
  negatives: SimNegative[];
}
/** Initial/test input: adGroup is optional (defaults to a deterministic name). */
export type SimCriterionInput = Omit<SimCriterion, "adGroup"> & { adGroup?: string };

export interface GoogleSimulator {
  state: SimState;
  /** every call the adapter made (for assertions) */
  calls: { method: "query" | "mutate"; detail: string }[];
  client: GoogleAdsCustomerLike;
  /** test helpers */
  addCampaign(c: Omit<SimCampaign, "status"> & { status?: SimCampaign["status"] }): SimCampaign;
  addCriterion(c: SimCriterionInput): SimCriterion;
}

const CID = "1234567890";

// CampaignStatus protobuf enum (the real client sends numbers; REST responses
// carry names — the simulator stores canonical names, like the REST API).
const STATUS_BY_NUM: Record<number, SimCampaign["status"]> = { 2: "ENABLED", 3: "PAUSED", 4: "REMOVED" };
export function normCampaignStatus(v: unknown): SimCampaign["status"] {
  if (typeof v === "number") return STATUS_BY_NUM[v] ?? "PAUSED";
  const s = String(v ?? "").toUpperCase();
  return s === "ENABLED" || s === "REMOVED" ? (s as SimCampaign["status"]) : "PAUSED";
}

export function createGoogleSimulator(initial?: { campaigns?: SimState["campaigns"]; criteria?: SimCriterionInput[]; negatives?: SimState["negatives"] }): GoogleSimulator {
  const state: SimState = {
    campaigns: initial?.campaigns ?? [],
    criteria: (initial?.criteria ?? []).map((c) => ({ ...c, adGroup: c.adGroup ?? `customers/${CID}/adGroups/${c.campaignId}0` })),
    negatives: initial?.negatives ?? [],
  };
  const calls: { method: "query" | "mutate"; detail: string }[] = [];

  const rowsOf = (rows: Record<string, unknown>[]) => ({ results: rows.map((row) => ({ row })) });

  function query(gaql: string): Promise<unknown> {
    calls.push({ method: "query", detail: gaql.replace(/\s+/g, " ").trim() });
    const q = gaql.replace(/\s+/g, " ");
    const campaignRows = (ids?: number[], includeRemoved = false) =>
      state.campaigns
        .filter((c) => (includeRemoved ? true : c.status !== "REMOVED"))
        .filter((c) => !ids || ids.includes(c.id))
        .map((c) => ({ campaign: { id: c.id, name: c.name, status: c.status }, campaign_budget: { amount_micros: c.budgetMicros } }));

    // 1. Campaign sync
    if (/FROM campaign WHERE campaign\.status != "REMOVED"/.test(q)) {
      return Promise.resolve(rowsOf(campaignRows()));
    }
    // 2. 28-day metrics
    if (/FROM campaign WHERE segments\.date DURING LAST_28_DAYS/.test(q)) {
      const out: Record<string, unknown>[] = [];
      const today = new Date();
      for (const c of state.campaigns) {
        if (c.status === "REMOVED") continue;
        for (let d = 27; d >= 0; d--) {
          const date = new Date(today.getTime() - d * 86400000).toISOString().slice(0, 10);
          out.push({
            campaign: { id: c.id },
            segments: { date },
            metrics: {
              impressions: 120 + (c.id % 40),
              clicks: 12 + (c.id % 6),
              cost_micros: 3_000_000 + c.id * 100_000,
              all_conversions: 1 + (c.id % 3),
            },
          });
        }
      }
      return Promise.resolve(rowsOf(out));
    }
    // 3. Keywords (ad_group_criterion KEYWORD)
    if (/FROM ad_group_criterion WHERE ad_group_criterion\.type = "KEYWORD"/.test(q)) {
      const out = state.criteria
        .filter((k) => {
          const camp = state.campaigns.find((c) => c.id === k.campaignId);
          return camp && camp.status !== "REMOVED";
        })
        .map((k) => ({
          campaign: { id: k.campaignId },
          ad_group_criterion: { id: k.id, keyword: { text: k.text }, cpc_bid_micros: k.bidMicros },
        }));
      return Promise.resolve(rowsOf(out));
    }
    // 4. Status by IN-list
    const inList = q.match(/FROM campaign WHERE campaign\.id IN \(([^)]*)\)/);
    if (inList) {
      const ids = inList[1].split(",").map((s) => Number(s.trim())).filter(Number.isFinite);
      return Promise.resolve(rowsOf(campaignRows(ids, true)));
    }
    // 5. Criterion by IN-list (ad-group resolution AND bid read-back)
    const critIn = q.match(/FROM ad_group_criterion WHERE ad_group_criterion\.id IN \(([^)]*)\)/);
    if (critIn) {
      const ids = critIn[1].split(",").map((s) => Number(s.trim())).filter(Number.isFinite);
      const out = state.criteria
        .filter((k) => ids.includes(k.id))
        .map((k) => ({ ad_group_criterion: { id: k.id, ad_group: k.adGroup, cpc_bid_micros: k.bidMicros } }));
      return Promise.resolve(rowsOf(out));
    }
    // 6. Single campaign by id
    const one = q.match(/FROM campaign WHERE campaign\.id = (\d+)/);
    if (one) {
      const id = Number(one[1]);
      const c = state.campaigns.find((x) => x.id === id);
      return Promise.resolve(rowsOf(c ? [{ campaign: { id: c.id, status: c.status } }] : []));
    }
    // 7. Negative criteria read-back: ... WHERE campaign_criterion.campaign =
    //    "customers/{cid}/campaigns/{id}" AND ... text IN ("a","b")
    if (/FROM campaign_criterion WHERE/.test(q)) {
      const inList = q.match(/IN \(([^)]*)\)/);
      const texts = inList ? [...inList[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]) : [];
      const out = state.negatives
        .filter((n) => !texts.length || texts.includes(n.text))
        .map((n) => ({ campaign: { id: n.campaignId }, campaign_criterion: { negative: { keyword: { text: n.text } } } }));
      return Promise.resolve(rowsOf(out));
    }
    throw new Error(`Simulator: unsupported GAQL: ${q}`);
  }

  function parseCampaignResName(resource_name: string): number {
    const m = String(resource_name).match(/campaigns\/(\d+)/);
    if (!m) throw new Error(`Simulator: bad campaign resource name: ${resource_name}`);
    return Number(m[1]);
  }

  function mutateResources(ops: unknown[]): Promise<unknown> {
    const list = ops as { entity?: string; operation?: string; resource?: Record<string, any> }[];
    calls.push({ method: "mutate", detail: list.map((o) => `${o.entity}:${o.operation}`).join(",") });
    const results: unknown[] = [];
    list.forEach((o, i) => {
      const r = o.resource ?? {};
      if (o.entity === "campaign" && (o.operation === "update" || o.operation === "remove")) {
        const id = parseCampaignResName(r.resource_name);
        const c = state.campaigns.find((x) => x.id === id);
        if (!c) throw new Error(`Simulator: campaign ${id} not found`);
        c.status = o.operation === "remove" ? "REMOVED" : normCampaignStatus(r.status);
      } else if (o.entity === "ad_group_criterion" && o.operation === "update") {
        const m = String(r.resource_name).match(/adGroupCriteria\/(\d+)~(\d+)/);
        if (!m) throw new Error(`Simulator: bad criterion resource name: ${r.resource_name}`);
        const k = state.criteria.find((x) => x.id === Number(m[2]));
        if (!k) throw new Error(`Simulator: criterion ${m[2]} not found`);
        if (typeof r.cpc_bid_micros === "number") k.bidMicros = r.cpc_bid_micros;
      } else if (o.entity === "campaign_criterion" && o.operation === "create") {
        // Real v24 shape: { campaign, negative: true, keyword: { text, match_type } }.
        const cid = Number(String(r.campaign).match(/customers\/(\d+)/)?.[1]);
        const kw = r.keyword ?? r.negative?.keyword ?? {};
        const text = String(kw.text ?? "");
        if (!text) throw new Error("Simulator: negative criterion without text");
        if (!state.negatives.some((n) => n.campaignId === cid && n.text === text)) {
          state.negatives.push({ campaignId: cid, text, matchType: String(kw.match_type ?? "BROAD") });
        }
      } else {
        throw new Error(`Simulator: unsupported mutation ${o.entity}:${o.operation}`);
      }
      results.push({ index: i });
    });
    return Promise.resolve({ results });
  }

  const client: GoogleAdsCustomerLike = {
    query: (gaql) => query(gaql),
    mutateResources: (ops) => mutateResources(ops),
  };

  return {
    state,
    calls,
    client,
    addCampaign(c) {
      const campaign: SimCampaign = { status: "ENABLED", ...c };
      state.campaigns.push(campaign);
      return campaign;
    },
    addCriterion(c) {
      const criterion: SimCriterion = { adGroup: `customers/${CID}/adGroups/${c.campaignId}0`, ...c };
      state.criteria.push(criterion);
      return criterion;
    },
  };
}
