// Google Ads adapter — real API via the official `google-ads` Node client (gRPC/GAQL).
// Production path: requires OAuth refresh token (see /api/oauth/google) + developer token.
// The `google-ads` package is an OPTIONAL dependency (heavy) — install it only for
// production use: `npm i google-ads`. Sandbox mode never touches this file.

import { and, eq, inArray } from "drizzle-orm";
import { db, currentTenant } from "@/db";
import { campaigns, keywords, metricsDaily } from "@/db/schema";
import { registerRefresher, storeToken, getToken, type StoredToken } from "../oauth-store";
import type { DailyMetric, PlatformClient, WriteOp, WriteResult } from "../types";

const OAUTH = "https://oauth2.googleapis.com";
const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";

function clientId(): string {
  const v = process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (!v) throw new Error("GOOGLE_OAUTH_CLIENT_ID is not set");
  return v;
}
function clientSecret(): string {
  const v = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!v) throw new Error("GOOGLE_OAUTH_CLIENT_SECRET is not set");
  return v;
}
function developerToken(): string {
  const v = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!v) throw new Error("GOOGLE_ADS_DEVELOPER_TOKEN is not set");
  return v;
}
function customerId(): string {
  const v = process.env.GOOGLE_ADS_CUSTOMER_ID;
  if (!v) throw new Error("GOOGLE_ADS_CUSTOMER_ID is not set (10-digit id without dashes)");
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
  if (!res.ok) throw new Error(`Google token error ${res.status}: ${await res.text()}`);
  const d = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
  return {
    accessToken: d.access_token,
    refreshToken: d.refresh_token, // Google returns refresh_token on first authorization only
    expiresAt: d.expires_in ? new Date(Date.now() + d.expires_in * 1000) : undefined,
  };
}

