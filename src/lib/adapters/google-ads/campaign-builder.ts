// Google Ads campaign tree builder (Phase 2.1 — E.1 parity with Yandex).
//
// Order: CampaignBudget → Campaign (PAUSED) → AdGroup → RSA Ad → Keywords
//        → read-back VERIFIED.
//
// Idempotency: correlation name `agentmr:{org}:{actionId}` embedded in
// campaign name. On retry, discover-by-name and ADOPT instead of duplicate.
//
// This module is pure against GoogleAdsCustomerLike (real client or simulator).

export interface GoogleAdsLibLike {
  enums: {
    CampaignStatus: { ENABLED: number | string; PAUSED: number | string; REMOVED: number | string };
    AdvertisingChannelType: { SEARCH: number | string };
    AdGroupStatus: { ENABLED: number | string; PAUSED: number | string };
    AdGroupType: { SEARCH_STANDARD: number | string };
    BudgetDeliveryMethod: { STANDARD: number | string };
    KeywordMatchType: { BROAD: number | string; PHRASE: number | string; EXACT: number | string };
  };
  ResourceNames: {
    campaignBudget: (customerId: string, budgetId: string | number) => string;
    campaign: (customerId: string, campaignId: string | number) => string;
    adGroup: (customerId: string, adGroupId: string | number) => string;
    adGroupAd: (customerId: string, adGroupId: string | number, adId: string | number) => string;
  };
  toMicros: (v: number) => number;
}

export interface GoogleAdsCustomerLike {
  query(gaql: string): Promise<unknown>;
  mutateResources(ops: unknown[]): Promise<unknown>;
}

export interface GoogleBuildParams {
  customerId: string; // 10-digit, no dashes
  correlationName: string; // full provider-facing campaign name incl. agentmr tag
  budgetDaily: number; // account currency units (usually currency major)
  headlines: string[]; // RSA headlines, max 15, each ≤30 chars recommended
  descriptions: string[]; // RSA descriptions, max 4, each ≤90
  finalUrl: string;
  keywords?: string[];
  adGroupName?: string;
  /** optional CPC bid for ad group, major units */
  cpcBid?: number;
}

export interface CreatedResource {
  kind: "budget" | "campaign" | "adgroup" | "ad" | "keyword";
  id: string;
  name?: string;
  adopted: boolean;
}

export type BuildStep = "budget" | "campaign" | "adgroup" | "ad" | "keywords" | "verify";

export interface BuildState {
  budgetId: string | null;
  campaignId: string | null;
  adGroupId: string | null;
  adId: string | null;
  keywordIds: string[];
  failedAt: BuildStep | null;
  createdResources: CreatedResource[];
}

export interface BuildResult {
  ok: boolean;
  verified: boolean;
  state: BuildState;
  error?: string;
  detail?: string;
  providerResponse?: unknown;
  readback?: unknown;
}

type Row = Record<string, any>;

function rowsOf(res: unknown): Row[] {
  return ((res as { results?: { row?: Row }[] }).results ?? []).map((r) => r.row ?? {});
}
function g(row: Row, ...path: string[]): any {
  let v: any = row;
  for (const p of path) v = v?.[p];
  return v;
}
function num(v: any): number {
  return Number(v ?? 0) || 0;
}
function idFromResourceName(rn: string): string {
  const parts = rn.split("/");
  return parts[parts.length - 1] ?? rn;
}

const emptyState = (): BuildState => ({
  budgetId: null,
  campaignId: null,
  adGroupId: null,
  adId: null,
  keywordIds: [],
  failedAt: null,
  createdResources: [],
});

/**
 * Build or resume a Search campaign tree with RSA + keywords.
 * Safe to retry: discovers existing resources by correlation campaign name.
 */
