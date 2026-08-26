// Yandex Direct campaign tree builder (Phase E.1).
//
// Extracted from the monolithic `create_campaign` case (review P1-7) and
// hardened for production (review P0-1/2/6):
//
//   * IDEMPOTENT — before creating each resource the builder DISCOVERS it by
//     deterministic name (campaign correlation tag `agentmr:{org}:{action}`,
//     adgroup/keyword names). A retried action ADOPTS already-created
//     resources instead of duplicating them (Direct has no client-token
//     idempotency, so name-based correlation is the provider-side fingerprint).
//   * PARTIAL-FAILURE STATE (saga-lite) — on any step failure the result
//     carries the full `createdResources` + `failedAt`, so the agent can tell
//     the user exactly what exists at the provider and offer retry (resume)
//     or cleanup (delete_campaign_tree).
//   * STRATEGY — deterministic mapping from the approved strategy to the
//     Direct BiddingStrategy (strategy.ts): the preview and the real campaign
//     can never diverge.
//   * MONEY — all ₽→micros conversions go through @/lib/money.

import type { DirectApi } from "./api";
import { dailyRublesToWeeklyMicros, rublesToMicros } from "@/lib/money";
import { buildBiddingStrategy, type StrategyKey } from "./strategy";

export interface BuildParams {
  /** full provider-facing name INCLUDING the correlation tag */
  correlationName: string;
  budgetDaily: number; // ₽
  strategy: StrategyKey;
  maxCpcRubles?: number;
  maxCpaRubles?: number;
  adGroupName?: string;
  title?: string;
  text?: string;
  url?: string;
  keywords?: string[];
  negativeKeywords?: string[];
  regionIds?: number[];
}

export interface CreatedResource {
  kind: "campaign" | "adgroup" | "ad" | "keyword";
  id: number;
  name?: string;
  /** true when the resource already existed and was adopted (not created now) */
  adopted: boolean;
}

export type BuildStep = "campaign" | "adgroup" | "ads" | "keywords" | "verify";

export interface BuildState {
  campaign: { id: number; name: string; adopted: boolean } | null;
  adGroup: { id: number; name: string; adopted: boolean } | null;
  ads: { id: number; title?: string; adopted: boolean }[];
  keywords: { id: number; text: string; adopted: boolean }[];
  failedAt: BuildStep | null;
  /** flat list of everything that exists at the provider after this run */
  createdResources: CreatedResource[];
}

export interface BuildResult {
  ok: boolean;
  verified: boolean;
  state: BuildState;
  error?: string;
  detail?: string;
  providerResponse?: unknown;
  /** structured read-back incl. createdResources — stored in pending_actions.readback */
  readback?: unknown;
}

const emptyState = (): BuildState => ({
  campaign: null,
  adGroup: null,
  ads: [],
  keywords: [],
  failedAt: null,
  createdResources: [],
});

function itemErrors(resp: unknown): { Code: number; Message: string }[] {
  const r = resp as { AddResults?: { Errors?: { Code: number; Message: string }[] }[] };
  return (r.AddResults ?? []).flatMap((x) => x.Errors ?? []);
}

const fmtErr = (errs: { Code: number; Message: string }[]) => errs.map((e) => `${e.Code}: ${e.Message}`).join("; ");

/**
 * Build (or resume building) a Text & Image campaign tree:
 * campaign → adgroup → ad → keywords. Each step is idempotent via discovery.
 */
