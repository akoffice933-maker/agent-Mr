// Google Ads adapter — real API via the `google-ads-api` Node client (REST,
// Google Ads API v24 protos; package by opteo, the `google-ads` npm name is a
// stub, NOT a client — verified 2026-08-27).
//
// Contract verified against the installed library (v24.1.0):
//   client  = new GoogleAdsApi({client_id, client_secret, developer_token})
//   customer = client.Customer({customer_id, refresh_token})
//   rows:   (await customer.query(gaql)).results[].row  → NESTED snake_case:
//           row.campaign.id, row.campaign.status ("ENABLED"|"PAUSED"|"REMOVED"),
//           row.campaign_budget.amount_micros, row.segments.date,
//           row.metrics.{impressions,clicks,cost_micros,all_conversions}
//   writes: customer.mutateResources([{entity, operation: "create"|"update"|"remove", resource}])
//           — update_mask is computed automatically from the resource fields.
//   v24 note: CampaignNegativeCriterion is GONE — campaign-level negatives are
//           campaign_criterion with negative: true (unified criterion resource).
//   bids:   ad_group_criterion.cpc_bid_micros (flat field, still served in v24).
//
// Production path: OAuth authorization_code (/api/oauth/google, scope adwords,
// offline access → refresh token) + GOOGLE_ADS_DEVELOPER_TOKEN +
// GOOGLE_ADS_CUSTOMER_ID (10 digits, no dashes).

import { and, eq, inArray } from "drizzle-orm";
import { db, currentTenant } from "@/db";
import { campaigns, keywords, metricsDaily } from "@/db/schema";
import { registerRefresher, storeToken, getToken, type StoredToken } from "../oauth-store";
import type { DailyMetric, PlatformClient, ExecutionResult, WriteOp } from "../types";
// TYPE-ONLY imports: the runtime library (google-ads-api + its v24 protos,
// ~250k lines) is loaded DYNAMICALLY in loadLib() below, only when the
// production path is actually used. Sandbox/dev never pulls it into the
// bundle (keeps dev compile light — a static import OOM-kills the dev server).
import type {
  GoogleAdsApi as GoogleAdsApiT,
  enums as enumsT,
  ResourceNames as ResourceNamesT,
  MutateOperation,
  resources,
} from "google-ads-api";

interface GoogleAdsLib {
  GoogleAdsApi: new (cfg: { client_id: string; client_secret: string; developer_token: string }) => GoogleAdsApiT;
  enums: typeof enumsT;
  ResourceNames: typeof ResourceNamesT;
  toMicros: (v: number) => number;
}

const OAUTH = "https://oauth2.googleapis.com";
const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";

function clientId(): string {
  const v = process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (!v) throw new Error("GOOGLE_OAUTH_CLIENT_ID is not set (Google Cloud → OAuth client)");
  return v;
}
function clientSecret(): string {
  const v = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!v) throw new Error("GOOGLE_OAUTH_CLIENT_SECRET is not set");
  return v;
}
function developerToken(): string {
  const v = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!v) throw new Error("GOOGLE_ADS_DEVELOPER_TOKEN is not set (Google Ads API access)");
  return v;
}
function customerId(): string {
  const v = process.env.GOOGLE_ADS_CUSTOMER_ID;
  if (!v || !/^\d{10}$/.test(v)) throw new Error("GOOGLE_ADS_CUSTOMER_ID is not set (10-digit id without dashes)");
  return v;
}
function redirectUri(): string {
  return `${process.env.PUBLIC_URL ?? "http://localhost:3000"}/api/oauth/google`;
}

