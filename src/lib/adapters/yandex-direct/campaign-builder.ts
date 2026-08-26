// Yandex Direct campaign tree builder (Phase E.1, extended: responsive ads).
//
// Extracted from the monolithic `create_campaign` case (review P1-7) and
// hardened for production (review P0-1/2/6):
//
//   * IDEMPOTENT — before creating each resource the builder DISCOVERS it by
//     deterministic name (campaign correlation tag `agentmr:{org}:{action}`,
//     adgroup/keyword names, callout texts, ad headlines). A retried action
//     ADOPTS already-created resources instead of duplicating them (Direct has
//     no client-token idempotency, so name-based correlation is the
//     provider-side fingerprint).
//   * PARTIAL-FAILURE STATE (saga-lite) — on any step failure the result
//     carries the full `createdResources` + `failedAt`, so the agent can tell
//     the user exactly what exists at the provider and offer retry (resume)
//     or cleanup (delete_campaign_tree).
//   * STRATEGY — deterministic mapping to the Direct BiddingStrategy
//     (strategy.ts): the preview and the real campaign can never diverge.
//     Unified campaigns need their own vocabulary; conversion strategies
//     require a goal (clients.getGoals, best effort) and fall back to
//     WB_MAXIMUM_CLICKS with a VISIBLE note when no goal exists.
//   * MONEY — all ₽→micros conversions go through @/lib/money.
//
// Responsive ads (Phase E.2, «комбинаторные объявления»): new campaigns are
// UNIFIED performance campaigns (RESPONSIVE_AD is only allowed in
// UNIFIED_AD_GROUP) with the full Direct ad surface the UI offers:
// multiple headlines (Titles, ≤7), description (Texts), price
// (PriceExtension), callouts (AdExtensions), images (adimages), and
// campaign-level URL parameters / UTM tags (TrackingParams). Video
// extensions need the creative constructor and are not supported via API yet.
// Campaigns adopted from the legacy path (TextCampaign) keep the TextAd
// structure (Title/Title2/Text/AdImageHash) so in-flight actions survive.

import type { DirectApi } from "./api";
import { dailyRublesToWeeklyMicros, rublesToMicros } from "@/lib/money";
import { buildUnifiedBiddingStrategy, type StrategyKey } from "./strategy";

export interface BuildImage {
  url: string;
  name?: string;
}

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
  /** responsive ad headlines (Direct Titles), max 7; `title` = first one */
  titles?: string[];
  /** callout extensions (Direct «уточнения»), max 5 × 25 chars */
  callouts?: string[];
  /** ad price, ₽ → PriceExtension.Price (micros) */
  priceRubles?: number;
  /** old (strikethrough) price, ₽ → PriceExtension.OldPrice */
  priceOldRubles?: number;
  /** → PriceQualifier FROM / UP_TO (default NONE) */
  priceQualifier?: "from" | "up_to";
  /** campaign-level URL parameters / UTM (Direct TrackingParams) */
  trackingParams?: string;
  /** ad images: public URLs, jpg/png/gif, ≤5 (fetched + uploaded to Direct) */
  images?: BuildImage[];
  /** test seam: replaces global fetch for image download (default: fetch) */
  fetchImage?: (url: string) => Promise<{ base64: string; contentType: string }>;
}

export interface CreatedResource {
  kind: "campaign" | "adgroup" | "callout" | "image" | "ad" | "keyword";
  id: number | string;
  name?: string;
  /** true when the resource already existed and was adopted (not created now) */
  adopted: boolean;
}

export type BuildStep = "campaign" | "adgroup" | "callouts" | "images" | "ads" | "keywords" | "verify";