export async function buildCampaignTree(api: DirectApi, p: BuildParams): Promise<BuildResult> {
  const state = emptyState();
  let step: BuildStep = "campaign";
  const responses: Record<string, unknown> = {};
  const wantGroup = Boolean(p.adGroupName || p.title || p.text || p.keywords?.length);
  const wantAd = Boolean(p.title || p.text || p.url);
  const wantKeywords = Boolean(p.keywords?.length);

  const fail = (msg: string): BuildResult => {
    state.failedAt = step;
    // Saga state: whatever already exists at the provider must be reported so
    // the agent can offer retry (resume) or cleanup — and a retry can adopt it.
    if (state.campaign) state.createdResources.push({ kind: "campaign", id: state.campaign.id, name: state.campaign.name, adopted: state.campaign.adopted });
    if (state.adGroup) state.createdResources.push({ kind: "adgroup", id: state.adGroup.id, name: state.adGroup.name, adopted: state.adGroup.adopted });
    for (const a of state.ads) state.createdResources.push({ kind: "ad", id: a.id, adopted: a.adopted });
    for (const k of state.keywords) state.createdResources.push({ kind: "keyword", id: k.id, name: k.text, adopted: k.adopted });
    return { ok: false, verified: false, state, error: msg, providerResponse: responses, readback: state };
  };

  try {
    // ── 1. Campaign (discover by correlation name, adopt if present) ───────
    // ALL states: a freshly created campaign is IN_PREPARATION / UNDER
    // MODERATION, not ON/SUSPENDED — a state filter here would miss it and
    // the retry would duplicate the campaign.
    const existingCamps = (await api.call("campaigns", "get", {
      SelectionCriteria: {},
      FieldNames: ["Id", "Name", "State", "DailyBudget"],
      Page: { Limit: 4000, Offset: 0 },
    })) as { Campaigns?: Record<string, unknown>[] };
    const adopted = (existingCamps.Campaigns ?? []).find((c) => String(c.Name) === p.correlationName);
    let campaignId: number;
    if (adopted) {
      campaignId = Number(adopted.Id);
      state.campaign = { id: campaignId, name: p.correlationName, adopted: true };
    } else {
      step = "campaign";
      const weekly = dailyRublesToWeeklyMicros(p.budgetDaily);
      const resp = (await api.call("campaigns", "add", {
        Campaigns: [
          {
            Name: p.correlationName,
            StartDate: new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10),
            TimeZone: "Europe/Moscow",
            TextCampaign: { BiddingStrategy: buildBiddingStrategy(p.strategy, weekly, p.maxCpcRubles, p.maxCpaRubles) },
          },
        ],
      })) as { AddResults?: { Id?: number; Errors?: { Code: number; Message: string }[] }[] };
      responses.campaign = resp;
      const errs = itemErrors(resp);
      const id = resp.AddResults?.[0]?.Id;
      if (errs.length || !id) return fail(`Direct: создание кампании: ${fmtErr(errs) || "ID кампании не возвращён"}`);
      campaignId = Number(id);
      state.campaign = { id: campaignId, name: p.correlationName, adopted: false };
    }

    if (wantGroup) {
      // ── 2. AdGroup (discover within the campaign by name) ────────────────
      const groupName = p.adGroupName ?? `Группа 1`;
      const groups = (await api.call("adgroups", "get", {
        SelectionCriteria: { CampaignIds: [campaignId] },
        FieldNames: ["Id", "CampaignId", "Name"],
      })) as { AdGroups?: Record<string, unknown>[] };
      const adoptedGroup = (groups.AdGroups ?? []).find((g) => String(g.Name) === groupName);
      let adGroupId: number;
      if (adoptedGroup) {
        adGroupId = Number(adoptedGroup.Id);
        state.adGroup = { id: adGroupId, name: groupName, adopted: true };
      } else {
        step = "adgroup";
        const resp = (await api.call("adgroups", "add", {
          AdGroups: [
            {
              Name: groupName,
              CampaignId: campaignId,
              // RegionIds is REQUIRED by the real API: 0 is invalid (5120),
              // omission is invalid (8000). Default: [1] = all of Russia.
              RegionIds: p.regionIds?.length ? p.regionIds : [1],
              ...(p.negativeKeywords?.length ? { NegativeKeywords: { Items: p.negativeKeywords } } : {}),
            },
          ],
        })) as { AddResults?: { Id?: number; Errors?: { Code: number; Message: string }[] }[] };
        responses.adGroup = resp;
        const errs = itemErrors(resp);
        const id = resp.AddResults?.[0]?.Id;
        if (errs.length || !id) return fail(`Direct: создание группы: ${fmtErr(errs) || "ID группы не возвращён"}`);
        adGroupId = Number(id);
        state.adGroup = { id: adGroupId, name: groupName, adopted: false };
      }

      if (wantAd) {
        // ── 3. Ad (discover within the group by title) ─────────────────────
        if (!p.title || !p.text || !p.url) {
          return fail("Direct: для создания объявления нужны title, text и url");
        }
        step = "ads";
        const existingAds = (await api.call("ads", "get", {
          SelectionCriteria: { AdGroupIds: [adGroupId] },
          FieldNames: ["Id", "CampaignId", "AdGroupId", "Type"],
          TextAdFieldNames: ["Title"],
        })) as { Ads?: Record<string, unknown>[] };
        const adoptedAd = (existingAds.Ads ?? []).find((a) => String((a.TextAd as Record<string, unknown>)?.Title) === p.title);
        if (adoptedAd) {
          state.ads.push({ id: Number(adoptedAd.Id), title: p.title, adopted: true });
        } else {
          const resp = (await api.call("ads", "add", {
            Ads: [{ AdGroupId: adGroupId, TextAd: { Title: p.title, Text: p.text, Mobile: "NO", Href: p.url } }],
          })) as { AddResults?: { Id?: number; Errors?: { Code: number; Message: string }[] }[] };
          responses.ad = resp;
          const errs = itemErrors(resp);
          const id = resp.AddResults?.[0]?.Id;
          if (errs.length || !id) return fail(`Direct: создание объявления: ${fmtErr(errs) || "ID объявления не возвращён"}`);
          state.ads.push({ id: Number(id), title: p.title, adopted: false });
        }
      }

      if (wantKeywords) {
        // ── 4. Keywords (discover by text within the group; add missing only) ─
        step = "keywords";
        const existingKws = (await api.call("keywords", "get", {
          SelectionCriteria: { CampaignIds: [campaignId] },
          FieldNames: ["Id", "AdGroupId", "Keyword", "State"],
        })) as { Keywords?: Record<string, unknown>[] };
        const have = new Set(
          (existingKws.Keywords ?? [])
            .filter((k) => Number(k.AdGroupId) === adGroupId)
            .map((k) => String(k.Keyword))
        );
        const missing = (p.keywords ?? []).slice(0, 1000).filter((k) => !have.has(k));
        (p.keywords ?? []).slice(0, 1000).forEach((k) => {
          if (have.has(k)) {
            const row = (existingKws.Keywords ?? []).find((x) => Number(x.AdGroupId) === adGroupId && String(x.Keyword) === k);
            if (row) state.keywords.push({ id: Number(row.Id), text: k, adopted: true });
          }
        });
        if (missing.length) {
          const resp = (await api.call("keywords", "add", {
            Keywords: missing.map((Keyword) => ({ Keyword, AdGroupId: adGroupId })),
          })) as { AddResults?: { Id?: number; Keyword?: string; Errors?: { Code: number; Message: string }[] }[] };
          responses.keywords = resp;
          const errs = itemErrors(resp);
          if (errs.length) return fail(`Direct: создание ключевых фраз: ${fmtErr(errs)}`);
          for (const r of resp.AddResults ?? []) {
            if (r.Id != null) state.keywords.push({ id: Number(r.Id), text: String(r.Keyword ?? ""), adopted: false });
          }
        }
      }
    }

    // ── 5. Read-back verification (E4) ─────────────────────────────────────
    step = "verify";
    const readback = await api.call("campaigns", "get", {
      SelectionCriteria: { Ids: [campaignId] },
      FieldNames: ["Id", "Name", "State", "Status", "Type"],
    });
    const campaignsBack = (readback as { Campaigns?: Record<string, unknown>[] }).Campaigns ?? [];
    const campaignVerified = campaignsBack.length === 1 && Number(campaignsBack[0].Id) === campaignId;
    if (!campaignVerified) return fail("Direct: read-back кампании не совпал с созданной");

    let adReadback: unknown;
    let keywordReadback: unknown;
    let adGroupVerified = true;
    if (state.adGroup) {
      const groupsBack = await api.call("adgroups", "get", { SelectionCriteria: { Ids: [state.adGroup.id] }, FieldNames: ["Id", "CampaignId", "Name"] });
      const groups = (groupsBack as { AdGroups?: Record<string, unknown>[] }).AdGroups ?? [];
      adGroupVerified = groups.length === 1 && Number(groups[0].CampaignId) === campaignId;
      if (!adGroupVerified) return fail("Direct: read-back группы не совпал");
      if (state.ads.length) {
        // Ad Ids are 64-bit and overflow JS Number precision — never use them
        // in SelectionCriteria.Ids. Verify by AdGroupIds + Title instead
        // (both safe < 2^53 and exactly what the verification means).
        adReadback = await api.call("ads", "get", {
          SelectionCriteria: { AdGroupIds: [state.adGroup.id] },
          FieldNames: ["Id", "CampaignId", "AdGroupId", "Type", "Status", "State"],
          TextAdFieldNames: ["Title", "Text", "Href"],
        });
        const ads = (adReadback as { Ads?: Record<string, unknown>[] }).Ads ?? [];
        const wanted = new Set(state.ads.map((a) => a.title).filter(Boolean));
        const matched = ads.filter(
          (a) => Number(a.AdGroupId) === state.adGroup!.id && (wanted.size === 0 || wanted.has(String((a.TextAd as Record<string, unknown>)?.Title)))
        );
        if (matched.length !== state.ads.length || !matched.every((a) => Number(a.CampaignId) === campaignId)) {
          return fail(`Direct: read-back объявления не совпал (в группе ${state.adGroup.id} найдено ${matched.length} из ${state.ads.length})`);
        }
      }
      if (state.keywords.length) {
        keywordReadback = await api.call("keywords", "get", {
          SelectionCriteria: { Ids: state.keywords.map((k) => k.id) },
          FieldNames: ["Id", "AdGroupId", "CampaignId", "Keyword", "State"],
        });
        const kws = (keywordReadback as { Keywords?: Record<string, unknown>[] }).Keywords ?? [];
        if (kws.length !== state.keywords.length || !kws.every((k) => Number(k.AdGroupId) === state.adGroup!.id)) {
          return fail("Direct: read-back ключевых фраз не совпал");
        }
      }
    }

    // Flatten createdResources for the saga/compensation record.
    if (state.campaign) state.createdResources.push({ kind: "campaign", id: state.campaign.id, name: state.campaign.name, adopted: state.campaign.adopted });
    if (state.adGroup) state.createdResources.push({ kind: "adgroup", id: state.adGroup.id, name: state.adGroup.name, adopted: state.adGroup.adopted });
    for (const a of state.ads) state.createdResources.push({ kind: "ad", id: a.id, adopted: a.adopted });
    for (const k of state.keywords) state.createdResources.push({ kind: "keyword", id: k.id, name: k.text, adopted: k.adopted });

    const adoptedCount = state.createdResources.filter((r) => r.adopted).length;
    return {
      ok: true,
      verified: true,
      state,
      providerResponse: responses,
      readback: { campaign: campaignsBack, adGroupId: state.adGroup?.id ?? null, ads: adReadback, keywords: keywordReadback, createdResources: state.createdResources },
      detail: `Direct: кампания создана и подтверждена read-back${state.adGroup ? ` · группа ${state.adGroup.id}` : ""}${state.ads.length ? ` · объявление ${state.ads[0].id}` : ""}${state.keywords.length ? ` · ключевых фраз ${state.keywords.length}` : ""}${adoptedCount ? ` · восставлено существующих: ${adoptedCount} (идемпотентный повтор)` : ""}`,
    };
  } catch (e) {
    // Network timeout mid-build is the classic partial-execution case: report
    // exactly which step failed and what already exists at the provider.
    return fail((e as Error).message || `Direct: ошибка на шаге ${step}`);
  }
}

// money helpers re-exported for the client (single import point)
export { rublesToMicros };
