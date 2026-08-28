// In-process simulator of the google-ads-api v24 Customer surface.
// Covers adapter execute ops (status/bids/negatives/delete) AND the
// Phase 2.1 campaign-builder tree (budget → campaign → adgroup → RSA → keywords).
// Deterministic, no network — swap via createGoogleClient({ makeCustomer }).

import type { GoogleAdsCustomerLike } from "./client";

export interface SimCampaign {
  id: number;
  name: string;
  status: "ENABLED" | "PAUSED" | "REMOVED";
  budgetId: number;
  budgetMicros: number;
}
export interface SimBudget {
  id: number;
  name: string;
  amountMicros: number;
}
export interface SimAdGroup {
  id: number;
  campaignId: number;
  name: string;
  status: string;
  cpcBidMicros: number;
}
export interface SimAd {
  id: number;
  adGroupId: number;
  headlines: string[];
  descriptions: string[];
  finalUrls: string[];
}
export interface SimCriterion {
  id: number;
  campaignId: number;
  adGroupId: number;
  adGroup: string; // resource name
  text: string;
  bidMicros: number;
}
export interface SimNegative {
  campaignId: number;
  text: string;
  matchType: string;
}
export interface SimState {
  budgets: SimBudget[];
  campaigns: SimCampaign[];
  adGroups: SimAdGroup[];
  ads: SimAd[];
  criteria: SimCriterion[];
  negatives: SimNegative[];
  nextId: number;
}

export type SimCriterionInput = {
  id: number;
  campaignId: number;
  text: string;
  bidMicros: number;
  adGroupId?: number;
  adGroup?: string;
};

export interface GoogleSimulator {
  state: SimState;
  calls: { method: "query" | "mutate"; detail: string }[];
  client: GoogleAdsCustomerLike;
  addCampaign(c: {
    id: number;
    name: string;
    budgetMicros: number;
    status?: SimCampaign["status"];
    budgetId?: number;
  }): SimCampaign;
  addCriterion(c: SimCriterionInput): SimCriterion;
}

const CID = "1234567890";

const STATUS_BY_NUM: Record<number, SimCampaign["status"]> = {
  2: "ENABLED",
  3: "PAUSED",
  4: "REMOVED",
};

export function normCampaignStatus(v: unknown): SimCampaign["status"] {
  if (typeof v === "number") return STATUS_BY_NUM[v] ?? "PAUSED";
  const s = String(v ?? "").toUpperCase();
  return s === "ENABLED" || s === "REMOVED" ? (s as SimCampaign["status"]) : "PAUSED";
}

function rowsOf(rows: Record<string, unknown>[]) {
  return { results: rows.map((row) => ({ row })) };
}

function idFromRn(rn: string): number {
  const tail = rn.split("/").pop() ?? rn;
  const part = tail.includes("~") ? tail.split("~").pop()! : tail;
  return Number(part);
}