export interface BuildState {
  campaign: { id: number; name: string; adopted: boolean; /** true when the provider campaign is UNIFIED (ResponsiveAd-capable) */ unified: boolean } | null;
  adGroup: { id: number; name: string; adopted: boolean } | null;
  callouts: { id: number; text: string; adopted: boolean }[];
  images: { hash: string; name: string; adopted: boolean }[];
  ads: { id: number; title?: string; adopted: boolean }[];
  keywords: { id: number; text: string; adopted: boolean }[];
  failedAt: BuildStep | null;
  /** strategy adaptation note (e.g. goal fallback) — surfaced to the user */
  strategyNote?: string;
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

const MAX_TITLES = 7;
const MAX_TITLE_LEN = 56;
const MAX_CALLOUTS = 5;
const MAX_CALLOUT_LEN = 25;
const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 512 * 1024; // Direct API file limit
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif"]);

const emptyState = (): BuildState => ({
  campaign: null,
  adGroup: null,
  callouts: [],
  images: [],
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

/** Best-effort lookup of the first Metrika goal id (needed by conversion
 *  strategies in unified campaigns). Never throws — a lookup failure just
 *  means "fall back to maximum clicks with a note". */
async function findFirstGoalId(api: DirectApi): Promise<number | null> {
  try {
    const r = (await api.call("clients", "getGoals", {})) as { Goals?: { Id?: number }[] };
    const g = (r.Goals ?? []).find((x) => Number.isFinite(Number(x.Id)));
    return g ? Number(g.Id) : null;
  } catch {
    return null;
  }
}

export function normalizeTitles(p: BuildParams): string[] {
  const src = p.titles?.length ? p.titles : p.title ? [p.title] : [];
  return src.map((t) => String(t).trim()).filter(Boolean).map((t) => t.slice(0, MAX_TITLE_LEN)).slice(0, MAX_TITLES);
}

/**
 * Build (or resume building) a campaign tree:
 * campaign (unified) → adgroup → callouts → images → ad (responsive) → keywords.
 * Each step is idempotent via discovery.
 */
export async function buildCampaignTree(api: DirectApi, p: BuildParams): Promise<BuildResult> {
  const state = emptyState();
  let step: BuildStep = "campaign";
  const responses: Record<string, unknown> = {};

  const titles = normalizeTitles(p);
  const callouts = (p.callouts ?? []).map((c) => String(c).trim()).filter(Boolean).map((c) => c.slice(0, MAX_CALLOUT_LEN)).slice(0, MAX_CALLOUTS);
  const images = (p.images ?? []).slice(0, MAX_IMAGES);
  const trackingParams = p.trackingParams?.trim() ? String(p.trackingParams).trim().slice(0, 500) : undefined;

  const wantGroup = Boolean(p.adGroupName || titles.length || p.text || p.url || p.keywords?.length);
  const wantAd = Boolean(titles.length || p.text || p.url);
  if (wantAd && (!titles.length || !p.text)) {
    return {
      ok: false,
      verified: false,
      state,
      error: "Direct: для создания объявления нужны заголовок(и) (titles/title) и текст (text)",
      readback: state,
    };
  }
  const wantKeywords = Boolean(p.keywords?.length);

  const fail = (msg: string): BuildResult => {
    state.failedAt = step;
    // Saga state: whatever already exists at the provider must be reported so
    // the agent can offer retry (resume) or cleanup — and a retry can adopt it.
    if (state.campaign) state.createdResources.push({ kind: "campaign", id: state.campaign.id, name: state.campaign.name, adopted: state.campaign.adopted });
    if (state.adGroup) state.createdResources.push({ kind: "adgroup", id: state.adGroup.id, name: state.adGroup.name, adopted: state.adGroup.adopted });
    for (const c of state.callouts) state.createdResources.push({ kind: "callout", id: c.id, name: c.text, adopted: c.adopted });
    for (const img of state.images) state.createdResources.push({ kind: "image", id: img.hash, name: img.name, adopted: img.adopted });
    for (const a of state.ads) state.createdResources.push({ kind: "ad", id: a.id, adopted: a.adopted });
    for (const k of state.keywords) state.createdResources.push({ kind: "keyword", id: k.id, name: k.text, adopted: k.adopted });
    return { ok: false, verified: false, state, error: msg, providerResponse: responses, readback: state };
  };

  try {
    // ── 1. Campaign (discover by correlation name, adopt if present) ───────
    // ALL states: a freshly created campaign is IN_PREPARATION / UNDER
    // MODERATION, not ON/SUSPENDED — a state filter here would miss it and
    // the retry would duplicate the campaign. TextCampaign/UnifiedCampaign are
    // requested so an ADOPTED campaign keeps the ad structure it was made for.
    const existingCamps = (await api.call("campaigns", "get", {
      SelectionCriteria: {},
      FieldNames: ["Id", "Name", "State", "DailyBudget", "TextCampaign", "UnifiedCampaign"],
      Page: { Limit: 4000, Offset: 0 },
    })) as { Campaigns?: Record<string, unknown>[] };
    const adopted = (existingCamps.Campaigns ?? []).find((c) => String(c.Name) === p.correlationName);
    let campaignId: number;
    if (adopted) {
      campaignId = Number(adopted.Id);
      state.campaign = {
        id: campaignId,
        name: p.correlationName,
        adopted: true,
        unified: adopted.UnifiedCampaign != null && adopted.TextCampaign == null,
      };
    } else {
      step = "campaign";
      const weekly = dailyRublesToWeeklyMicros(p.budgetDaily);
      // Conversion strategies in unified campaigns need a Metrika goal.
      let goalId: number | null = null;
      if (p.strategy === "maximum_conversions" || p.strategy === "target_cpa") {
        goalId = await findFirstGoalId(api);
      }
      const strat = buildUnifiedBiddingStrategy(p.strategy, weekly, p.maxCpcRubles, p.maxCpaRubles, goalId);
      if (strat.note) state.strategyNote = strat.note;
      const resp = (await api.call("campaigns", "add", {
        Campaigns: [
          {
            Name: p.correlationName,
            StartDate: new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10),
            TimeZone: "Europe/Moscow",
            UnifiedCampaign: {
              BiddingStrategy: strat.payload,
              ...(trackingParams ? { TrackingParams: trackingParams } : {}),
            },
          },
        ],
      })) as { AddResults?: { Id?: number; Errors?: { Code: number; Message: string }[] }[] };
      responses.campaign = resp;
      const errs = itemErrors(resp);
      const id = resp.AddResults?.[0]?.Id;
      if (errs.length || !id) return fail(`Direct: создание кампании: ${fmtErr(errs) || "ID кампании не возвращён"}`);
      campaignId = Number(id);
      state.campaign = { id: campaignId, name: p.correlationName, adopted: false, unified: true };
    }

    if (wantGroup) {
      // ── 2. AdGroup (discover within the campaign by name) ────────────────
      const groupName = p.adGroupName ?? "Группа 1";
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
              // Unified performance group (RESPONSIVE_AD requires it).
              UnifiedAdGroup: { OfferRetargeting: "NO" },
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

      if (callouts.length) {
        // ── 3. Callouts (уточнения: AdExtensions, discover by text) ─────────
        step = "callouts";
        const allExt = (await api.call("adextensions", "get", {
          SelectionCriteria: {},
          FieldNames: ["Id", "Type", "State", "Status"],
          CalloutFieldNames: ["CalloutText"],
          Page: { Limit: 1000, Offset: 0 },
        })) as { AdExtensions?: Record<string, unknown>[] };
        const byText = new Map<string, number>();
        for (const e of allExt.AdExtensions ?? []) {
          const text = String((e.Callout as Record<string, unknown> | undefined)?.CalloutText ?? "");
          if (text && (e.State ?? "ON") !== "DELETED") byText.set(text, Number(e.Id));
        }
        const missing = callouts.filter((c) => !byText.has(c));
        for (const c of callouts) {
          const id = byText.get(c);
          if (id != null) state.callouts.push({ id, text: c, adopted: true });
        }
        if (missing.length) {
          const resp = (await api.call("adextensions", "add", {
            AdExtensions: missing.map((CalloutText) => ({ Callout: { CalloutText } })),
          })) as { AddResults?: { Id?: number; Errors?: { Code: number; Message: string }[] }[] };
          responses.callouts = resp;
          const errs = itemErrors(resp);
          if (errs.length) return fail(`Direct: создание уточнений: ${fmtErr(errs)}`);
          missing.forEach((c, i) => {
            const id = resp.AddResults?.[i]?.Id;
            if (id != null) state.callouts.push({ id: Number(id), text: c, adopted: false });
          });
        }
      }

      if (images.length) {
        // ── 4. Images (download → adimages.add → AdImageHashes) ─────────────
        step = "images";
        const doFetch =
          p.fetchImage ??
          (async (url: string) => {
            const r = await fetch(url);
            return {
              base64: Buffer.from(await r.arrayBuffer()).toString("base64"),
              contentType: r.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "",
            };
          });
        for (const img of images) {
          let base64: string;
          try {
            const res = await doFetch(img.url);
            if (!IMAGE_TYPES.has(res.contentType)) throw new Error(`тип ${res.contentType || "неизвестный"} — поддерживаются jpg/png/gif`);
            if (Buffer.from(res.base64, "base64").length > MAX_IMAGE_BYTES) throw new Error("файл больше 512 КБ");
            base64 = res.base64;
          } catch (e) {
            return fail(`Direct: загрузка изображения ${img.url}: ${(e as Error).message}`);
          }
          const name = img.name ?? img.url.split("/").pop()?.split("?")[0] ?? "image";
          const resp = (await api.call("adimages", "add", {
            AdImages: [{ ImageData: base64, Type: "AUTO", Name: name }],
          })) as { AddResults?: { AdImageHash?: string; Errors?: { Code: number; Message: string }[] }[] };
          responses[`image:${name}`] = resp;
          const errs = itemErrors(resp);
          const hash = resp.AddResults?.[0]?.AdImageHash;
          if (errs.length || !hash) return fail(`Direct: загрузка изображения ${name}: ${fmtErr(errs) || "хэш не возвращён"}`);
          // Content-hash based: re-uploading the same bytes is idempotent at
          // the provider, so a retried build attaches the same hash.
          state.images.push({ hash, name, adopted: false });
        }
      }

      if (wantAd) {
        // ── 5. Ad (responsive for unified campaigns; TextAd for legacy
        //     adopted campaigns) — discover by first headline ────────────────
        step = "ads";
        const unified = state.campaign?.unified ?? true;
        const existingAds = (await api.call("ads", "get", {
          SelectionCriteria: { AdGroupIds: [adGroupId] },
          FieldNames: ["Id", "CampaignId", "AdGroupId", "Type", "Status", "State"],
          TextAdFieldNames: ["Title", "Title2", "Text", "Href"],
          ResponsiveAdFieldNames: ["Titles", "Texts", "Href"],
        })) as { Ads?: Record<string, unknown>[] };
        const firstTitle = titles[0];
        const adoptedAd = (existingAds.Ads ?? []).find((a) => {
          const resp = a.ResponsiveAd as Record<string, unknown> | undefined;
          const text = a.TextAd as Record<string, unknown> | undefined;
          return String((resp?.Titles as string[] | undefined)?.[0] ?? text?.Title) === firstTitle;
        });
        if (adoptedAd) {
          state.ads.push({ id: Number(adoptedAd.Id), title: firstTitle, adopted: true });
        } else {
          const priceExtension =
            p.priceRubles != null && Number.isFinite(p.priceRubles) && p.priceRubles > 0
              ? {
                  Price: rublesToMicros(p.priceRubles),
                  PriceQualifier: p.priceQualifier === "from" ? "FROM" : p.priceQualifier === "up_to" ? "UP_TO" : "NONE",
                  PriceCurrency: "RUB",
                  ...(p.priceOldRubles != null && p.priceOldRubles > 0 ? { OldPrice: rublesToMicros(p.priceOldRubles) } : {}),
                }
              : undefined;

          const adItem: Record<string, unknown> = unified
            ? {
                AdGroupId: adGroupId,
                ResponsiveAd: {
                  Titles: titles,
                  Texts: [String(p.text).trim()],
                  ...(p.url ? { Href: p.url } : {}),
                  ...(priceExtension ? { PriceExtension: priceExtension } : {}),
                  ...(state.callouts.length ? { AdExtensionIds: state.callouts.map((c) => c.id) } : {}),
                  ...(state.images.length ? { AdImageHashes: state.images.map((i) => i.hash) } : {}),
                },
              }
            : {
                AdGroupId: adGroupId,
                // Legacy TextAd for an adopted TextCampaign: 2 headlines, 1 image.
                TextAd: {
                  Title: firstTitle,
                  ...(titles[1] ? { Title2: titles[1] } : {}),
                  Text: String(p.text).trim(),
                  Mobile: "NO",
                  ...(p.url ? { Href: p.url } : {}),
                  ...(priceExtension ? { PriceExtension: priceExtension } : {}),
                  ...(state.callouts.length ? { AdExtensionIds: state.callouts.map((c) => c.id) } : {}),
                  ...(state.images.length ? { AdImageHash: state.images[0].hash } : {}),
                },
              };

          const resp = (await api.call("ads", "add", { Ads: [adItem] })) as {
            AddResults?: { Id?: number; Errors?: { Code: number; Message: string }[] }[];
          };
          responses.ad = resp;
          const errs = itemErrors(resp);
          const id = resp.AddResults?.[0]?.Id;
          if (errs.length || !id) return fail(`Direct: создание объявления: ${fmtErr(errs) || "ID объявления не возвращён"}`);
          state.ads.push({ id: Number(id), title: firstTitle, adopted: false });
        }
      }

      if (wantKeywords) {
        // ── 6. Keywords (discover by text within the group; add missing only)
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

    // ── 7. Read-back verification (E4) ─────────────────────────────────────
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
        // in SelectionCriteria.Ids. Verify by AdGroupIds + first headline
        // (both safe < 2^53 and exactly what the verification means).
        adReadback = await api.call("ads", "get", {
          SelectionCriteria: { AdGroupIds: [state.adGroup.id] },
          FieldNames: ["Id", "CampaignId", "AdGroupId", "Type", "Status", "State"],
          TextAdFieldNames: ["Title", "Title2", "Text", "Href"],
          ResponsiveAdFieldNames: ["Titles", "Texts", "Href"],
        });
        const ads = (adReadback as { Ads?: Record<string, unknown>[] }).Ads ?? [];
        const wanted = new Set(state.ads.map((a) => a.title).filter(Boolean));
        const matched = ads.filter((a) => {
          const resp = a.ResponsiveAd as Record<string, unknown> | undefined;
          const text = a.TextAd as Record<string, unknown> | undefined;
          const headline = String((resp?.Titles as string[] | undefined)?.[0] ?? text?.Title);
          return Number(a.AdGroupId) === state.adGroup!.id && (wanted.size === 0 || wanted.has(headline));
        });
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
    for (const c of state.callouts) state.createdResources.push({ kind: "callout", id: c.id, name: c.text, adopted: c.adopted });
    for (const img of state.images) state.createdResources.push({ kind: "image", id: img.hash, name: img.name, adopted: img.adopted });
    for (const a of state.ads) state.createdResources.push({ kind: "ad", id: a.id, adopted: a.adopted });
    for (const k of state.keywords) state.createdResources.push({ kind: "keyword", id: k.id, name: k.text, adopted: k.adopted });

    const adoptedCount = state.createdResources.filter((r) => r.adopted).length;
    return {
      ok: true,
      verified: true,
      state,
      providerResponse: responses,
      readback: { campaign: campaignsBack, adGroupId: state.adGroup?.id ?? null, ads: adReadback, keywords: keywordReadback, createdResources: state.createdResources },
      detail:
        `Direct: кампания создана и подтверждена read-back${state.adGroup ? ` · группа ${state.adGroup.id}` : ""}` +
        `${state.callouts.length ? ` · уточнений ${state.callouts.length}` : ""}` +
        `${state.images.length ? ` · изображений ${state.images.length}` : ""}` +
        `${state.ads.length ? ` · объявление ${state.ads[0].id} (${titles.length} загл.)` : ""}` +
        `${trackingParams ? " · UTM в кампании" : ""}` +
        `${state.keywords.length ? ` · ключевых фраз ${state.keywords.length}` : ""}` +
        `${state.strategyNote ? ` · ${state.strategyNote}` : ""}` +
        `${adoptedCount ? ` · восставлено существующих: ${adoptedCount} (идемпотентный повтор)` : ""}`,
    };
  } catch (e) {
    // Network timeout mid-build is the classic partial-execution case: report
    // exactly which step failed and what already exists at the provider.
    return fail((e as Error).message || `Direct: ошибка на шаге ${step}`);
  }
}

// money helpers re-exported for the client (single import point)
export { rublesToMicros };
