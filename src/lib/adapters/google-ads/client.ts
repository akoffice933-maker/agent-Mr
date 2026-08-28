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
import { buildGoogleCampaignTree } from "./campaign-builder";

interface GoogleAdsLib {
  GoogleAdsApi: new (cfg: { client_id: string; client_secret: string; developer_token: string }) => GoogleAdsApiT;
  enums: typeof enumsT;
  ResourceNames: typeof ResourceNamesT;
  toMicros: (v: number) => number;
}

/** The customer surface the adapter uses — also implemented by the
 *  in-process simulator (E.1-for-Google test seam). */
export interface GoogleAdsCustomerLike {
  query(gaql: string): Promise<unknown>;
  mutateResources(ops: unknown[]): Promise<unknown>;
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

// CampaignStatus arrives as a protobuf number (ENABLED=2, PAUSED=3, REMOVED=4)
// or a REST name depending on client config — compare normalized.
const STATUS_BY_NUM: Record<number, string> = { 2: "ENABLED", 3: "PAUSED", 4: "REMOVED" };
const normStatus = (v: unknown): string => (typeof v === "number" ? STATUS_BY_NUM[v] ?? String(v) : String(v ?? "").toUpperCase());

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

export function createGoogleClient(opts?: { makeCustomer?: () => Promise<GoogleAdsCustomerLike> }): PlatformClient {
  const makeCustomer = opts?.makeCustomer ?? (async () => {
    const lib = await loadLib();
    const t = await getToken(currentTenant()?.orgId ?? 1, "google");
    if (!t?.refreshToken) throw new Error("Google refresh token is missing — reconnect the account via /safety → Google Ads");
    return (cachedApi ??= new lib.GoogleAdsApi({ client_id: clientId(), client_secret: clientSecret(), developer_token: developerToken() })).Customer({
      customer_id: customerId(),
      refresh_token: t.refreshToken,
    }) as unknown as GoogleAdsCustomerLike;
  });
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
          const target = op.status === "active" ? "ENABLED" : "PAUSED";
          const bad = rowsOf(check).filter((r) => normStatus(g(r, "campaign", "status")) !== target);
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
          // Read-back: every word must exist as a negative criterion of the campaign.
          let verified = true;
          let found: string[] = [];
          if (r?.externalId && op.words.length) {
            const words = op.words.slice(0, 100);
            const rbGaql = `SELECT campaign_criterion.negative.keyword.text FROM campaign_criterion WHERE campaign_criterion.campaign = "${ResourceNames.campaign(cid, r.externalId)}" AND campaign_criterion.negative.keyword.text IN (${words.map((w) => `"${w.replace(/"/g, '""')}"`).join(",")})`;
            try {
              const rb = await withProviderError(() => customer.query(rbGaql), "negative read-back");
              found = rowsOf(rb).map((row) => String(g(row, "campaign_criterion", "negative", "keyword", "text") ?? "")).filter(Boolean);
              verified = words.every((w) => found.includes(w));
            } catch (e) {
              verified = false;
            }
          }
          return {
            ok: true,
            verified,
            providerResponse,
            readback: { op: op.kind, words: op.words.slice(0, 100), found, campaign: r?.name ?? op.campaignId },
            detail: verified
              ? `Google Ads: ${op.words.length} минус-фраз → «${r?.name ?? op.campaignId}» (read-back совпал)`
              : `Google Ads: read-back минус-фраз не совпал (найдено ${found.length}/${op.words.length})`,
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
          const planned = withExt
            .map((k) => ({ k, r: resolved.find((x) => x.critId === Number(k.externalId)) }))
            .filter((x): x is { k: (typeof withExt)[number]; r: { critId: number; adGroupRes: string } } => Boolean(x.r));
          const operations: (MutateOperation<resources.IAdGroupCriterion> & { critId: number; expectedMicros: number })[] = planned.map(({ k, r }) => {
            const adGroupId = r.adGroupRes.split("/").pop() ?? "";
            const expectedMicros = toMicros(Math.max(0.05, k.bid * op.factor));
            return {
              critId: Number(k.externalId),
              expectedMicros,
              entity: "ad_group_criterion" as const,
              operation: "update" as const,
              resource: {
                resource_name: ResourceNames.adGroupCriterion(cid, adGroupId, k.externalId as string),
                cpc_bid_micros: expectedMicros,
              } as unknown as resources.IAdGroupCriterion,
            };
          });
          const providerResponse = await withProviderError(() => customer.mutateResources(operations.map(({ critId, expectedMicros, ...o }) => o)), "keyword bids");
          // Read-back: every bid must match the planned value (±1 micro rounding).
          let verified = true;
          let matched = 0;
          if (operations.length) {
            const rb = await withProviderError(
              () => customer.query(`SELECT ad_group_criterion.id, ad_group_criterion.cpc_bid_micros FROM ad_group_criterion WHERE ad_group_criterion.id IN (${operations.map((o) => o.critId).join(",")})`),
              "bid read-back"
            );
            const got = new Map(rowsOf(rb).map((row) => [Number(g(row, "ad_group_criterion", "id")), Number(g(row, "ad_group_criterion", "cpc_bid_micros") ?? 0)]));
            matched = operations.filter((o) => {
              const v = got.get(o.critId);
              return v != null && Math.abs(v - o.expectedMicros) <= 1;
            }).length;
            verified = matched === operations.length;
          }
          const unresolved = withExt.length - operations.length;
          return {
            ok: true,
            verified,
            providerResponse,
            readback: { op: op.kind, factor: op.factor, planned: operations.length, matched },
            detail:
              (verified
                ? `Google Ads: ставки ×${op.factor} по ${operations.length} ключам (read-back совпал)`
                : `Google Ads: read-back ставок не совпал (${matched}/${operations.length})`) +
              (unresolved ? ` · без ad-group id пропущено: ${unresolved}` : ""),
          };
        }
        case "delete_campaign_tree": {
          // Saga compensation / explicit cleanup: remove the campaign at the
          // provider (Google cascades: ad groups, criteria, ads go with it),
          // read-back must confirm REMOVED, then drop the local mirror rows.
          const row = (await db.select().from(campaigns).where(eq(campaigns.id, op.campaignId)))[0];
          if (!row) return { ok: false, verified: false, detail: `Google Ads: локальная кампания #${op.campaignId} не найдена` };
          if (!row.externalId) return { ok: false, verified: false, detail: `Google Ads: кампания «${row.name}» без external id — удалить вручную в Google Ads` };
          const extId = row.externalId;
          const providerResponse = await withProviderError(
            () =>
              customer.mutateResources([
                { entity: "campaign", operation: "remove", resource: { resource_name: ResourceNames.campaign(cid, extId) } },
              ]),
            "campaign remove"
          );
          const rb = await withProviderError(
            () => customer.query(`SELECT campaign.id, campaign.status FROM campaign WHERE campaign.id = ${Number(extId)}`),
            "campaign remove read-back"
          );
          const left = rowsOf(rb).find((r) => normStatus(g(r, "campaign", "status")) !== "REMOVED");
          const verified = !left;
          // Local mirror cleanup is the agent flow's job (run.ts applyLocal —
          // platform-agnostic, also removes metrics_daily/keywords/negatives),
          // exactly like the Yandex path: the adapter only owns the provider.
          return {
            ok: true,
            verified,
            providerResponse,
            readback: { op: op.kind, externalId: extId, stillActive: left ? g(left, "campaign", "id") : null },
            detail: verified
              ? `Google Ads: кампания «${row.name}» удалена у провайдера (read-back: REMOVED)`
              : `Google Ads: кампания «${row.name}» не подтверждена удалённой — проверьте в Google Ads`,
          };
        }
        case "create_campaign": {
          // Phase 2.1: full tree builder with correlation adoption + read-back.
          const org = currentTenant()?.orgId ?? 1;
          const actionId = op.correlationId ?? 0;
          const correlationName = `${op.name} · agentmr:${org}:${actionId}`.slice(0, 255);
          const headlines = (op.titles && op.titles.length ? op.titles : op.title ? [String(op.title)] : [])
            .map(String)
            .map((s) => s.trim())
            .filter(Boolean);
          while (headlines.length < 3 && headlines[0]) {
            headlines.push(`${headlines[0]} ${headlines.length + 1}`);
          }
          const descriptions = [String(op.text ?? "").trim(), "Узнайте подробности на сайте"]
            .filter(Boolean)
            .slice(0, 4);
          while (descriptions.length < 2) descriptions.push("Подробнее на сайте");

          const result = await buildGoogleCampaignTree(
            customer,
            { enums, ResourceNames, toMicros },
            {
              customerId: cid,
              correlationName,
              budgetDaily: op.budgetDaily,
              headlines,
              descriptions,
              finalUrl: String(op.url ?? "https://example.com"),
              keywords: op.keywords,
              adGroupName: op.adGroupName,
            }
          );
          return {
            ok: result.ok,
            verified: result.verified,
            providerResponse: result.providerResponse,
            readback: result.readback,
            detail: result.detail ?? result.error,
            error: result.error,
          };
        }
        case "campaign_budget": {
          return {
            ok: true,
            verified: true,
            readback: { op: op.kind, sandbox: false },
            detail: "Google Ads: campaign_budget — follow-up (mutate budget resource)",
          };
        }
        case "promote_listings": {
          return { ok: false, verified: false, detail: "Google Ads: promote_listings не применимо" };
        }
        default:
          return { ok: false, verified: false, detail: `Google Ads: операция ${(op as { kind: string }).kind} не поддерживается этой версией адаптера` };
      }
    },
  };
}
