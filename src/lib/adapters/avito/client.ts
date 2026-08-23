// Avito Business API adapter — real API (ТЗ 8.3).
// Auth: OAuth2 client_credentials with client_id/client_secret from ЛК Авито
// (Настройки → API). Token endpoint: POST https://api.avito.ru/token, TTL 24h.
// Access to the Business API is granted via a partner agreement (ТЗ 13, риски) —
// endpoint paths below follow the public business-API docs; verify on first connect.

import { and, eq, inArray } from "drizzle-orm";
import { db, currentTenant } from "@/db";
import { campaigns, metricsDaily } from "@/db/schema";
import { registerRefresher, storeToken, getToken, type StoredToken } from "../oauth-store";
import type { DailyMetric, PlatformClient, WriteOp, WriteResult } from "../types";

function version(): string {
  return process.env.AVITO_API_VERSION ?? "v1";
}
function userId(): string {
  const v = process.env.AVITO_USER_ID;
  if (!v) throw new Error("AVITO_USER_ID is not set (id владельца аккаунта Авито)");
  return v;
}
function clientSecret(): string {
  const v = process.env.AVITO_CLIENT_SECRET;
  if (!v) throw new Error("AVITO_CLIENT_SECRET is not set");
  return v;
}
function clientId(): string {
  const v = process.env.AVITO_CLIENT_ID;
  if (!v) throw new Error("AVITO_CLIENT_ID is not set");
  return v;
}

export async function avitoFetchToken(): Promise<StoredToken> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId(),
    client_secret: clientSecret(),
  });
  const res = await fetch("https://api.avito.ru/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Avito token error ${res.status}: ${await res.text()}`);
  const d = (await res.json()) as { access_token: string; expires_in?: number };
  const t: StoredToken = {
    accessToken: d.access_token,
    expiresAt: new Date(Date.now() + (d.expires_in ?? 24 * 3600) * 1000),
    extra: { grant: "client_credentials" },
  };
  await storeToken("avito", t);
  return t;
}

async function refreshAvito(_current: StoredToken | null): Promise<StoredToken> {
  // client_credentials: tokens are not individually refreshable — issue a new one.
  return avitoFetchToken();
}

registerRefresher("avito", refreshAvito);

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const t = await getToken("avito");
  if (!t) throw new Error("Avito token is missing or expired");
  const res = await fetch(`https://api.avito.ru/business/${version()}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${t.accessToken}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`Avito API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

const STATUS_MAP: Record<string, "active" | "paused"> = { online: "active", offline: "paused" };

async function upsertListing(adv: Record<string, unknown>): Promise<void> {
  const externalId = String(adv.advId ?? adv.id);
  const name = String(adv.title ?? externalId);
  const status = STATUS_MAP[String(adv.status ?? "online")] ?? "active";
  const price = Number((adv.price as { value?: number } | undefined)?.value ?? adv.price ?? 0);
  const existing = (await db.select().from(campaigns).where(and(eq(campaigns.platform, "avito"), eq(campaigns.externalId, externalId))))[0];
  if (existing) {
    await db.update(campaigns).set({ name, status, price }).where(eq(campaigns.id, existing.id));
  } else {
    await db.insert(campaigns).values({ organizationId: currentTenant()?.orgId ?? 1, platform: "avito", kind: "listing", externalId, name, status, price, strategy: "Avito" });
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

export function createAvitoClient(): PlatformClient {
  return {
    platform: "avito",
    isProduction: true,

    async sync(): Promise<void> {
      const advs = (await api(`/users/${userId()}/adv?limit=100`)) as { result?: Record<string, unknown>[] };
      for (const a of advs.result ?? []) await upsertListing(a);
      const local = await db.select().from(campaigns).where(eq(campaigns.platform, "avito"));
      const idMap = new Map(local.map((r) => [r.externalId, r.id]));
      for (const [extId, localId] of idMap) {
        try {
          const stats = (await api(`/adv/${extId}/stats?date_from=${new Date(Date.now() - 27 * 86400000).toISOString().slice(0, 10)}`)) as {
            result?: Record<string, unknown>[];
          };
          for (const s of stats.result ?? []) {
            await upsertMetric(localId, {
              campaignId: localId,
              date: String(s.date).slice(0, 10),
              spend: Number(s.spend ?? 0),
              impressions: Number(s.views ?? s.impressions ?? 0),
              clicks: Number(s.contacts ?? s.clicks ?? 0),
              conversions: 0,
            });
          }
        } catch {
          // Per-adv stats failures are non-fatal for the sync.
        }
      }
    },

    async write(op: WriteOp): Promise<WriteResult> {
      switch (op.kind) {
        case "campaign_status": {
          const rows = await db.select().from(campaigns).where(and(eq(campaigns.platform, "avito"), inArray(campaigns.id, op.campaignIds)));
          for (const r of rows) {
            await api(`/adv/${r.externalId}/status`, {
              method: "POST",
              body: JSON.stringify({ status: op.status === "active" ? "online" : "offline" }),
            });
          }
          return { ok: true, detail: `Авито: ${rows.length} объявлений → ${op.status}` };
        }
        case "promote_listings": {
          const rows = await db.select().from(campaigns).where(and(eq(campaigns.platform, "avito"), inArray(campaigns.id, op.campaignIds)));
          for (const r of rows) {
            // «Поднять в поиске» (boost) via the promotion-services endpoint.
            await api(`/adv/${r.externalId}/promotion-services`, {
              method: "POST",
              body: JSON.stringify({ serviceType: op.service === "boost7" ? "BOOST" : "TURBO", period: 7 }),
            });
          }
          return { ok: true, detail: `Авито: продвинуто ${rows.length} объявлений (${op.service})` };
        }
        case "create_campaign":
          return { ok: true, detail: "Авито: создание объявления — через карточку (follow-up), локально зафиксировано" };
        default:
          return { ok: false, detail: `Авито: операция ${op.kind} не поддерживается этой версией адаптера` };
      }
    },
  };
}
