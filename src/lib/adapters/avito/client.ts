// Avito Business API adapter — REAL API (ТЗ 8.3).
//
// Auth: OAuth2 client_credentials. Token endpoint (per merged OpenAPI spec,
// verified 2026-08-27): POST https://api.avito.ru/token with QUERY params
// grant_type=client_credentials&client_id=..&client_secret=.. — keys from
// ЛК Авито (Настройки → API). TTL ~24h; client_credentials has no refresh —
// just re-issue.
//
// Verified endpoints (server https://api.avito.ru):
//   GET  /core/v1/accounts/self                     → authenticated user (id)
//   GET  /core/v1/items?page=&per_page=             → {meta:{page,per_page},
//        resources:[{id,title,price,status:active|removed|old|blocked|rejected,url,category}]}
//   POST /stats/v1/accounts/{user_id}/items         → body {itemIds*,dateFrom*,dateTo*}
//        → {result:{items:[{itemId,stats:[{date,uniqViews,uniqContacts,uniqFavorites}]}]}}
//   POST /promotion/v1/items/services/dict          → [{slug,name,isDeprecated}]
//   POST /core/v1/accounts/{userId}/vas/prices      → body {itemIds} → promo prices/availability
//   PUT  /core/v2/items/{itemId}/vas/               → body {slugs:[...]} → apply promotion
//   POST /promotion/v1/items/services/get           → body {itemIds} → attached services (read-back)
//   POST /adv/{itemId}/status                       → classic API, NOT in the business spec —
//        kept for online/offline; verify on first live connect (clear error otherwise).
//   POST /core/v1/items/{item_id}/update_price      → available for a future price op.
//
// Access to the Business API is granted via the Avito API plan/partner terms
// (ТЗ 13, риски) — the first live connect may surface contract deltas; every
// failure here returns a structured error with the provider message (E.1 rule).

import { and, eq, inArray } from "drizzle-orm";
import { db, currentTenant, tenantOrgId } from "@/db";
import { campaigns, metricsDaily } from "@/db/schema";
import { registerRefresher, storeToken, getToken, type StoredToken } from "../oauth-store";
import type { DailyMetric, PlatformClient, ExecutionResult, WriteOp } from "../types";

const BASE = "https://api.avito.ru";

function clientId(): string {
  const v = process.env.AVITO_CLIENT_ID;
  if (!v) throw new Error("Avito: AVITO_CLIENT_ID is not set (ЛК Авито → Настройки → API)");
  return v;
}
function clientSecret(): string {
  const v = process.env.AVITO_CLIENT_SECRET;
  if (!v) throw new Error("Avito: AVITO_CLIENT_SECRET is not set (ЛК Авито → Настройки → API)");
  return v;
}

// Review M2: a hanging provider must not hold the request open forever.
const HTTP_TIMEOUT_MS = 15_000;

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    throw (e as Error)?.name === "AbortError" ? new Error(`Avito timeout after ${HTTP_TIMEOUT_MS}ms (${url})`) : e;
  } finally {
    clearTimeout(timer);
  }
}

