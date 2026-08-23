// Yandex Direct adapter — real API (Директ API v5) + mirror sync (ТЗ 8.2).
// Production path: requires Yandex OAuth token (see /api/oauth/yandex).
// Field names follow Direct API v5 docs; on first production connect verify
// them against the live API (sandbox mode never hits this code).

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { campaigns, keywords, metricsDaily } from "@/db/schema";
import { registerRefresher, storeToken, getToken, type StoredToken } from "../oauth-store";
import type { DailyMetric, PlatformClient, WriteOp, WriteResult } from "../types";

const API = "https://api.direct.yandex.ru";
const OAUTH = "https://oauth.yandex.ru";

function clientId(): string {
  const v = process.env.YANDEX_OAUTH_CLIENT_ID;
  if (!v) throw new Error("YANDEX_OAUTH_CLIENT_ID is not set");
  return v;
}
function clientSecret(): string {
  const v = process.env.YANDEX_OAUTH_CLIENT_SECRET;
  if (!v) throw new Error("YANDEX_OAUTH_CLIENT_SECRET is not set");
  return v;
}
function redirectUri(): string {
  return `${process.env.PUBLIC_URL ?? "http://localhost:3000"}/api/oauth/yandex`;
}

export function yandexAuthUrl(state: string): string {
  const p = new URLSearchParams({
    response_type: "code",
    client_id: clientId(),
    redirect_uri: redirectUri(),
    state,
    locale: "ru",
  });
  return `${OAUTH}/authorize?${p.toString()}`;
}

