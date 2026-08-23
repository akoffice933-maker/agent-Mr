// Yandex Direct adapter — production client (Директ API v5) + mirror sync.
// Production path: requires Yandex OAuth token (see /api/oauth/yandex and
// docs/YANDEX_SETUP.md). Field names follow Direct API v5 docs; on first
// production connect verify them against the live API.
// Conversions are merged from Yandex.Metrica (metrika.ts) — without Metrica
// the CPA column stays empty (documented).

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { campaigns, keywords, metricsDaily, negativeKeywords } from "@/db/schema";
import { registerRefresher, storeToken, getToken, type StoredToken } from "../oauth-store";
import { fetchDailyConversions, isMetrikaConfigured } from "./metrika";
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

interface ApiError {
  message?: string;
  errors?: { type?: string; message?: string }[];
}

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
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as ApiError;
      detail = j.errors?.map((e) => `${e.type}: ${e.message}`).join("; ") || j.message || detail;
    } catch { /* keep raw */ }
    throw new Error(`Direct API ${res.status}: ${detail}`);
  }
  return text ? JSON.parse(text) : null;
}

const STATUS_TO_API: Record<string, string> = { active: "ON", paused: "PAUSED" };
const API_TO_STATUS: Record<string, "active" | "paused"> = { ON: "active", PAUSED: "paused" };

const SYNC_DAYS = 28;

async function syncCampaigns(): Promise<Map<string, number>> {
  const camps = (await api("/v5/campaigns?campaignFields=campaignId,campaignName,status,dailyBudget,campaignType")) as {
    result?: Record<string, unknown>[];
  };
  const idMap = new Map<string, number>();
  for (const c of camps.result ?? []) {
    const externalId = String(c.campaignId);
    const name = String(c.campaignName ?? c.campaignId);
    const status = API_TO_STATUS[String(c.status)] ?? "active";
    const budget = Number(c.dailyBudget ?? 0);
    const existing = (await db.select().from(campaigns).where(and(eq(campaigns.platform, "yandex"), eq(campaigns.externalId, externalId))))[0];
    if (existing) {
      await db.update(campaigns).set({ name, status, budgetDaily: budget }).where(eq(campaigns.id, existing.id));
      idMap.set(externalId, existing.id);
    } else {
      const row = (await db.insert(campaigns).values({ platform: "yandex", kind: "campaign", externalId, name, status, budgetDaily: budget, strategy: "Direct" }).returning())[0];
      idMap.set(externalId, row.id);
    }
  }
  return idMap;
}

async function replaceMetric(campaignId: number, m: DailyMetric): Promise<void> {
  const exists = (
    await db.select({ id: metricsDaily.id }).from(metricsDaily).where(and(eq(metricsDaily.campaignId, campaignId), eq(metricsDaily.date, m.date)))
  )[0];
  if (exists) {
    await db.update(metricsDaily).set({ spend: m.spend, impressions: m.impressions, clicks: m.clicks, conversions: m.conversions }).where(eq(metricsDaily.id, exists.id));
  } else {
    await db.insert(metricsDaily).values({ campaignId, date: m.date, spend: m.spend, impressions: m.impressions, clicks: m.clicks, conversions: m.conversions });
  }
}