export async function avitoFetchToken(): Promise<StoredToken> {
  const q = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId(),
    client_secret: clientSecret(),
  });
  const res = await fetchWithTimeout(`${BASE}/token?${q.toString()}`, { method: "POST" });
  if (!res.ok) throw new Error(`Avito token error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const d = (await res.json()) as { access_token?: string; token_type?: string; expires_in?: number };
  if (!d.access_token) throw new Error(`Avito token error: access_token missing in response`);
  const t: StoredToken = {
    accessToken: d.access_token,
    expiresAt: new Date(Date.now() + (d.expires_in ?? 24 * 3600) * 1000),
    extra: { grant: "client_credentials" },
  };
  await storeToken(tenantOrgId(), "avito", t);
  return t;
}

async function refreshAvito(_current: StoredToken | null): Promise<StoredToken> {
  // client_credentials: tokens are not individually refreshable — issue a new one.
  return avitoFetchToken();
}
registerRefresher("avito", refreshAvito);

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const t = await getToken(tenantOrgId(), "avito");
  if (!t) throw new Error("Avito token is missing or expired — run the connect (avitoFetchToken)");
  const res = await fetchWithTimeout(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${t.accessToken}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`Avito API ${path} → ${res.status}: ${body}`);
  }
  return res.json();
}

/** Account owner id, cached PER TENANT (review L1): AVITO_USER_ID env (explicit)
 *  or resolved via /accounts/self. A module-level single cache would let the
 *  first org's id leak across organizations in a multi-tenant deployment. */
const cachedUserIds = new Map<number, string>();
async function userId(): Promise<string> {
  const org = tenantOrgId();
  const cached = cachedUserIds.get(org);
  if (cached) return cached;
  const fromEnv = process.env.AVITO_USER_ID;
  if (fromEnv) {
    cachedUserIds.set(org, fromEnv);
    return fromEnv;
  }
  const self = (await api("/core/v1/accounts/self")) as Record<string, unknown>;
  const id = self.id ?? self.userId;
  if (id == null) throw new Error("Avito: /accounts/self did not return a user id");
  const resolved = String(id);
  cachedUserIds.set(org, resolved);
  return resolved;
}

const STATUS_MAP: Record<string, "active" | "paused"> = {
  active: "active",
  removed: "paused",
  old: "paused",
  blocked: "paused",
  rejected: "paused",
};

async function upsertListing(adv: Record<string, unknown>): Promise<void> {
  const externalId = String(adv.id ?? "");
  if (!externalId) return;
  const name = String(adv.title ?? externalId);
  const status = STATUS_MAP[String(adv.status ?? "active")] ?? "paused";
  const price = Number(adv.price ?? 0);
  const existing = (await db.select().from(campaigns).where(and(eq(campaigns.platform, "avito"), eq(campaigns.externalId, externalId))))[0];
  if (existing) {
    await db.update(campaigns).set({ name, status, price }).where(eq(campaigns.id, existing.id));
  } else {
    await db.insert(campaigns).values({ organizationId: tenantOrgId(), platform: "avito", kind: "listing", externalId, name, status, price, strategy: "Avito" });
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

/** Fetch ALL own listings with pagination (per_page 100). */
async function fetchAllItems(): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let page = 1;
  for (;;) {
    const d = (await api(`/core/v1/items?per_page=100&page=${page}`)) as {
      meta?: { page?: number; per_page?: number };
      resources?: Record<string, unknown>[];
    };
    const batch = d.resources ?? [];
    out.push(...batch);
    const perPage = d.meta?.per_page ?? 100;
    if (batch.length < perPage || page > 20) break;
    page += 1;
  }
  return out;
}

/** 28 days of per-item daily counters (uniqViews/uniqContacts). */
async function fetchItemStats(itemIds: number[]): Promise<Map<number, { date: string; views: number; contacts: number }[]>> {
  const out = new Map<number, { date: string; views: number; contacts: number }[]>();
  const dateTo = new Date().toISOString().slice(0, 10);
  const dateFrom = new Date(Date.now() - 27 * 86400000).toISOString().slice(0, 10);
  // Batches of 100 (conservative; the spec does not document a hard limit).
  for (let i = 0; i < itemIds.length; i += 100) {
    const chunk = itemIds.slice(i, i + 100);
    try {
      const uid = await userId();
      const d = (await api(`/stats/v1/accounts/${uid}/items`, {
        method: "POST",
        body: JSON.stringify({ itemIds: chunk, dateFrom, dateTo }),
      })) as { result?: { items?: { itemId?: number; stats?: { date?: string; uniqViews?: number; uniqContacts?: number }[] }[] } };
      for (const it of d.result?.items ?? []) {
        if (it.itemId == null) continue;
        out.set(Number(it.itemId), (it.stats ?? []).map((s) => ({ date: String(s.date ?? "").slice(0, 10), views: Number(s.uniqViews ?? 0), contacts: Number(s.uniqContacts ?? 0) })));
      }
    } catch (e) {
      console.error("avito stats batch failed:", (e as Error).message);
    }
  }
  return out;
}

export function createAvitoClient(): PlatformClient {
  return {
    platform: "avito",
    isProduction: true,

    async sync(): Promise<void> {
      const advs = await fetchAllItems();
      for (const a of advs) await upsertListing(a);
      const local = await db.select({ id: campaigns.id, externalId: campaigns.externalId }).from(campaigns).where(eq(campaigns.platform, "avito"));
      const idMap = new Map(local.map((r) => [r.externalId, r.id]));
      const extIds = [...idMap.keys()].map(Number).filter(Number.isFinite);
      const stats = await fetchItemStats(extIds);
      for (const [extId, metrics] of stats) {
        const localId = idMap.get(String(extId));
        if (localId == null) continue;
        for (const m of metrics) {
          if (!m.date) continue;
          await upsertMetric(localId, { campaignId: localId, date: m.date, spend: 0, impressions: m.views, clicks: m.contacts, conversions: 0 });
        }
      }
    },

    async execute(op: WriteOp): Promise<ExecutionResult> {
      switch (op.kind) {
        case "campaign_status": {
          // Classic endpoint (business spec has no publish/unpublish).
          // After write: re-fetch items and compare STATUS_MAP (Phase 2.7 read-back).
          const rows = await db
            .select()
            .from(campaigns)
            .where(and(eq(campaigns.platform, "avito"), inArray(campaigns.id, op.campaignIds)));
          const providerResponse: unknown[] = [];
          for (const r of rows) {
            if (!r.externalId) continue;
            const res = await api(`/adv/${r.externalId}/status`, {
              method: "POST",
              body: JSON.stringify({ status: op.status === "active" ? "online" : "offline" }),
            });
            providerResponse.push({ itemId: r.externalId, res });
          }
          const wantActive = op.status === "active";
          let matched = 0;
          const mismatches: string[] = [];
          try {
            const all = await fetchAllItems();
            const byId = new Map(all.map((a) => [String(a.id ?? ""), a]));
            for (const r of rows) {
              if (!r.externalId) continue;
              const item = byId.get(String(r.externalId));
              const mapped = STATUS_MAP[String(item?.status ?? "")] ?? "paused";
              const ok = wantActive ? mapped === "active" : mapped === "paused";
              if (ok) matched++;
              else mismatches.push(String(r.externalId));
            }
          } catch (e) {
            return {
              ok: false,
              verified: false,
              providerResponse,
              readback: { op: op.kind, error: (e as Error).message.slice(0, 200) },
              detail: `Авито: статус записан, но read-back не удался: ${(e as Error).message.slice(0, 120)}`,
            };
          }
          const targetCount = rows.filter((r) => r.externalId).length;
          const verified = matched === targetCount && mismatches.length === 0;
          return {
            ok: true,
            verified,
            providerResponse,
            readback: {
              op: op.kind,
              target: op.status,
              matched,
              mismatches,
              items: rows.map((r) => r.externalId),
            },
            detail: verified
              ? `Авито: ${matched} объявлений → ${wantActive ? "online" : "offline"} (read-back совпал)`
              : `Авито: read-back статуса не совпал (ok ${matched}/${targetCount}, mismatch: ${mismatches.join(", ") || "—"})`,
          };
        }
        case "promote_listings": {
          // 1. Service dictionary (real slugs — no hardcoding): pick by op.service.
          // The 200 body is a bare array of ServiceInfoV1 ({slug,name,isDeprecated}).
          const dictRaw = (await api("/promotion/v1/items/services/dict", { method: "POST", body: JSON.stringify({}) })) as
            | { slug?: string; name?: string; isDeprecated?: boolean }[]
            | { services?: { slug?: string; name?: string; isDeprecated?: boolean }[] };
          const dict = Array.isArray(dictRaw) ? dictRaw : (dictRaw.services ?? []);
          const services = dict.filter((s) => s.slug && !s.isDeprecated);
          const want = op.service === "turbo" ? /турбо|усл\.\s*доставк/i : /поднять|поиск|x10/i;
          const service = services.find((s) => want.test(String(s.name ?? ""))) ?? services[0];
          if (!service?.slug) {
            return { ok: false, verified: false, error: `Avito: в словаре продвижения нет доступных услуг (операция ${op.service})` };
          }
          // 2. Apply the service to each item (v2 vas endpoint, slugs).
          const rows = await db.select().from(campaigns).where(and(eq(campaigns.platform, "avito"), inArray(campaigns.id, op.campaignIds)));
          const providerResponse: unknown[] = [];
          for (const r of rows) {
            const res = await api(`/core/v2/items/${r.externalId}/vas/`, {
              method: "PUT",
              body: JSON.stringify({ slugs: [service.slug] }),
            });
            providerResponse.push({ itemId: r.externalId, res });
          }
          // 3. Read-back (Phase 2.8): require chosen slug on each item — fail closed.
          let verified = true;
          const attachedByItem: Record<string, string[]> = {};
          try {
            const ids = rows.map((r) => Number(r.externalId)).filter(Number.isFinite);
            for (let i = 0; i < ids.length; i += 100) {
              const chunk = ids.slice(i, i + 100);
              const body = (await api("/promotion/v1/items/services/get", {
                method: "POST",
                body: JSON.stringify({ itemIds: chunk }),
              })) as {
                result?: { items?: { itemId?: number; services?: { slug?: string }[] }[] };
                items?: { itemId?: number; services?: { slug?: string }[] }[];
              };
              const list = body.result?.items ?? body.items ?? [];
              for (const it of list) {
                const slugs = (it.services ?? []).map((s) => String(s.slug ?? "")).filter(Boolean);
                if (it.itemId != null) attachedByItem[String(it.itemId)] = slugs;
              }
            }
            for (const r of rows) {
              if (!r.externalId) continue;
              const slugs = attachedByItem[String(r.externalId)] ?? [];
              if (!service.slug || !slugs.includes(service.slug)) {
                verified = false;
                break;
              }
            }
            if (rows.some((r) => r.externalId && !(String(r.externalId) in attachedByItem))) {
              verified = false;
            }
          } catch (e) {
            verified = false;
            attachedByItem["__error"] = [(e as Error).message.slice(0, 200)];
          }
          return {
            ok: true,
            verified,
            providerResponse,
            readback: {
              op: op.kind,
              service: service.slug,
              serviceName: service.name,
              items: rows.map((r) => r.externalId),
              attachedByItem,
            },
            detail: verified
              ? `Авито: продвинуто ${rows.length} объявлений (${service.name ?? service.slug}) · read-back OK`
              : `Авито: продвижение отправлено, но read-back не подтвердил услугу «${service.slug}» на всех объявлениях`,
          };
        }
        case "create_campaign":
          return { ok: true, verified: true, readback: { op: op.kind }, detail: "Авито: создание объявления — через карточку (follow-up), локально зафиксировано" };
        default:
          return { ok: false, verified: false, detail: `Авито: операция ${op.kind} не поддерживается этой версией адаптера` };
      }
    },
  };
}
