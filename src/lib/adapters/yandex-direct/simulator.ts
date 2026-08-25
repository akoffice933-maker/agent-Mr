// In-process simulator of the Yandex Direct API v5 services used by the
// adapter (campaigns, keywords, negativekeywords, reports).
//
// Purpose (Phase E, E8): prove the EXECUTION pipeline — write → provider
// response → read-back → VERIFIED / FAILED → retry — against a faithful
// provider contract, without a real account or real money. The simulator
// implements the same {method, params} → {result, errors} contract and the
// same state semantics as the real API (State ON/SUSPENDED, Budget, Bid,
// per-item ActionResult errors).

import type { YandexApiError, YandexResponse, YandexTransport } from "./api";

export interface SimCampaign {
  Id: number;
  Name: string;
  State: "ON" | "SUSPENDED";
  Budget: number;
  Type: "TEXT_CAMPAIGN" | "SMART_CAMPAIGN";
}

export interface SimAdGroup {
  Id: number;
  CampaignId: number;
  Name: string;
  RegionIds: number[];
}

export interface SimAd {
  Id: number;
  AdGroupId: number;
  CampaignId: number;
  Type: "TEXT_AD";
  Status: "DRAFT" | "ACCEPTED" | "REJECTED";
  State: "OFF" | "ON";
  TextAd: { Title: string; Text: string; Href: string; Mobile: "NO" };
}

export interface SimKeyword {
  Id: number;
  CampaignId: number;
  AdGroupId?: number;
  Keyword: string;
  Bid: number;
  State: "ON" | "SUSPENDED";
}

export interface SimState {
  campaigns: SimCampaign[];
  adGroups: SimAdGroup[];
  ads: SimAd[];
  keywords: SimKeyword[];
  negatives: { CampaignId: number; Keyword: string }[];
  /** synthetic daily stats: spend = budget/2 per active campaign per day */
}

export interface Simulator {
  transport: YandexTransport;
  state: SimState;
  /** make the next N write calls fail with a transient server error (retry test) */
  injectTransientFailures(n: number): void;
  /** make the next write call fail with a permanent validation error */
  injectPermanentFailure(message?: string): void;
  /**
   * Fail writes to a SPECIFIC service (partial-failure/saga tests).
   * `times` defaults to ∞ — a SUSTAINED outage: DirectApi retries transient
   * 500s up to 3×, so a one-shot failure would be healed by the retry loop
   * and no partial state would exist. Clear with clearWriteFailures().
   */
  failWrites(service: string, times?: number, message?: string): void;
  clearWriteFailures(): void;
  calls: { service: string; method: string }[];
  /** full request log (service, method, params) for assertions */
  lastRequests: { service: string; method: string; params: Record<string, unknown> }[];
}