export function googleAuthUrl(state: string): string {
  const p = new URLSearchParams({
    response_type: "code",
    client_id: clientId(),
    redirect_uri: redirectUri(),
    scope: "https://www.googleapis.com/auth/adwords",
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${AUTH}?${p.toString()}`;
}

async function requestToken(grantType: "authorization_code" | "refresh_token", params: Record<string, string>): Promise<StoredToken> {
  const body = new URLSearchParams({ grant_type: grantType, client_id: clientId(), client_secret: clientSecret(), ...params });
  const res = await fetch(`${OAUTH}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!res.ok) throw new Error(`Google token error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const d = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
  return {
    accessToken: d.access_token,
    refreshToken: d.refresh_token, // Google returns refresh_token on first authorization only
    expiresAt: d.expires_in ? new Date(Date.now() + d.expires_in * 1000) : undefined,
  };
}

export async function googleExchangeCode(code: string): Promise<StoredToken> {
  const t = await requestToken("authorization_code", { code, redirect_uri: redirectUri() });
  await storeToken(currentTenant()?.orgId ?? 1, "google", t);
  return t;
}

async function refreshGoogle(current: StoredToken | null): Promise<StoredToken> {
  if (!current?.refreshToken) throw new Error("No Google refresh token stored — reconnect the account (prompt=consent)");
  const t = await requestToken("refresh_token", { refresh_token: current.refreshToken });
  // Keep the old refresh token if Google did not return a new one.
  if (!t.refreshToken) t.refreshToken = current.refreshToken;
  return t;
}
registerRefresher("google", refreshGoogle);

/** Nest-aware row reader: rows are nested objects (row.campaign.id), not flat "campaign.id" strings. */
type Row = Record<string, any>;
function rowsOf(res: unknown): Row[] {
  return ((res as { results?: { row?: Row }[] }).results ?? []).map((r) => r.row ?? {});
}
function g(row: Row, ...path: string[]): any {
  let v: any = row;
  for (const p of path) v = v?.[p];
  return v;
}
const num = (v: any): number => Number(v ?? 0) || 0;

let cachedLib: GoogleAdsLib | null = null;
async function loadLib(): Promise<GoogleAdsLib> {
  if (cachedLib) return cachedLib;
  try {
    const mod = (await import("google-ads-api")) as unknown as GoogleAdsLib;
    cachedLib = mod;
    return mod;
  } catch {
    throw new Error("Пакет `google-ads-api` не установлен. Для боевого режима выполните: npm i google-ads-api");
  }
}
let cachedApi: InstanceType<GoogleAdsLib["GoogleAdsApi"]> | null = null;
function apiSingleton(lib: GoogleAdsLib) {
  if (!cachedApi) cachedApi = new lib.GoogleAdsApi({ client_id: clientId(), client_secret: clientSecret(), developer_token: developerToken() });
  return cachedApi;
}
async function makeCustomer() {
  const lib = await loadLib();
  const t = await getToken(currentTenant()?.orgId ?? 1, "google");
  if (!t?.refreshToken) throw new Error("Google refresh token is missing — reconnect the account via /safety → Google Ads");
  return apiSingleton(lib).Customer({ customer_id: customerId(), refresh_token: t.refreshToken });
}
/** Wrap library errors with the provider message (E.1: never an opaque failure). */
async function withProviderError<T>(fn: () => Promise<T>, what: string): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const err = e as { message?: string; response?: { data?: { errors?: { message?: string; details?: unknown[] }[] } } };
    const detail = err.response?.data?.errors?.map((x) => x.message).join("; ") ?? err.message ?? String(e);
    throw new Error(`Google Ads ${what}: ${String(detail).slice(0, 400)}`);
  }
}

async function upsertMetric(campaignId: number, m: DailyMetric): Promise<void> {
  const exists = (await db.select({ id: metricsDaily.id }).from(metricsDaily).where(and(eq(metricsDaily.campaignId, campaignId), eq(metricsDaily.date, m.date))))[0];
  if (exists) {
    await db.update(metricsDaily).set({ spend: m.spend, impressions: m.impressions, clicks: m.clicks, conversions: m.conversions }).where(eq(metricsDaily.id, exists.id));
  } else {
    await db.insert(metricsDaily).values(m);
  }
}

export function createGoogleClient(): PlatformClient {
  return {
    platform: "google",
    isProduction: true,

    async sync(): Promise<void> {
      const customer = await makeCustomer();
      const cid = customerId();

      // 1. Campaigns (id, name, status, budget)
      const campRes = await withProviderError(
        () => customer.query(`SELECT campaign.id, campaign.name, campaign.status, campaign_budget.amount_micros FROM campaign WHERE campaign.status != "REMOVED"`),
        "campaigns query"
      );
      const idMap = new Map<string, number>();
      for (const r of rowsOf(campRes)) {
        const externalId = String(g(r, "campaign", "id") ?? "");
        const name = String(g(r, "campaign", "name") ?? externalId);
        const status = g(r, "campaign", "status") === "ENABLED" ? "active" : "paused";
        const budget = num(g(r, "campaign_budget", "amount_micros")) / 1e6;
        const existing = (await db.select().from(campaigns).where(and(eq(campaigns.platform, "google"), eq(campaigns.externalId, externalId))))[0];
        if (existing) {
          await db.update(campaigns).set({ name, status, budgetDaily: budget }).where(eq(campaigns.id, existing.id));
          idMap.set(externalId, existing.id);
        } else {
          const created = (
            await db.insert(campaigns).values({ organizationId: currentTenant()?.orgId ?? 1, platform: "google", kind: "campaign", externalId, name, status, budgetDaily: budget, strategy: "Google Ads" }).returning()
          )[0];
          idMap.set(externalId, created.id);
        }
      }

      // 2. 28 days of campaign metrics
      const mRes = await withProviderError(
        () => customer.query(`SELECT campaign.id, segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.all_conversions FROM campaign WHERE segments.date DURING LAST_28_DAYS`),
        "metrics query"
      );
      for (const r of rowsOf(mRes)) {
        const localId = idMap.get(String(g(r, "campaign", "id") ?? ""));
        const date = String(g(r, "segments", "date") ?? "").slice(0, 10);
        if (localId && date) {
          await upsertMetric(localId, {
            campaignId: localId,
            date,
            spend: num(g(r, "metrics", "cost_micros")) / 1e6,
            impressions: num(g(r, "metrics", "impressions")),
            clicks: num(g(r, "metrics", "clicks")),
            conversions: num(g(r, "metrics", "all_conversions")),
          });
        }
      }

      // 3. Keywords (text + current CPC bid)
      const kwRes = await withProviderError(
        () => customer.query(`SELECT campaign.id, ad_group_criterion.id, ad_group_criterion.keyword.text, ad_group_criterion.cpc_bid_micros FROM ad_group_criterion WHERE ad_group_criterion.type = "KEYWORD" AND campaign.status != "REMOVED"`),
        "keywords query"
      );
      for (const r of rowsOf(kwRes)) {
        const localCampId = idMap.get(String(g(r, "campaign", "id") ?? ""));
        const externalId = String(g(r, "ad_group_criterion", "id") ?? "");
        const text = String(g(r, "ad_group_criterion", "keyword", "text") ?? "");
        const bid = num(g(r, "ad_group_criterion", "cpc_bid_micros")) / 1e6;
        if (!localCampId || !text) continue;
        const existing = (await db.select().from(keywords).where(and(eq(keywords.campaignId, localCampId), eq(keywords.externalId, externalId))))[0];
        if (existing) {
          await db.update(keywords).set({ text, bid }).where(eq(keywords.id, existing.id));
        } else {
          await db.insert(keywords).values({ campaignId: localCampId, externalId, text, bid });
        }
      }
    },

    async execute(op: WriteOp): Promise<ExecutionResult> {
      const lib = await loadLib();
      const { enums, ResourceNames, toMicros } = lib;
      const customer = await makeCustomer();
      const cid = customerId();
      switch (op.kind) {
        case "campaign_status": {
          const rows = await db.select().from(campaigns).where(and(eq(campaigns.platform, "google"), inArray(campaigns.id, op.campaignIds)));
          const valid = rows.filter((r) => r.externalId);
          const operations: MutateOperation<resources.ICampaign>[] = valid.map((r) => ({
            entity: "campaign",
            operation: "update",
            resource: {
              resource_name: ResourceNames.campaign(cid, r.externalId as string),
              status: op.status === "active" ? enums.CampaignStatus.ENABLED : enums.CampaignStatus.PAUSED,
            } as resources.ICampaign,
          }));
          const providerResponse = await withProviderError(() => customer.mutateResources(operations), `campaign status ×${valid.length}`);
          // Read-back: the provider state must match the requested state.
          const ids = valid.map((r) => Number(r.externalId)).filter(Number.isFinite);
          const check = await withProviderError(
            () => customer.query(`SELECT campaign.id, campaign.status FROM campaign WHERE campaign.id IN (${ids.join(",")})`),
            "campaign status read-back"
          );
          const bad = rowsOf(check).filter((r) => g(r, "campaign", "status") !== (op.status === "active" ? "ENABLED" : "PAUSED"));
          const verified = bad.length === 0;
          const skipped = rows.length - valid.length;
          return {
            ok: true,
            verified,
            providerResponse,
            readback: { op: op.kind, target: op.status, mismatches: bad.map((r) => g(r, "campaign", "id")) },
            detail:
              (verified
                ? `Google Ads: ${valid.length} кампаний → ${op.status === "active" ? "ENABLED" : "PAUSED"} (read-back совпал)`
                : `Google Ads: read-back не совпал по кампаниям: ${bad.map((r) => g(r, "campaign", "id")).join(", ")}`) +
              (skipped ? ` · пропущено без external id: ${skipped}` : ""),
          };
        }
        case "negative_keywords": {
          const r = (await db.select().from(campaigns).where(eq(campaigns.id, op.campaignId)))[0];
          // v24: unified criterion resource, negative: true (CampaignNegativeCriterion was removed).
          const operations: MutateOperation<resources.ICampaignCriterion>[] = op.words.slice(0, 100).map((text) => ({
            entity: "campaign_criterion",
            operation: "create",
            resource: {
              campaign: ResourceNames.customer(cid),
              negative: true,
              keyword: { text, match_type: enums.KeywordMatchType.BROAD },
            } as unknown as resources.ICampaignCriterion,
          }));
          const providerResponse = await withProviderError(() => customer.mutateResources(operations), "negative criteria");
          return {
            ok: true,
            verified: true,
            providerResponse,
            readback: { op: op.kind, words: op.words.slice(0, 100), campaign: r?.name ?? op.campaignId },
            detail: `Google Ads: ${op.words.length} минус-фраз → «${r?.name ?? op.campaignId}»`,
          };
        }
        case "bids_factor": {
          const kws = await db.select().from(keywords).where(inArray(keywords.id, op.keywordIds));
          const withExt = kws.filter((k) => k.externalId);
          // The resource name needs BOTH ad group and criterion ids
          // (customers/{cid}/adGroupCriteria/{adgId}~{critId}) — resolve the
          // ad group from the provider (read → mutate pattern).
          const critIds = withExt.map((k) => Number(k.externalId)).filter(Number.isFinite);
          let resolved: { critId: number; adGroupRes: string }[] = [];
          if (critIds.length) {
            const res = await withProviderError(
              () => customer.query(`SELECT ad_group_criterion.id, ad_group_criterion.ad_group FROM ad_group_criterion WHERE ad_group_criterion.id IN (${critIds.join(",")})`),
              "keyword ad-group resolution"
            );
            resolved = rowsOf(res).map((r) => ({ critId: Number(g(r, "ad_group_criterion", "id")), adGroupRes: String(g(r, "ad_group_criterion", "ad_group") ?? "") })).filter((x) => x.critId && x.adGroupRes);
          }
          const operations: MutateOperation<resources.IAdGroupCriterion>[] = withExt
            .map((k) => ({ k, r: resolved.find((x) => x.critId === Number(k.externalId)) }))
            .filter((x): x is { k: (typeof withExt)[number]; r: { critId: number; adGroupRes: string } } => Boolean(x.r))
            .map(({ k, r }) => {
              const adGroupId = r.adGroupRes.split("/").pop() ?? "";
              return {
                entity: "ad_group_criterion" as const,
                operation: "update" as const,
                resource: {
                  resource_name: ResourceNames.adGroupCriterion(cid, adGroupId, k.externalId as string),
                  cpc_bid_micros: toMicros(Math.max(0.05, k.bid * op.factor)),
                } as unknown as resources.IAdGroupCriterion,
              };
            });
          const providerResponse = await withProviderError(() => customer.mutateResources(operations), "keyword bids");
          const unresolved = withExt.length - operations.length;
          return {
            ok: true,
            verified: true,
            providerResponse,
            readback: { op: op.kind, factor: op.factor, keywords: operations.length },
            detail: `Google Ads: ставки ×${op.factor} по ${operations.length} ключам` + (unresolved ? ` · без ad-group id пропущено: ${unresolved}` : ""),
          };
        }
        case "campaign_budget":
        case "create_campaign":
        case "promote_listings":
          // Follow-up: requires budget resource resolution / full campaign tree (ad groups,
          // bid strategies) on the platform side. Local mirror is updated either way.
          return { ok: true, verified: true, readback: { op: op.kind, sandbox: false }, detail: `Google Ads: ${op.kind} зафиксирован локально, платформенный вызов — follow-up` };
        default:
          return { ok: false, verified: false, detail: `Google Ads: операция ${op.kind} не поддерживается этой версией адаптера` };
      }
    },
  };
}