export function createYandexClient(): PlatformClient {
  return {
    platform: "yandex",
    isProduction: true,

    async sync(): Promise<void> {
      const to = new Date().toISOString().slice(0, 10);
      const from = new Date(Date.now() - (SYNC_DAYS - 1) * 86400000).toISOString().slice(0, 10);
      const range = `date_from=${from}&date_to=${to}`;

      // 1. Campaigns
      const idMap = await syncCampaigns();

      // 2. Click stats (spend, clicks) + impressions per campaign per day
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
      for (const r of clicks.result ?? []) bump(`${r.campaignId}|${String(r.date).slice(0, 10)}`, { spend: Number(r.spend ?? 0), clicks: Number(r.clicks ?? 0) });
      for (const r of imps.result ?? []) bump(`${r.campaignId}|${String(r.date).slice(0, 10)}`, { impressions: Number(r.impressions ?? 0) });
      for (const [key, v] of byDay) {
        const [extId, date] = key.split("|");
        const localId = idMap.get(extId);
        if (localId && date) await replaceMetric(localId, { campaignId: localId, date, spend: v.spend, impressions: v.impressions, clicks: v.clicks, conversions: 0 });
      }

      // 3. Conversions from Metrica (per day, split across campaigns by clicks share)
      if (isMetrikaConfigured()) {
        const conv = await fetchDailyConversions(from, to);
        const convByDate = new Map<string, number>(conv.map((c) => [c.date, c.conversions]));
        if (convByDate.size) {
          // For each date, distribute the counter-level goal visits across the
          // day's Direct campaigns proportionally to their clicks.
          const dates = [...new Set([...byDay.keys()].map((k) => k.split("|")[1]))];
          for (const date of dates) {
            const total = convByDate.get(date) ?? 0;
            if (!total) continue;
            const dayRows: { localId: number; clicks: number }[] = [];
            let dayClicks = 0;
            for (const [key, v] of byDay) {
              const [extId, d] = key.split("|");
              if (d !== date) continue;
              const localId = idMap.get(extId);
              if (!localId) continue;
              dayRows.push({ localId, clicks: v.clicks });
              dayClicks += v.clicks;
            }
            if (!dayClicks) continue; // no click data for this day — skip distribution
            for (const r of dayRows) {
              const share = Math.round(total * (r.clicks / dayClicks));
              const existing = (
                await db.select({ conversions: metricsDaily.conversions }).from(metricsDaily).where(and(eq(metricsDaily.campaignId, r.localId), eq(metricsDaily.date, date)))
              )[0];
              if (existing && share) await db.update(metricsDaily).set({ conversions: (existing.conversions ?? 0) + share }).where(and(eq(metricsDaily.campaignId, r.localId), eq(metricsDaily.date, date)));
            }
          }
        }
      }

      // 4. Keywords with external ids (for bid management)
      const kw = (await api(`/v5/keywords?keywordFields=keywordId,text,bid,clicks,impressions&limit=4000&offset=0`)) as {
        result?: Record<string, unknown>[];
      };
      for (const k of kw.result ?? []) {
        const campaignId = Number(k.campaignId);
        const externalId = String(k.keywordId);
        const localCampId = idMap.get(String(campaignId));
        if (!localCampId) continue;
        const text = String(k.text ?? "");
        if (!text) continue;
        const bid = Number(k.bid ?? 0);
        const existing = (await db.select().from(keywords).where(and(eq(keywords.campaignId, localCampId), eq(keywords.externalId, externalId))))[0];
        if (existing) {
          await db.update(keywords).set({ text, bid }).where(eq(keywords.id, existing.id));
        } else {
          await db.insert(keywords).values({ campaignId: localCampId, externalId, text, bid });
        }
      }
    },

    async write(op: WriteOp): Promise<WriteResult> {
      switch (op.kind) {
        case "campaign_status": {
          const rows = await db.select().from(campaigns).where(and(eq(campaigns.platform, "yandex"), inArray(campaigns.id, op.campaignIds)));
          if (!rows.length) return { ok: false, detail: "Кампании не найдены в зеркале — выполните sync" };
          await api("/v5/campaigns/statuses", {
            method: "POST",
            body: JSON.stringify({ campaigns: rows.map((r) => ({ campaignId: Number(r.externalId), status: STATUS_TO_API[op.status] })) }),
          });
          for (const r of rows) await db.update(campaigns).set({ status: op.status }).where(eq(campaigns.id, r.id));
          return { ok: true, detail: `Direct: ${rows.length} кампаний → ${op.status} (применено на стороне Яндекса)` };
        }
        case "campaign_budget": {
          const r = (await db.select().from(campaigns).where(eq(campaigns.id, op.campaignId)))[0];
          if (!r) return { ok: false, detail: "Кампания не найдена в зеркале" };
          await api("/v5/campaigns/budgets", {
            method: "POST",
            body: JSON.stringify({ campaigns: [{ campaignId: Number(r.externalId), dailyBudget: op.budgetDaily }] }),
          });
          await db.update(campaigns).set({ budgetDaily: op.budgetDaily }).where(eq(campaigns.id, r.id));
          return { ok: true, detail: `Direct: бюджет «${r.name}» → ${op.budgetDaily} ₽/день` };
        }
        case "negative_keywords": {
          const r = (await db.select().from(campaigns).where(eq(campaigns.id, op.campaignId)))[0];
          if (!r) return { ok: false, detail: "Кампания не найдена в зеркале" };
          await api("/v5/campaigns/negativeKeywords", {
            method: "POST",
            body: JSON.stringify({
              negativeKeywords: op.words.map((text) => ({ campaignId: Number(r.externalId), negativeKeyword: { text }, status: "ACTIVE" })),
            }),
          });
          for (const w of op.words) await db.insert(negativeKeywords).values({ campaignId: op.campaignId, text: w, source: "agent" });
          return { ok: true, detail: `Direct: ${op.words.length} минус-фраз → «${r.name}»` };
        }
        case "bids_factor": {
          const kws = await db.select().from(keywords).where(inArray(keywords.id, op.keywordIds));
          if (!kws.length) return { ok: false, detail: "Ключи не найдены в зеркале" };
          const withExt = kws.filter((k) => k.externalId);
          if (!withExt.length) return { ok: false, detail: "У ключей нет externalId — выполните sync" };
          await api("/v5/keywords/bids", {
            method: "POST",
            body: JSON.stringify({
              keywords: withExt.map((k) => ({ keywordId: Number(k.externalId), bid: Math.max(1, Math.round(k.bid * op.factor * 10) / 10) })),
            }),
          });
          for (const k of kws) {
            const newBid = Math.round(k.bid * op.factor * 10) / 10;
            await db.update(keywords).set({ bid: newBid }).where(eq(keywords.id, k.id));
          }
          return { ok: true, detail: `Direct: ставки ×${op.factor} по ${withExt.length} ключам (применено на стороне Яндекса)` };
        }
        default:
          return { ok: false, detail: `Direct: операция ${op.kind} не поддерживается этой версией адаптера` };
      }
    },
  };
}