export function createSimulator(initial?: Partial<SimState>): Simulator {
  const state: SimState = {
    campaigns: initial?.campaigns ?? [],
    adGroups: initial?.adGroups ?? [],
    ads: initial?.ads ?? [],
    keywords: initial?.keywords ?? [],
    negatives: initial?.negatives ?? [],
  };
  let transientLeft = 0;
  let permanent: string | null = null;
  let nextWriteFailure: { service: string; left: number; message: string } | null = null;
  const calls: { service: string; method: string }[] = [];
  const lastRequests: { service: string; method: string; params: Record<string, unknown> }[] = [];

  const err = (code: number, message: string): YandexApiError => ({ Code: code, Message: message });

  const transport: YandexTransport = async (service, method, params) => {
    calls.push({ service, method });
    lastRequests.push({ service, method, params });
    const isWrite = !["get"].includes(method);
    if (isWrite && nextWriteFailure && nextWriteFailure.service === service) {
      const f = nextWriteFailure;
      if (f.left === Infinity) {
        // sustained outage — keep failing
      } else {
        f.left -= 1;
        if (f.left <= 0) nextWriteFailure = null;
      }
      const e = new Error(f.message) as Error & { status?: number };
      e.status = 500;
      throw e;
    }
    if (isWrite && transientLeft > 0) {
      transientLeft--;
      const resp: YandexResponse = { result: { SuspendResults: [] }, errors: [err(13, "Simulated transient server error")] };
      return resp;
    }
    if (isWrite && permanent) {
      const resp: YandexResponse = { errors: [err(17, permanent)] };
      return resp;
    }

    const p = params as Record<string, any>;

    if (service === "campaigns") {
      if (method === "get") {
        let list = state.campaigns;
        const sc = p.SelectionCriteria ?? {};
        if (sc.Ids) list = list.filter((c) => (sc.Ids as number[]).includes(c.Id));
        if (sc.States) list = list.filter((c) => (sc.States as string[]).includes(c.State));
        const fields = (p.FieldNames as string[]) ?? ["Id"];
        return {
          result: {
            Campaigns: list.map((c) => Object.fromEntries(fields.map((f) => [f, (c as unknown as Record<string, unknown>)[f]]))),
          },
        };
      }
      if (method === "suspend" || method === "resume") {
        const ids = (p.SelectionCriteria?.Ids as number[]) ?? [];
        const target = method === "suspend" ? "SUSPENDED" : "ON";
        const results = ids.map((id) => {
          const c = state.campaigns.find((x) => x.Id === id);
          if (!c) return { Errors: [err(270, `Campaign ${id} not found`)] };
          c.State = target;
          return { Id: id };
        });
        const key = method === "suspend" ? "SuspendResults" : "ResumeResults";
        return { result: { [key]: results } };
      }
      if (method === "update") {
        const updates = (p.Campaigns as (Partial<SimCampaign> & { Id: number })[]) ?? [];
        const results = updates.map((u) => {
          const c = state.campaigns.find((x) => x.Id === u.Id);
          if (!c) return { Errors: [err(270, `Campaign ${u.Id} not found`)] };
          if (u.Budget != null) c.Budget = u.Budget;
          if (u.Name != null) c.Name = u.Name;
          return { Id: c.Id };
        });
        return { result: { UpdateResults: results } };
      }
      if (method === "add") {
        const adds = (p.Campaigns as Record<string, any>[]) ?? [];
        const results = adds.map((c) => {
          const id = Math.max(0, ...state.campaigns.map((x) => x.Id)) + 1;
          const bs = c.TextCampaign?.BiddingStrategy?.Search ?? {};
          const weekly =
            Number(bs.WbMaximumClicks?.WeeklySpendLimit ?? bs.WbMaximumConversions?.WeeklySpendLimit ?? 0) / 1_000_000;
          const budget = weekly > 0 ? weekly / 7 : 0;
          state.campaigns.push({ Id: id, Name: String(c.Name), State: "ON", Budget: budget, Type: "TEXT_CAMPAIGN" });
          return { Id: id };
        });
        return { result: { AddResults: results } };
      }
      if (method === "delete") {
        const ids = (p.SelectionCriteria?.Ids as number[]) ?? [];
        const results = ids.map((id) => {
          const i = state.campaigns.findIndex((c) => c.Id === id);
          if (i === -1) return { Errors: [err(270, `Campaign ${id} not found`)] };
          state.campaigns.splice(i, 1);
          // provider cascades: group → ads → keywords
          state.adGroups = state.adGroups.filter((g) => g.CampaignId !== id);
          state.ads = state.ads.filter((a) => a.CampaignId !== id);
          state.keywords = state.keywords.filter((k) => k.CampaignId !== id);
          return { Id: id };
        });
        return { result: { DeleteResults: results } };
      }
      return { errors: [err(17, `Unknown campaigns method ${method}`)] };
    }

    if (service === "keywords") {
      if (method === "get") {
        let list = state.keywords;
        const sc = p.SelectionCriteria ?? {};
        if (sc.Ids) list = list.filter((k) => (sc.Ids as number[]).includes(k.Id));
        if (sc.CampaignIds) list = list.filter((k) => (sc.CampaignIds as number[]).includes(k.CampaignId));
        if (sc.AdGroupIds) list = list.filter((k) => k.AdGroupId != null && (sc.AdGroupIds as number[]).includes(k.AdGroupId));
        const fields = (p.FieldNames as string[]) ?? ["Id"];
        return { result: { Keywords: list.map((k) => Object.fromEntries(fields.map((f) => [f, (k as unknown as Record<string, unknown>)[f]]))) } };
      }
      if (method === "update") {
        const updates = (p.Keywords as (Partial<SimKeyword> & { Id: number })[]) ?? [];
        const results = updates.map((u) => {
          const k = state.keywords.find((x) => x.Id === u.Id);
          if (!k) return { Errors: [err(270, `Keyword ${u.Id} not found`)] };
          if (u.Bid != null) k.Bid = u.Bid;
          if (u.State != null) k.State = u.State;
          return { Id: k.Id };
        });
        return { result: { UpdateResults: results } };
      }
      if (method === "add") {
        const adds = (p.Keywords as Record<string, any>[]) ?? [];
        const results = adds.map((k) => {
          const groupId = Number(k.AdGroupId);
          const group = state.adGroups.find((g) => g.Id === groupId);
          if (!group) return { Errors: [err(270, `AdGroup ${groupId} not found`)] };
          const id = Math.max(0, ...state.keywords.map((x) => x.Id)) + 1;
          state.keywords.push({ Id: id, CampaignId: group.CampaignId, AdGroupId: groupId, Keyword: String(k.Keyword), Bid: Number(k.Bid ?? 0), State: "ON" });
          return { Id: id, Keyword: String(k.Keyword) };
        });
        return { result: { AddResults: results } };
      }
      if (method === "delete") {
        const ids = (p.SelectionCriteria?.Ids as number[]) ?? [];
        const results = ids.map((id) => {
          const i = state.keywords.findIndex((k) => k.Id === id);
          if (i === -1) return { Errors: [err(270, `Keyword ${id} not found`)] };
          state.keywords.splice(i, 1);
          return { Id: id };
        });
        return { result: { DeleteResults: results } };
      }
      return { errors: [err(17, `Unknown keywords method ${method}`)] };
    }

    if (service === "adgroups") {
      if (method === "add") {
        const adds = (p.AdGroups as Record<string, any>[]) ?? [];
        const results = adds.map((g) => {
          const campaignId = Number(g.CampaignId);
          if (!state.campaigns.some((c) => c.Id === campaignId)) return { Errors: [err(270, `Campaign ${campaignId} not found`)] };
          const id = Math.max(0, ...state.adGroups.map((x) => x.Id)) + 1;
          state.adGroups.push({ Id: id, CampaignId: campaignId, Name: String(g.Name), RegionIds: g.RegionIds ?? [0] });
          return { Id: id };
        });
        return { result: { AddResults: results } };
      }
      if (method === "get") {
        let list = state.adGroups;
        const sc = p.SelectionCriteria ?? {};
        if (sc.Ids) list = list.filter((g) => (sc.Ids as number[]).includes(g.Id));
        if (sc.CampaignIds) list = list.filter((g) => (sc.CampaignIds as number[]).includes(g.CampaignId));
        if (sc.Names) list = list.filter((g) => (sc.Names as string[]).includes(g.Name));
        const fields = (p.FieldNames as string[]) ?? ["Id", "CampaignId", "Name"];
        return { result: { AdGroups: list.map((g) => Object.fromEntries(fields.map((f) => [f, (g as any)[f]]))) } };
      }
      if (method === "delete") {
        const ids = (p.SelectionCriteria?.Ids as number[]) ?? [];
        const results = ids.map((id) => {
          const i = state.adGroups.findIndex((g) => g.Id === id);
          if (i === -1) return { Errors: [err(270, `AdGroup ${id} not found`)] };
          state.adGroups.splice(i, 1);
          state.ads = state.ads.filter((a) => a.AdGroupId !== id);
          state.keywords = state.keywords.filter((k) => k.AdGroupId !== id);
          return { Id: id };
        });
        return { result: { DeleteResults: results } };
      }
      return { errors: [err(17, `Unknown adgroups method ${method}`)] };
    }

    if (service === "ads") {
      if (method === "add") {
        const adds = (p.Ads as Record<string, any>[]) ?? [];
        const results = adds.map((a) => {
          const groupId = Number(a.AdGroupId);
          const group = state.adGroups.find((g) => g.Id === groupId);
          if (!group) return { Errors: [err(270, `AdGroup ${groupId} not found`)] };
          const id = Math.max(0, ...state.ads.map((x) => x.Id)) + 1;
          const textAd = a.TextAd ?? {};
          state.ads.push({ Id: id, AdGroupId: groupId, CampaignId: group.CampaignId, Type: "TEXT_AD", Status: "DRAFT", State: "OFF", TextAd: { Title: String(textAd.Title), Text: String(textAd.Text), Href: String(textAd.Href), Mobile: "NO" } });
          return { Id: id };
        });
        return { result: { AddResults: results } };
      }
      if (method === "get") {
        let list = state.ads;
        const sc = p.SelectionCriteria ?? {};
        if (sc.Ids) list = list.filter((a) => (sc.Ids as number[]).includes(a.Id));
        if (sc.AdGroupIds) list = list.filter((a) => (sc.AdGroupIds as number[]).includes(a.AdGroupId));
        if (sc.CampaignIds) list = list.filter((a) => (sc.CampaignIds as number[]).includes(a.CampaignId));
        return { result: { Ads: list } };
      }
      if (method === "delete") {
        const ids = (p.SelectionCriteria?.Ids as number[]) ?? [];
        const results = ids.map((id) => {
          const i = state.ads.findIndex((a) => a.Id === id);
          if (i === -1) return { Errors: [err(270, `Ad ${id} not found`)] };
          state.ads.splice(i, 1);
          return { Id: id };
        });
        return { result: { DeleteResults: results } };
      }
      return { errors: [err(17, `Unknown ads method ${method}`)] };
    }

    if (service === "negativekeywords") {
      if (method === "get") {
        const sc = p.SelectionCriteria ?? {};
        let list = state.negatives;
        if (sc.CampaignIds) list = list.filter((n) => (sc.CampaignIds as number[]).includes(n.CampaignId));
        const fields = (p.FieldNames as string[]) ?? ["CampaignId"];
        return { result: { NegativeKeywords: list.map((n) => Object.fromEntries(fields.map((f) => [f, (n as unknown as Record<string, unknown>)[f]]))) } };
      }
      if (method === "add") {
        const adds = (p.NegativeKeywords as { CampaignId: number; TextKeyword: { Keyword: string } }[]) ?? [];
        const results = adds.map((n) => {
          const c = state.campaigns.find((x) => x.Id === n.CampaignId);
          if (!c) return { Errors: [err(270, `Campaign ${n.CampaignId} not found`)] };
          if (!state.negatives.some((x) => x.CampaignId === n.CampaignId && x.Keyword === n.TextKeyword.Keyword)) {
            state.negatives.push({ CampaignId: n.CampaignId, Keyword: n.TextKeyword.Keyword });
          }
          return { CampaignId: n.CampaignId, Keyword: n.TextKeyword.Keyword };
        });
        return { result: { AddResults: results } };
      }
      return { errors: [err(17, `Unknown negativekeywords method ${method}`)] };
    }

    if (service === "reports") {
      if (method === "get") {
        // CAMPAIGN_PERFORMANCE_REPORT: deterministic synthetic stats.
        const dateFrom = (p.SelectionCriteria?.DateFrom as string) ?? "";
        const dateTo = (p.SelectionCriteria?.DateTo as string) ?? "";
        const fields = (p.FieldNames as string[]) ?? ["Date", "CampaignId"];
        const rows: Record<string, unknown>[] = [];
        if (dateFrom && dateTo) {
          const from = new Date(dateFrom + "T00:00:00Z");
          const to = new Date(dateTo + "T00:00:00Z");
          for (const c of state.campaigns) {
            for (let d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) {
              const active = c.State === "ON";
              const row: Record<string, unknown> = {
                Date: d.toISOString().slice(0, 10),
                CampaignId: c.Id,
                CampaignName: c.Name,
                Impressions: active ? 1000 + c.Id * 7 : 0,
                Clicks: active ? 50 + c.Id * 3 : 0,
                Cost: active ? c.Budget / 2 : 0,
                Conversions: active ? 3 + (c.Id % 5) : 0,
              };
              rows.push(Object.fromEntries(fields.map((f) => [f, row[f] ?? null])));
            }
          }
        }
        return { result: rows };
      }
      return { errors: [err(17, `Unknown reports method ${method}`)] };
    }

    return { errors: [err(17, `Unknown service ${service}`)] };
  };

  return {
    transport,
    state,
    calls,
    lastRequests,
    injectTransientFailures(n) {
      transientLeft = n;
    },
    injectPermanentFailure(message = "Simulated permanent validation error") {
      permanent = message;
    },
    failWrites(service, times = Infinity, message = "Simulated provider failure (500)") {
      nextWriteFailure = { service, left: times, message };
    },
    clearWriteFailures() {
      nextWriteFailure = null;
    },
  };
}

// Shared simulator instance (env YANDEX_SIMULATOR=1 or tests).
let shared: Simulator | null = null;

export function getSharedSimulator(): Simulator {
  if (!shared) shared = createSimulator();
  return shared;
}

export function seedSimulatorFrom(campaigns: { id: number; name: string; status: string; budgetDaily: number }[]): void {
  const sim = getSharedSimulator();
  sim.state.campaigns = campaigns.map((c) => ({
    Id: c.id,
    Name: c.name,
    State: c.status === "active" ? "ON" : "SUSPENDED",
    Budget: c.budgetDaily,
    Type: "TEXT_CAMPAIGN" as const,
  }));
  sim.state.adGroups = [];
  sim.state.ads = [];
  sim.state.keywords = [];
  sim.state.negatives = [];
}