export async function buildGoogleCampaignTree(
  customer: GoogleAdsCustomerLike,
  lib: GoogleAdsLibLike,
  p: GoogleBuildParams
): Promise<BuildResult> {
  const state = emptyState();
  let step: BuildStep = "budget";
  const responses: Record<string, unknown> = {};
  const { enums, ResourceNames, toMicros } = lib;
  const cid = p.customerId;

  const headlines = (p.headlines ?? []).map((h) => String(h).trim()).filter(Boolean).slice(0, 15);
  const descriptions = (p.descriptions ?? []).map((d) => String(d).trim()).filter(Boolean).slice(0, 4);
  const keywords = (p.keywords ?? []).map((k) => String(k).trim()).filter(Boolean).slice(0, 500);
  const adGroupName = (p.adGroupName ?? "Ad group 1").slice(0, 255);
  const finalUrl = String(p.finalUrl || "").trim();

  if (headlines.length < 3 || descriptions.length < 2 || !finalUrl) {
    return {
      ok: false,
      verified: false,
      state,
      error: "Google Ads: RSA требует ≥3 заголовка, ≥2 описания и final URL",
      readback: state,
    };
  }

  const fail = (msg: string): BuildResult => {
    state.failedAt = step;
    return { ok: false, verified: false, state, error: msg, providerResponse: responses, readback: state };
  };

  try {
    // ── 1. Discover existing campaign by correlation name ────────────────
    const found = await customer.query(
      `SELECT campaign.id, campaign.name, campaign.status, campaign_budget.id
       FROM campaign
       WHERE campaign.name = "${p.correlationName.replace(/"/g, '\\"')}"`
    );
    const existing = rowsOf(found)[0];
    if (existing) {
      state.campaignId = String(g(existing, "campaign", "id") ?? "");
      state.budgetId = String(g(existing, "campaign_budget", "id") ?? "") || null;
      state.createdResources.push({
        kind: "campaign",
        id: state.campaignId,
        name: p.correlationName,
        adopted: true,
      });
      if (state.budgetId) {
        state.createdResources.push({ kind: "budget", id: state.budgetId, adopted: true });
      }
    }

    // ── 2. Budget (create if not adopted) ─────────────────────────────────
    step = "budget";
    if (!state.budgetId) {
      const budgetName = `Budget · ${p.correlationName}`.slice(0, 255);
      const budgetMicros = toMicros(Math.max(0.01, p.budgetDaily));
      const mut = await customer.mutateResources([
        {
          entity: "campaign_budget",
          operation: "create",
          resource: {
            name: budgetName,
            amount_micros: budgetMicros,
            delivery_method: enums.BudgetDeliveryMethod.STANDARD,
            explicitly_shared: false,
          },
        },
      ]);
      responses.budget = mut;
      const rn =
        (mut as { results?: { resource_name?: string }[] })?.results?.[0]?.resource_name ??
        (mut as { resourceNames?: string[] })?.resourceNames?.[0];
      if (!rn) return fail("Google Ads: budget create — resource_name не возвращён");
      state.budgetId = idFromResourceName(String(rn));
      state.createdResources.push({ kind: "budget", id: state.budgetId, name: budgetName, adopted: false });
    }

    // ── 3. Campaign ──────────────────────────────────────────────────────
    step = "campaign";
    if (!state.campaignId) {
      const mut = await customer.mutateResources([
        {
          entity: "campaign",
          operation: "create",
          resource: {
            name: p.correlationName,
            status: enums.CampaignStatus.PAUSED, // safe default; operator enables after review
            advertising_channel_type: enums.AdvertisingChannelType.SEARCH,
            campaign_budget: ResourceNames.campaignBudget(cid, state.budgetId!),
            // Maximize clicks without ceiling — simple default for E2E.
            maximize_clicks: {},
            network_settings: {
              target_google_search: true,
              target_search_network: true,
              target_content_network: false,
            },
          },
        },
      ]);
      responses.campaign = mut;
      const rn =
        (mut as { results?: { resource_name?: string }[] })?.results?.[0]?.resource_name ??
        (mut as { resourceNames?: string[] })?.resourceNames?.[0];
      if (!rn) return fail("Google Ads: campaign create — resource_name не возвращён");
      state.campaignId = idFromResourceName(String(rn));
      state.createdResources.push({
        kind: "campaign",
        id: state.campaignId,
        name: p.correlationName,
        adopted: false,
      });
    }

    // ── 4. Ad group (discover by name under campaign) ────────────────────
    step = "adgroup";
    {
      const q = await customer.query(
        `SELECT ad_group.id, ad_group.name FROM ad_group
         WHERE campaign.id = ${state.campaignId} AND ad_group.name = "${adGroupName.replace(/"/g, '\\"')}"`
      );
      const hit = rowsOf(q)[0];
      if (hit) {
        state.adGroupId = String(g(hit, "ad_group", "id") ?? "");
        state.createdResources.push({ kind: "adgroup", id: state.adGroupId, name: adGroupName, adopted: true });
      } else {
        const cpc = toMicros(Math.max(0.05, p.cpcBid ?? 1));
        const mut = await customer.mutateResources([
          {
            entity: "ad_group",
            operation: "create",
            resource: {
              name: adGroupName,
              campaign: ResourceNames.campaign(cid, state.campaignId!),
              status: enums.AdGroupStatus.ENABLED,
              type: enums.AdGroupType.SEARCH_STANDARD,
              cpc_bid_micros: cpc,
            },
          },
        ]);
        responses.adgroup = mut;
        const rn =
          (mut as { results?: { resource_name?: string }[] })?.results?.[0]?.resource_name ??
          (mut as { resourceNames?: string[] })?.resourceNames?.[0];
        if (!rn) return fail("Google Ads: ad group create — resource_name не возвращён");
        state.adGroupId = idFromResourceName(String(rn));
        state.createdResources.push({ kind: "adgroup", id: state.adGroupId, name: adGroupName, adopted: false });
      }
    }

    // ── 5. Responsive Search Ad ──────────────────────────────────────────
    step = "ad";
    {
      const q = await customer.query(
        `SELECT ad_group_ad.ad.id, ad_group_ad.ad.responsive_search_ad.headlines
         FROM ad_group_ad
         WHERE ad_group.id = ${state.adGroupId}`
      );
      const firstHeadline = headlines[0];
      const existingAd = rowsOf(q).find((r) => {
        const hs = g(r, "ad_group_ad", "ad", "responsive_search_ad", "headlines") as { text?: string }[] | undefined;
        return (hs ?? []).some((h) => h?.text === firstHeadline);
      });
      if (existingAd) {
        state.adId = String(g(existingAd, "ad_group_ad", "ad", "id") ?? "");
        state.createdResources.push({ kind: "ad", id: state.adId, adopted: true });
      } else {
        const mut = await customer.mutateResources([
          {
            entity: "ad_group_ad",
            operation: "create",
            resource: {
              ad_group: ResourceNames.adGroup(cid, state.adGroupId!),
              status: enums.AdGroupStatus.ENABLED,
              ad: {
                final_urls: [finalUrl],
                responsive_search_ad: {
                  headlines: headlines.map((text) => ({ text })),
                  descriptions: descriptions.map((text) => ({ text })),
                },
              },
            },
          },
        ]);
        responses.ad = mut;
        const rn =
          (mut as { results?: { resource_name?: string }[] })?.results?.[0]?.resource_name ??
          (mut as { resourceNames?: string[] })?.resourceNames?.[0];
        if (!rn) return fail("Google Ads: RSA create — resource_name не возвращён");
        // resource name: customers/.../adGroupAds/{adGroupId}~{adId}
        const tail = idFromResourceName(String(rn));
        state.adId = tail.includes("~") ? tail.split("~")[1] : tail;
        state.createdResources.push({ kind: "ad", id: state.adId, adopted: false });
      }
    }

    // ── 6. Keywords ──────────────────────────────────────────────────────
    step = "keywords";
    if (keywords.length) {
      const q = await customer.query(
        `SELECT ad_group_criterion.id, ad_group_criterion.keyword.text
         FROM ad_group_criterion
         WHERE ad_group.id = ${state.adGroupId} AND ad_group_criterion.type = "KEYWORD"`
      );
      const have = new Set(rowsOf(q).map((r) => String(g(r, "ad_group_criterion", "keyword", "text") ?? "")));
      for (const r of rowsOf(q)) {
        const text = String(g(r, "ad_group_criterion", "keyword", "text") ?? "");
        const id = String(g(r, "ad_group_criterion", "id") ?? "");
        if (keywords.includes(text) && id) {
          state.keywordIds.push(id);
          state.createdResources.push({ kind: "keyword", id, name: text, adopted: true });
        }
      }
      const missing = keywords.filter((k) => !have.has(k));
      if (missing.length) {
        const ops = missing.map((text) => ({
          entity: "ad_group_criterion",
          operation: "create",
          resource: {
            ad_group: ResourceNames.adGroup(cid, state.adGroupId!),
            status: enums.AdGroupStatus.ENABLED,
            keyword: { text, match_type: enums.KeywordMatchType.BROAD },
          },
        }));
        const mut = await customer.mutateResources(ops);
        responses.keywords = mut;
        const results = (mut as { results?: { resource_name?: string }[] })?.results ?? [];
        results.forEach((res, i) => {
          if (!res.resource_name) return;
          const id = idFromResourceName(res.resource_name);
          state.keywordIds.push(id);
          state.createdResources.push({ kind: "keyword", id, name: missing[i], adopted: false });
        });
      }
    }

    // ── 7. Read-back verification ────────────────────────────────────────
    step = "verify";
    const rb = await customer.query(
      `SELECT campaign.id, campaign.name, campaign.status, campaign_budget.amount_micros
       FROM campaign WHERE campaign.id = ${state.campaignId}`
    );
    const camp = rowsOf(rb)[0];
    if (!camp || String(g(camp, "campaign", "id")) !== state.campaignId) {
      return fail("Google Ads: read-back кампании не совпал");
    }
    if (String(g(camp, "campaign", "name")) !== p.correlationName) {
      return fail("Google Ads: read-back имени кампании не совпал");
    }

    const agRb = await customer.query(
      `SELECT ad_group.id FROM ad_group WHERE ad_group.id = ${state.adGroupId} AND campaign.id = ${state.campaignId}`
    );
    if (!rowsOf(agRb).length) return fail("Google Ads: read-back группы не совпал");

    if (keywords.length) {
      const kwRb = await customer.query(
        `SELECT ad_group_criterion.keyword.text FROM ad_group_criterion
         WHERE ad_group.id = ${state.adGroupId} AND ad_group_criterion.type = "KEYWORD"`
      );
      const got = new Set(rowsOf(kwRb).map((r) => String(g(r, "ad_group_criterion", "keyword", "text") ?? "")));
      const missingKw = keywords.filter((k) => !got.has(k));
      if (missingKw.length) {
        return fail(`Google Ads: read-back ключей не полный (нет: ${missingKw.slice(0, 5).join(", ")})`);
      }
    }

    const adopted = state.createdResources.filter((r) => r.adopted).length;
    return {
      ok: true,
      verified: true,
      state,
      providerResponse: responses,
      readback: {
        campaignId: state.campaignId,
        budgetId: state.budgetId,
        adGroupId: state.adGroupId,
        adId: state.adId,
        keywordIds: state.keywordIds,
        createdResources: state.createdResources,
      },
      detail:
        `Google Ads: кампания создана и подтверждена read-back` +
        ` · campaign ${state.campaignId}` +
        ` · группа ${state.adGroupId}` +
        (state.adId ? ` · RSA ${state.adId}` : "") +
        (state.keywordIds.length ? ` · ключей ${state.keywordIds.length}` : "") +
        (adopted ? ` · восстановлено: ${adopted}` : ""),
    };
  } catch (e) {
    return fail((e as Error).message || `Google Ads: ошибка на шаге ${step}`);
  }
}