export function createGoogleSimulator(initial?: {
  campaigns?: (Omit<SimCampaign, "budgetId"> & { budgetId?: number })[];
  criteria?: SimCriterionInput[];
  negatives?: SimState["negatives"];
}): GoogleSimulator {
  const state: SimState = {
    budgets: [],
    campaigns: [],
    adGroups: [],
    ads: [],
    criteria: [],
    negatives: initial?.negatives ?? [],
    nextId: 10_000,
  };

  for (const c of initial?.campaigns ?? []) {
    const budgetId = c.budgetId ?? state.nextId++;
    state.budgets.push({ id: budgetId, name: `Budget ${c.id}`, amountMicros: c.budgetMicros });
    state.campaigns.push({
      id: c.id,
      name: c.name,
      status: c.status ?? "ENABLED",
      budgetId,
      budgetMicros: c.budgetMicros,
    });
  }
  for (const k of initial?.criteria ?? []) {
    const adGroupId = k.adGroupId ?? k.campaignId * 10;
    state.criteria.push({
      id: k.id,
      campaignId: k.campaignId,
      adGroupId,
      adGroup: k.adGroup ?? `customers/${CID}/adGroups/${adGroupId}`,
      text: k.text,
      bidMicros: k.bidMicros,
    });
  }

  const calls: { method: "query" | "mutate"; detail: string }[] = [];
  const alloc = () => state.nextId++;

  function query(gaql: string): Promise<unknown> {
    calls.push({ method: "query", detail: gaql.replace(/\s+/g, " ").trim() });
    const q = gaql.replace(/\s+/g, " ");

    const campaignRows = (ids?: number[], includeRemoved = false) =>
      state.campaigns
        .filter((c) => (includeRemoved ? true : c.status !== "REMOVED"))
        .filter((c) => !ids || ids.includes(c.id))
        .map((c) => ({
          campaign: { id: c.id, name: c.name, status: c.status },
          campaign_budget: { id: c.budgetId, amount_micros: c.budgetMicros },
        }));

    // Sync: all non-removed campaigns
    if (/FROM campaign WHERE campaign\.status != "REMOVED"/.test(q)) {
      return Promise.resolve(rowsOf(campaignRows()));
    }
    // Metrics
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
    // Keywords by type KEYWORD (sync)
    if (/FROM ad_group_criterion WHERE ad_group_criterion\.type = "KEYWORD"/.test(q) && !/ad_group\.id/.test(q)) {
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
    // Campaign by name (builder discovery)
    const byName = q.match(/FROM campaign WHERE campaign\.name = "([^"]*)"/);
    if (byName) {
      const name = byName[1].replace(/\\"/g, '"');
      const c = state.campaigns.find((x) => x.name === name && x.status !== "REMOVED");
      return Promise.resolve(
        rowsOf(
          c
            ? [
                {
                  campaign: { id: c.id, name: c.name, status: c.status },
                  campaign_budget: { id: c.budgetId, amount_micros: c.budgetMicros },
                },
              ]
            : []
        )
      );
    }
    // Campaign by id IN (...)
    const inList = q.match(/FROM campaign WHERE campaign\.id IN \(([^)]*)\)/);
    if (inList) {
      const ids = inList[1]
        .split(",")
        .map((s) => Number(s.trim()))
        .filter(Number.isFinite);
      return Promise.resolve(rowsOf(campaignRows(ids, true)));
    }
    // Single campaign by id (with optional budget fields)
    const one = q.match(/FROM campaign WHERE campaign\.id = (\d+)/);
    if (one) {
      const id = Number(one[1]);
      const c = state.campaigns.find((x) => x.id === id);
      return Promise.resolve(
        rowsOf(
          c
            ? [
                {
                  campaign: { id: c.id, name: c.name, status: c.status },
                  campaign_budget: { id: c.budgetId, amount_micros: c.budgetMicros },
                },
              ]
            : []
        )
      );
    }
    // Ad group by campaign + name
    const agByName = q.match(/FROM ad_group[\s\S]*campaign\.id = (\d+)[\s\S]*ad_group\.name = "([^"]*)"/);
    if (agByName) {
      const campId = Number(agByName[1]);
      const name = agByName[2].replace(/\\"/g, '"');
      const ag = state.adGroups.find((a) => a.campaignId === campId && a.name === name);
      return Promise.resolve(rowsOf(ag ? [{ ad_group: { id: ag.id, name: ag.name } }] : []));
    }
    // Ad group by id + campaign
    const agById = q.match(/FROM ad_group WHERE ad_group\.id = (\d+)/);
    if (agById) {
      const id = Number(agById[1]);
      const ag = state.adGroups.find((a) => a.id === id);
      return Promise.resolve(rowsOf(ag ? [{ ad_group: { id: ag.id, name: ag.name } }] : []));
    }
    // Ads under ad group
    if (/FROM ad_group_ad/.test(q)) {
      const m = q.match(/ad_group\.id = (\d+)/);
      const agId = m ? Number(m[1]) : null;
      const out = state.ads
        .filter((a) => agId == null || a.adGroupId === agId)
        .map((a) => ({
          ad_group_ad: {
            ad: {
              id: a.id,
              responsive_search_ad: {
                headlines: a.headlines.map((text) => ({ text })),
                descriptions: a.descriptions.map((text) => ({ text })),
              },
            },
          },
        }));
      return Promise.resolve(rowsOf(out));
    }
    // Keywords under ad group
    if (/FROM ad_group_criterion/.test(q) && /ad_group\.id = (\d+)/.test(q) && /KEYWORD/.test(q)) {
      const m = q.match(/ad_group\.id = (\d+)/);
      const agId = m ? Number(m[1]) : 0;
      const out = state.criteria
        .filter((k) => k.adGroupId === agId)
        .map((k) => ({
          ad_group_criterion: {
            id: k.id,
            keyword: { text: k.text },
            cpc_bid_micros: k.bidMicros,
            ad_group: k.adGroup,
          },
        }));
      return Promise.resolve(rowsOf(out));
    }
    // Criterion by id IN (bid resolution)
    const critIn = q.match(/FROM ad_group_criterion WHERE ad_group_criterion\.id IN \(([^)]*)\)/);
    if (critIn) {
      const ids = critIn[1]
        .split(",")
        .map((s) => Number(s.trim()))
        .filter(Number.isFinite);
      const out = state.criteria
        .filter((k) => ids.includes(k.id))
        .map((k) => ({
          ad_group_criterion: {
            id: k.id,
            ad_group: k.adGroup,
            cpc_bid_micros: k.bidMicros,
            keyword: { text: k.text },
          },
        }));
      return Promise.resolve(rowsOf(out));
    }
    // Negatives
    if (/FROM campaign_criterion WHERE/.test(q)) {
      const inM = q.match(/IN \(([^)]*)\)/);
      const texts = inM ? [...inM[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]) : [];
      const out = state.negatives
        .filter((n) => !texts.length || texts.includes(n.text))
        .map((n) => ({
          campaign: { id: n.campaignId },
          campaign_criterion: { negative: { keyword: { text: n.text } } },
        }));
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
    const results: { resource_name?: string; index: number }[] = [];

    list.forEach((o, i) => {
      const r = o.resource ?? {};

      // ── status / remove campaign ───────────────────────────────────────
      if (o.entity === "campaign" && (o.operation === "update" || o.operation === "remove")) {
        const id = parseCampaignResName(r.resource_name);
        const c = state.campaigns.find((x) => x.id === id);
        if (!c) throw new Error(`Simulator: campaign ${id} not found`);
        c.status = o.operation === "remove" ? "REMOVED" : normCampaignStatus(r.status);
        results.push({ index: i, resource_name: r.resource_name });
        return;
      }

      // ── create campaign_budget ─────────────────────────────────────────
      if (o.entity === "campaign_budget" && o.operation === "create") {
        const id = alloc();
        state.budgets.push({
          id,
          name: String(r.name ?? `Budget ${id}`),
          amountMicros: Number(r.amount_micros ?? 0),
        });
        results.push({
          index: i,
          resource_name: `customers/${CID}/campaignBudgets/${id}`,
        });
        return;
      }

      // ── create campaign ────────────────────────────────────────────────
      if (o.entity === "campaign" && o.operation === "create") {
        const id = alloc();
        const budgetRn = String(r.campaign_budget ?? "");
        const budgetId = idFromRn(budgetRn) || state.budgets[state.budgets.length - 1]?.id || 0;
        const budget = state.budgets.find((b) => b.id === budgetId);
        state.campaigns.push({
          id,
          name: String(r.name ?? `Campaign ${id}`),
          status: normCampaignStatus(r.status),
          budgetId,
          budgetMicros: budget?.amountMicros ?? 0,
        });
        results.push({
          index: i,
          resource_name: `customers/${CID}/campaigns/${id}`,
        });
        return;
      }

      // ── create ad_group ────────────────────────────────────────────────
      if (o.entity === "ad_group" && o.operation === "create") {
        const id = alloc();
        const campRn = String(r.campaign ?? "");
        const campaignId = idFromRn(campRn);
        state.adGroups.push({
          id,
          campaignId,
          name: String(r.name ?? `Ad group ${id}`),
          status: String(r.status ?? "ENABLED"),
          cpcBidMicros: Number(r.cpc_bid_micros ?? 0),
        });
        results.push({
          index: i,
          resource_name: `customers/${CID}/adGroups/${id}`,
        });
        return;
      }

      // ── create ad_group_ad (RSA) ───────────────────────────────────────
      if (o.entity === "ad_group_ad" && o.operation === "create") {
        const id = alloc();
        const agRn = String(r.ad_group ?? "");
        const adGroupId = idFromRn(agRn);
        const ad = r.ad ?? {};
        const rsa = ad.responsive_search_ad ?? {};
        state.ads.push({
          id,
          adGroupId,
          headlines: (rsa.headlines ?? []).map((h: { text?: string }) => String(h.text ?? "")),
          descriptions: (rsa.descriptions ?? []).map((d: { text?: string }) => String(d.text ?? "")),
          finalUrls: (ad.final_urls ?? []).map(String),
        });
        results.push({
          index: i,
          resource_name: `customers/${CID}/adGroupAds/${adGroupId}~${id}`,
        });
        return;
      }

      // ── create keyword criterion ───────────────────────────────────────
      if (o.entity === "ad_group_criterion" && o.operation === "create") {
        const id = alloc();
        const agRn = String(r.ad_group ?? "");
        const adGroupId = idFromRn(agRn);
        const ag = state.adGroups.find((a) => a.id === adGroupId);
        const text = String(r.keyword?.text ?? "");
        state.criteria.push({
          id,
          campaignId: ag?.campaignId ?? 0,
          adGroupId,
          adGroup: agRn || `customers/${CID}/adGroups/${adGroupId}`,
          text,
          bidMicros: Number(r.cpc_bid_micros ?? ag?.cpcBidMicros ?? 0),
        });
        results.push({
          index: i,
          resource_name: `customers/${CID}/adGroupCriteria/${adGroupId}~${id}`,
        });
        return;
      }

      // ── update keyword bid ─────────────────────────────────────────────
      if (o.entity === "ad_group_criterion" && o.operation === "update") {
        const m = String(r.resource_name).match(/adGroupCriteria\/(\d+)~(\d+)/);
        if (!m) throw new Error(`Simulator: bad criterion resource name: ${r.resource_name}`);
        const k = state.criteria.find((x) => x.id === Number(m[2]));
        if (!k) throw new Error(`Simulator: criterion ${m[2]} not found`);
        if (typeof r.cpc_bid_micros === "number") k.bidMicros = r.cpc_bid_micros;
        results.push({ index: i, resource_name: r.resource_name });
        return;
      }

      // ── create negative criterion ──────────────────────────────────────
      if (o.entity === "campaign_criterion" && o.operation === "create") {
        const cid = Number(String(r.campaign).match(/customers\/(\d+)/)?.[1]);
        const kw = r.keyword ?? r.negative?.keyword ?? {};
        const text = String(kw.text ?? "");
        if (!text) throw new Error("Simulator: negative criterion without text");
        // Note: real adapter uses customer resource as campaign field in one path;
        // for tests we accept any and store under first campaign or parsed id.
        const campaignId =
          state.campaigns.find((c) => c.id === cid)?.id ?? state.campaigns[0]?.id ?? cid;
        if (!state.negatives.some((n) => n.campaignId === campaignId && n.text === text)) {
          state.negatives.push({
            campaignId,
            text,
            matchType: String(kw.match_type ?? "BROAD"),
          });
        }
        results.push({ index: i });
        return;
      }

      throw new Error(`Simulator: unsupported mutation ${o.entity}:${o.operation}`);
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
      const budgetId = c.budgetId ?? alloc();
      state.budgets.push({ id: budgetId, name: `Budget ${c.id}`, amountMicros: c.budgetMicros });
      const campaign: SimCampaign = {
        id: c.id,
        name: c.name,
        status: c.status ?? "ENABLED",
        budgetId,
        budgetMicros: c.budgetMicros,
      };
      state.campaigns.push(campaign);
      return campaign;
    },
    addCriterion(c) {
      const adGroupId = c.adGroupId ?? c.campaignId * 10;
      const criterion: SimCriterion = {
        id: c.id,
        campaignId: c.campaignId,
        adGroupId,
        adGroup: c.adGroup ?? `customers/${CID}/adGroups/${adGroupId}`,
        text: c.text,
        bidMicros: c.bidMicros,
      };
      state.criteria.push(criterion);
      return criterion;
    },
  };
}