export async function googleExchangeCode(code: string): Promise<StoredToken> {
  const t = await requestToken("authorization_code", { code, redirect_uri: redirectUri() });
  await storeToken("google", t);
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

let cachedLib: { GoogleAdsClient: new (cfg: Record<string, string>) => any } | null = null;
async function loadGoogleAds() {
  if (cachedLib) return cachedLib;
  let mod: unknown;
  try {
    // Variable-based import: keeps the bundler from resolving the optional
    // `google-ads` package at build time (it is installed only for production).
    const moduleName = "google-ads";
    mod = await import(/* webpackIgnore: true */ moduleName);
  } catch {
    throw new Error("Пакет `google-ads` не установлен. Для боевого режима выполните: npm i google-ads");
  }
  cachedLib = mod as { GoogleAdsClient: new (cfg: Record<string, string>) => any };
  return cachedLib;
}

async function makeClient() {
  const lib = await loadGoogleAds();
  const t = await getToken("google");
  if (!t) throw new Error("Google token is missing or expired — reconnect the account");
  return new lib.GoogleAdsClient({
    developerToken: developerToken(),
    clientId: clientId(),
    clientSecret: clientSecret(),
    refreshToken: t.refreshToken ?? t.accessToken,
    customerId: customerId(),
  });
}

async function upsertMetric(campaignId: number, m: DailyMetric): Promise<void> {
  const exists = (
    await db.select({ id: metricsDaily.id }).from(metricsDaily).where(and(eq(metricsDaily.campaignId, campaignId), eq(metricsDaily.date, m.date)))
  )[0];
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
      const client = await makeClient();
      const cid = customerId();

      const campRows = (await client.getGoogleAdsService().search(
        "SELECT campaign.id, campaign.name, campaign.status, campaign.campaign_budget.amount_micros FROM campaign"
      )) as Record<string, string>[];
      const idMap = new Map<string, number>();
      for (const r of campRows) {
        const externalId = String(r["campaign.id"]);
        const name = String(r["campaign.name"]);
        const status = r["campaign.status"] === "ENABLED" ? "active" : "paused";
        const budget = Number(r["campaign.campaign_budget.amount_micros"] ?? 0) / 1e6;
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

      const metricRows = (await client.getGoogleAdsService().search(
        "SELECT campaign.id, segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions.value FROM campaign WHERE segments.date DURING LAST_28_DAYS"
      )) as Record<string, string>[];
      for (const r of metricRows) {
        const localId = idMap.get(String(r["campaign.id"]));
        const date = String(r["segments.date"] ?? "").slice(0, 10);
        if (localId && date) {
          await upsertMetric(localId, {
            campaignId: localId,
            date,
            spend: Number(r["metrics.cost_micros"] ?? 0) / 1e6,
            impressions: Number(r["metrics.impressions"] ?? 0),
            clicks: Number(r["metrics.clicks"] ?? 0),
            conversions: Number(r["metrics.conversions.value"] ?? 0),
          });
        }
      }

      const kwRows = (await client.getGoogleAdsService().search(
        "SELECT ad_group_criterion.id, ad_group_criterion.keyword.text, campaign.id, ad_group_criterion_cpc_bid.current_cpc_bid_micros FROM ad_group_criterion WHERE ad_group_criterion.type = 'KEYWORD'"
      )) as Record<string, string>[];
      for (const r of kwRows) {
        const localCampId = idMap.get(String(r["campaign.id"]));
        const externalId = String(r["ad_group_criterion.id"]);
        const text = String(r["ad_group_criterion.keyword.text"] ?? "");
        const bid = Number(r["ad_group_criterion_cpc_bid.current_cpc_bid_micros"] ?? 0) / 1e6;
        if (!localCampId || !text) continue;
        const existing = (await db.select().from(keywords).where(and(eq(keywords.campaignId, localCampId), eq(keywords.externalId, externalId))))[0];
        if (existing) {
          await db.update(keywords).set({ text, bid }).where(eq(keywords.id, existing.id));
        } else {
          await db.insert(keywords).values({ campaignId: localCampId, externalId, text, bid });
        }
      }
      void cid;
    },

    async write(op: WriteOp): Promise<WriteResult> {
      const client = await makeClient();
      const cid = customerId();
      const kind = op.kind as string;
      switch (op.kind) {
        case "campaign_status": {
          const rows = await db.select().from(campaigns).where(and(eq(campaigns.platform, "google"), inArray(campaigns.id, op.campaignIds)));
          await client.getCampaignService().mutateCampaigns(
            cid,
            rows.map((r) => ({
              operate: r.status === op.status ? "DO_NOTHING" : op.status === "active" ? "ENABLE" : "PAUSE",
              resourceNames: [`customers/${cid}/campaigns/${r.externalId}`],
            }))
          );
          return { ok: true, detail: `Google Ads: ${rows.length} кампаний → ${op.status}` };
        }
        case "negative_keywords": {
          const r = (await db.select().from(campaigns).where(eq(campaigns.id, op.campaignId)))[0];
          await client.getCampaignNegativeCriterionService().mutateCampaignNegativeCriteria(
            cid,
            op.words.map((text) => ({
              operate: "ADD",
              campaignNegativeCriterion: { campaign: `customers/${cid}`, negative: { keyword: { text } } },
            }))
          );
          return { ok: true, detail: `Google Ads: ${op.words.length} минус-фраз → «${r?.name}»` };
        }
        case "bids_factor": {
          const kws = await db.select().from(keywords).where(inArray(keywords.id, op.keywordIds));
          await client.getCriterionService().mutateCriteria(
            cid,
            kws.map((k) => ({
              operate: "UPDATE",
              criterion: { keyword: { text: k.text } },
              criterionBid: { cpcBidMicros: Math.max(5, Math.round(k.bid * op.factor * 1e6)) },
              resourceNames: k.externalId ? [`customers/${cid}/adGroupCriteria/${k.externalId}`] : undefined,
            }))
          );
          return { ok: true, detail: `Google Ads: ставки ×${op.factor} по ${kws.length} ключам` };
        }
        case "campaign_budget":
        case "create_campaign":
        case "promote_listings":
          // Follow-up: requires budget resource resolution / full campaign tree (ad groups,
          // bid strategies) on the platform side. Local mirror is updated either way.
          return { ok: true, detail: `Google Ads: ${kind} зафиксирован локально, платформенный вызов — follow-up` };
        default:
          return { ok: false, detail: `Google Ads: операция ${kind} не поддерживается этой версией адаптера` };
      }
    },
  };
}