async function requestToken(grantType: string, params: Record<string, string>): Promise<StoredToken> {
  const body = new URLSearchParams({ grant_type: grantType, client_id: clientId(), client_secret: clientSecret(), ...params });
  const res = await fetch(`${OAUTH}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!res.ok) throw new Error(`Yandex token error ${res.status}: ${await res.text()}`);
  const d = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
  return {
    accessToken: d.access_token,
    refreshToken: d.refresh_token,
    expiresAt: d.expires_in ? new Date(Date.now() + d.expires_in * 1000) : undefined,
  };
}

export async function yandexExchangeCode(code: string): Promise<StoredToken> {
  const t = await requestToken("authorization_code", { code, redirect_uri: redirectUri() });
  await storeToken("yandex", t);
  return t;
}

async function refreshYandex(_current: StoredToken | null): Promise<StoredToken> {
  const t = await getToken("yandex", false);
  if (!t?.refreshToken) throw new Error("No Yandex refresh token stored — reconnect the account");
  return requestToken("refresh_token", { refresh_token: t.refreshToken });
}

registerRefresher("yandex", refreshYandex);

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const t = await getToken("yandex");
  if (!t) throw new Error("Yandex token is missing or expired — reconnect the account");
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `OAuth ${t.accessToken}`,
      "Direct-Version": "5",
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`Direct API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

const STATUS_TO_API: Record<string, string> = { active: "ON", paused: "PAUSED" };
const API_TO_STATUS: Record<string, "active" | "paused"> = { ON: "active", PAUSED: "paused" };

async function upsertCampaign(row: Record<string, unknown>): Promise<void> {
  const externalId = String(row.campaignId);
  const name = String(row.campaignName ?? row.name ?? externalId);
  const status = API_TO_STATUS[String(row.status)] ?? "active";
  const budget = Number(row.dailyBudget ?? 0);
  const existing = (await db.select().from(campaigns).where(and(eq(campaigns.platform, "yandex"), eq(campaigns.externalId, externalId))))[0];
  if (existing) {
    await db.update(campaigns).set({ name, status, budgetDaily: budget }).where(eq(campaigns.id, existing.id));
  } else {
    await db.insert(campaigns).values({ platform: "yandex", kind: "campaign", externalId, name, status, budgetDaily: budget, strategy: "Direct" });
  }
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

export function createYandexClient(): PlatformClient {
  return {
    platform: "yandex",
    isProduction: true,

    async sync(): Promise<void> {
      // 1. Campaigns
      const camps = (await api("/v5/campaigns?campaignFields=campaignId,campaignName,status,dailyBudget")) as {
        result?: Record<string, unknown>[];
      };
      for (const c of camps.result ?? []) await upsertCampaign(c);
      const local = await db.select().from(campaigns).where(eq(campaigns.platform, "yandex"));
      const idMap = new Map(local.map((r) => [r.externalId, r.id]));
      // 2. Click stats (spend, clicks) + impressions, last 28 days
      const to = new Date().toISOString().slice(0, 10);
      const from = new Date(Date.now() - 27 * 86400000).toISOString().slice(0, 10);
      const range = `date_from=${from}&date_to=${to}`;
      const clicks = (await api(`/v5/campaigns/clicks?${range}&campaignFields=campaignId,date,clicks,spend`)) as {
        result?: Record<string, unknown>[];
      };
      const imps = (await api(`/v5/campaigns/impressions?${range}&campaignFields=campaignId,date,impressions`)) as {
        result?: Record<string, unknown>[];
      };
      const byDay = new Map<string, { spend: number; clicks: number; impressions: number }>();
      const bump = (key: string, patch: Partial<{ spend: number; clicks: number; impressions: number }>) => {
        const cur = byDay.get(key) ?? { spend: 0, clicks: 0, impressions: 0 };
        cur.spend += patch.spend ?? 0;
        cur.clicks += patch.clicks ?? 0;
        cur.impressions += patch.impressions ?? 0;
        byDay.set(key, cur);
      };
      for (const r of clicks.result ?? []) bump(`${r.campaignId}|${r.date}`, { spend: Number(r.spend ?? 0), clicks: Number(r.clicks ?? 0) });
      for (const r of imps.result ?? []) bump(`${r.campaignId}|${r.date}`, { impressions: Number(r.impressions ?? 0) });
      for (const [key, v] of byDay) {
        const [extId, date] = key.split("|");
        const localId = idMap.get(extId);
        if (localId) await upsertMetric(localId, { campaignId: localId, date, spend: v.spend, impressions: v.impressions, clicks: v.clicks, conversions: 0 });
      }
      // Conversions come from Яндекс.Метрика (separate integration) — TODO (ТЗ 8.2).
    },

    async write(op: WriteOp): Promise<WriteResult> {
      switch (op.kind) {
        case "campaign_status": {
          const rows = await db.select().from(campaigns).where(and(eq(campaigns.platform, "yandex"), inArray(campaigns.id, op.campaignIds)));
          await api("/v5/campaigns/statuses", {
            method: "POST",
            body: JSON.stringify({ campaigns: rows.map((r) => ({ campaignId: Number(r.externalId), status: STATUS_TO_API[op.status] })) }),
          });
          return { ok: true, detail: `Direct: статус ${rows.length} кампаний → ${op.status}` };
        }
        case "campaign_budget": {
          const r = (await db.select().from(campaigns).where(eq(campaigns.id, op.campaignId)))[0];
          await api("/v5/campaigns/budgets", {
            method: "POST",
            body: JSON.stringify({ campaigns: [{ campaignId: Number(r?.externalId), dailyBudget: op.budgetDaily }] }),
          });
          return { ok: true, detail: `Direct: бюджет «${r?.name}» → ${op.budgetDaily} ₽/день` };
        }
        case "negative_keywords": {
          const r = (await db.select().from(campaigns).where(eq(campaigns.id, op.campaignId)))[0];
          await api("/v5/campaigns/negativeKeywords", {
            method: "POST",
            body: JSON.stringify({
              negativeKeywords: op.words.map((text) => ({ campaignId: Number(r?.externalId), negativeKeyword: { text }, status: "ACTIVE" })),
            }),
          });
          return { ok: true, detail: `Direct: ${op.words.length} минус-фраз → «${r?.name}»` };
        }
        case "bids_factor": {
          const kws = await db.select().from(keywords).where(inArray(keywords.id, op.keywordIds));
          await api("/v5/keywords/bids", {
            method: "POST",
            body: JSON.stringify({
              keywords: kws.map((k) => ({ keywordId: Number(k.externalId ?? k.id), bid: Math.max(1, Math.round(k.bid * op.factor * 10) / 10) })),
            }),
          });
          return { ok: true, detail: `Direct: ставки ×${op.factor} по ${kws.length} ключам` };
        }
        default:
          return { ok: false, detail: `Direct: операция ${op.kind} не поддерживается этой версией адаптера` };
      }
    },
  };
}