/** Minimal lib surface the builder needs — mirrors google-ads-api enums/ResourceNames. */
export function simGoogleLib() {
  return {
    enums: {
      CampaignStatus: { ENABLED: 2, PAUSED: 3, REMOVED: 4 },
      AdvertisingChannelType: { SEARCH: 2 },
      AdGroupStatus: { ENABLED: 2, PAUSED: 3 },
      AdGroupType: { SEARCH_STANDARD: 2 },
      BudgetDeliveryMethod: { STANDARD: 2 },
      KeywordMatchType: { BROAD: 2, PHRASE: 3, EXACT: 4 },
    },
    ResourceNames: {
      campaignBudget: (customerId: string, budgetId: string | number) =>
        `customers/${customerId}/campaignBudgets/${budgetId}`,
      campaign: (customerId: string, campaignId: string | number) =>
        `customers/${customerId}/campaigns/${campaignId}`,
      adGroup: (customerId: string, adGroupId: string | number) =>
        `customers/${customerId}/adGroups/${adGroupId}`,
      adGroupAd: (customerId: string, adGroupId: string | number, adId: string | number) =>
        `customers/${customerId}/adGroupAds/${adGroupId}~${adId}`,
      adGroupCriterion: (customerId: string, adGroupId: string | number, critId: string | number) =>
        `customers/${customerId}/adGroupCriteria/${adGroupId}~${critId}`,
    },
    toMicros: (v: number) => Math.round(v * 1_000_000),
  };
}
