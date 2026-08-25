// Yandex Direct adapter — production client for the real Direct API v5
// (contract verified against official docs) + read-back verification (Phase E).
//
//   POST https://api.direct.yandex.com/json/v5/{service}   (prod)
//   POST https://api-sandbox.direct.yandex.com/json/v5/…  (sandbox)
//   Authorization: Bearer <token>
//   body: { method, params }
//
// Execution contract (E3/E4/E7): every write returns an ExecutionResult with
// the raw provider response AND a read-back of the changed resources; the
// agent marks the action VERIFIED only when the read-back matches.
//
// Simulator mode (E8): YANDEX_SIMULATOR=1 (or createYandexClient({ simulated }))
// routes the calls to an in-process simulator implementing the same contract —
// full execution pipeline proof without a real account.

import { and, eq, inArray } from "drizzle-orm";
import { db, currentTenant } from "@/db";
import { campaigns, keywords } from "@/db/schema";
import { getToken, storeToken, type StoredToken } from "../oauth-store";
import { DirectApi, type YandexTransport } from "./api";
import { getSharedSimulator, seedSimulatorFrom } from "./simulator";
import { buildCampaignTree } from "./campaign-builder";
import { resolveStrategy } from "./strategy";
import { correlationName } from "./naming";
import type { ExecutionResult, PlatformClient, WriteOp } from "../types";

const PROD_BASE = "https://api.direct.yandex.com/json/v5";
const SANDBOX_BASE = "https://api-sandbox.direct.yandex.com/json/v5";

async function yandexToken(): Promise<string> {
  const org = currentTenant()?.orgId ?? 1;
  const t = await getToken(org, "yandex");
  if (!t) throw new Error("Yandex token is missing or expired — reconnect the account");
  return t.accessToken;
}

function isSimulatorMode(): boolean {
  return process.env.YANDEX_SIMULATOR === "1";
}

// ── OAuth (authorization-code flow via Yandex ID) ─────────────────────────
export function yandexAuthUrl(state: string): string {
  const clientId = process.env.YANDEX_OAUTH_CLIENT_ID;
  if (!clientId) throw new Error("YANDEX_OAUTH_CLIENT_ID is not set");
  const redirectUri = `${process.env.PUBLIC_URL ?? "http://localhost:3000"}/api/oauth/yandex`;
  const p = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    locale: "ru",
  });
  return `https://oauth.yandex.ru/authorize?${p.toString()}`;
}

async function yandexTokenGrant(grantType: string, params: Record<string, string>): Promise<StoredToken> {
  const body = new URLSearchParams({
    grant_type: grantType,
    client_id: process.env.YANDEX_OAUTH_CLIENT_ID!,
    client_secret: process.env.YANDEX_OAUTH_CLIENT_SECRET!,
    ...params,
  });
  const res = await fetch("https://oauth.yandex.ru/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Yandex token error ${res.status}: ${await res.text()}`);
  const d = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
  return {
    accessToken: d.access_token,
    refreshToken: d.refresh_token,
    expiresAt: d.expires_in ? new Date(Date.now() + d.expires_in * 1000) : undefined,
  };
}

export async function yandexExchangeCode(code: string): Promise<StoredToken> {
  const redirectUri = `${process.env.PUBLIC_URL ?? "http://localhost:3000"}/api/oauth/yandex`;
  const t = await yandexTokenGrant("authorization_code", { code, redirect_uri: redirectUri });
  await storeToken(currentTenant()?.orgId ?? 1, "yandex", t);
  return t;
}

export interface YandexClientOptions {
  simulated?: boolean;
  sandbox?: boolean;
  transport?: YandexTransport;
}

export function createYandexClient(opts: YandexClientOptions = {}): PlatformClient {
  const simulated = opts.simulated ?? isSimulatorMode();
  const transport = opts.transport ?? (simulated ? getSharedSimulator().transport : undefined);
  const api = new DirectApi(
    simulated ? async () => "simulated-token" : yandexToken,
    opts.sandbox ? SANDBOX_BASE : PROD_BASE,
    transport
  );

  // Ensure the simulator (simulated mode) is seeded from the local mirror so
  // read-back operates against state consistent with the mirror.
  async function ensureSimulatorSeeded(): Promise<void> {
    if (!simulated) return;
    const sim = getSharedSimulator();
    if (sim.state.campaigns.length === 0) {
      const rows = await db.select().from(campaigns).where(eq(campaigns.platform, "yandex"));
      if (rows.length) {
        seedSimulatorFrom(rows.map((r) => ({ id: Number(r.externalId), name: r.name, status: r.status, budgetDaily: r.budgetDaily })));
      }
    }
  }

  // ── sync: pull provider state into the local mirror ─────────────────────
  async function sync(): Promise<void> {
    await ensureSimulatorSeeded();
    // 1. Campaigns
    const campRes = (await api.call("campaigns", "get", {
      SelectionCriteria: { States: ["ON", "SUSPENDED"] },
      FieldNames: ["Id", "Name", "State", "Status", "Budget", "Type"],
      Page: { Limit: 4000, Offset: 0 },
    })) as { Campaigns?: Record<string, unknown>[] };
    for (const c of campRes.Campaigns ?? []) {
      const externalId = String(c.Id);
      const name = String(c.Name ?? externalId);
      const status = c.State === "SUSPENDED" ? "paused" : "active";
      const budget = Number(c.Budget ?? 0);
      const existing = (await db.select().from(campaigns).where(and(eq(campaigns.platform, "yandex"), eq(campaigns.externalId, externalId))))[0];
      if (existing) {
        await db.update(campaigns).set({ name, status, budgetDaily: budget }).where(eq(campaigns.id, existing.id));
      } else {
        await db.insert(campaigns).values({
          organizationId: currentTenant()?.orgId ?? 1,
          platform: "yandex",
          kind: "campaign",
          externalId,
          name,
          status,
          budgetDaily: budget,
          strategy: "Direct",
        });
      }
    }

    // 2. Keywords (with external ids for bid management)
    const kwRes = (await api.call("keywords", "get", {
      SelectionCriteria: {},
      FieldNames: ["Id", "CampaignId", "Keyword", "Bid", "State"],
      Page: { Limit: 10000, Offset: 0 },
    })) as { Keywords?: Record<string, unknown>[] };
    const campLocal = new Map(
      (await db.select().from(campaigns).where(eq(campaigns.platform, "yandex"))).map((c) => [c.externalId, c.id])
    );
    for (const k of kwRes.Keywords ?? []) {
      const localCampId = campLocal.get(String(k.CampaignId));
      if (!localCampId) continue;
      const externalId = String(k.Id);
      const text = String(k.Keyword ?? "");
      if (!text) continue;
      const bid = Number(k.Bid ?? 0);
      const existing = (await db.select().from(keywords).where(and(eq(keywords.campaignId, localCampId), eq(keywords.externalId, externalId))))[0];
      if (existing) {
        await db.update(keywords).set({ text, bid }).where(eq(keywords.id, existing.id));
      } else {
        await db.insert(keywords).values({ campaignId: localCampId, externalId, text, bid });
      }
    }
  }

  // ── execution helpers ───────────────────────────────────────────────────
  async function campaignStates(ids: number[]): Promise<Record<string, unknown>[]> {
    const local = await db.select().from(campaigns).where(and(eq(campaigns.platform, "yandex"), inArray(campaigns.id, ids)));
    const extIds = local.map((c) => Number(c.externalId));
    const res = (await api.call("campaigns", "get", {
      SelectionCriteria: { Ids: extIds },
      FieldNames: ["Id", "State", "Name", "Budget"],
    })) as { Campaigns?: Record<string, unknown>[] };
    return res.Campaigns ?? [];
  }

  async function keywordBids(ids: number[]): Promise<Record<string, unknown>[]> {
    const local = await db.select().from(keywords).where(inArray(keywords.id, ids));
    const withExt = local.filter((k) => k.externalId);
    const res = (await api.call("keywords", "get", {
      SelectionCriteria: { Ids: withExt.map((k) => Number(k.externalId)) },
      FieldNames: ["Id", "Bid"],
    })) as { Keywords?: Record<string, unknown>[] };
    return res.Keywords ?? [];
  }

  function fail(error: string, providerResponse?: unknown): ExecutionResult {
    return { ok: false, verified: false, error, providerResponse };
  }

  // ── execute with read-back verification (E4) ────────────────────────────
  async function execute(op: WriteOp): Promise<ExecutionResult> {
    await ensureSimulatorSeeded();
    try {
      switch (op.kind) {
        case "campaign_status": {
          const local = await db.select().from(campaigns).where(and(eq(campaigns.platform, "yandex"), inArray(campaigns.id, op.campaignIds)));
          const extIds = local.map((c) => Number(c.externalId));
          const method = op.status === "paused" ? "suspend" : "resume";
          const resp = await api.call("campaigns", method, { SelectionCriteria: { Ids: extIds } });
          const results = (resp as any)[method === "suspend" ? "SuspendResults" : "ResumeResults"] as { Id?: number; Errors?: { Code: number; Message: string }[] }[];
          const errors = (results ?? []).flatMap((r) => r.Errors ?? []);
          if (errors.length) return fail(`Direct: ${errors.map((e) => `${e.Code}: ${e.Message}`).join("; ")}`, resp);
          const readback = await campaignStates(op.campaignIds);
          const wanted = op.status === "paused" ? "SUSPENDED" : "ON";
          const verified = readback.length > 0 && readback.every((c) => c.State === wanted);
          // keep the local mirror consistent with the provider's truth
          for (const c of readback) {
            const ext = String(c.Id);
            const row = local.find((x) => String(x.externalId) === ext);
            if (row) await db.update(campaigns).set({ status: c.State === "SUSPENDED" ? "paused" : "active" }).where(eq(campaigns.id, row.id));
          }
          return { ok: true, verified, providerResponse: resp, readback, detail: verified ? `read-back: ${readback.length} кампаний в состоянии ${wanted}` : "read-back mismatch: состояние не совпало" };
        }
        case "campaign_budget": {
          const local = (await db.select().from(campaigns).where(eq(campaigns.id, op.campaignId)))[0];
          const resp = await api.call("campaigns", "update", { Campaigns: [{ Id: Number(local.externalId), Budget: op.budgetDaily }] });
          const results = (resp as any).UpdateResults as { Id?: number; Errors?: { Code: number; Message: string }[] }[];
          const errors = (results ?? []).flatMap((r) => r.Errors ?? []);
          if (errors.length) return fail(`Direct: ${errors.map((e) => `${e.Code}: ${e.Message}`).join("; ")}`, resp);
          const readback = await campaignStates([op.campaignId]);
          const verified = readback.length > 0 && Math.abs(Number(readback[0].Budget ?? 0) - op.budgetDaily) < 0.01;
          await db.update(campaigns).set({ budgetDaily: Number(readback[0]?.Budget ?? op.budgetDaily) }).where(eq(campaigns.id, op.campaignId));
          return { ok: true, verified, providerResponse: resp, readback, detail: verified ? "read-back: бюджет подтверждён" : "read-back mismatch: бюджет не совпал" };
        }
        case "bids_factor": {
          const local = await db.select().from(keywords).where(inArray(keywords.id, op.keywordIds));
          const withExt = local.filter((k) => k.externalId);
          if (!withExt.length) return fail("Direct: у ключей нет externalId (выполните sync)");
          const updates = withExt.map((k) => ({ Id: Number(k.externalId), Bid: Math.max(1, Math.round(k.bid * op.factor * 10) / 10) }));
          const resp = await api.call("keywords", "update", { Keywords: updates });
          const results = (resp as any).UpdateResults as { Id?: number; Errors?: { Code: number; Message: string }[] }[];
          const errors = (results ?? []).flatMap((r) => r.Errors ?? []);
          if (errors.length) return fail(`Direct: ${errors.map((e) => `${e.Code}: ${e.Message}`).join("; ")}`, resp);
          const readback = await keywordBids(op.keywordIds);
          const wanted = new Map(updates.map((u) => [u.Id, u.Bid]));
          const verified = readback.length > 0 && readback.every((k) => Math.abs(Number(k.Bid ?? 0) - (wanted.get(Number(k.Id)) ?? 0)) < 0.01);
          const rbMap = new Map(readback.map((k) => [k.Id, Number(k.Bid ?? 0)]));
          for (const k of withExt) {
            const nb = rbMap.get(Number(k.externalId));
            if (nb != null) await db.update(keywords).set({ bid: nb }).where(eq(keywords.id, k.id));
          }
          return { ok: true, verified, providerResponse: resp, readback, detail: verified ? `read-back: ставки подтверждены по ${readback.length} ключам` : "read-back mismatch: ставки не совпали" };
        }
        case "create_campaign": {
          // Phase E.1: the monolithic build is extracted into campaign-builder
          // (idempotent adoption by correlation name, partial-failure state,
          // deterministic strategy mapping). The LOCAL MIRROR is written by the
          // agent's applyLocal step (run.ts) from the verified read-back — not
          // here — so exactly one row per provider campaign is created.
          if (op.url && !/^https?:\/\//i.test(op.url)) return fail("Direct: URL объявления должен начинаться с http:// или https://");
          if ((op.title || op.text || op.url) && (!op.title || !op.text || !op.url)) {
            return fail("Direct: для создания объявления нужны title, text и url");
          }
          const orgId = currentTenant()?.orgId ?? 1;
          const corrName = op.correlationId ? correlationName(orgId, op.correlationId, op.name) : op.name;
          const built = await buildCampaignTree(api, {
            correlationName: corrName,
            budgetDaily: op.budgetDaily,
            strategy: resolveStrategy(op.strategy),
            maxCpcRubles: op.maxCpcRubles,
            maxCpaRubles: op.maxCpaRubles,
            adGroupName: op.adGroupName,
            title: op.title,
            text: op.text,
            url: op.url,
            keywords: op.keywords,
            negativeKeywords: op.negativeKeywords,
            regionIds: op.regionIds,
          });
          return {
            ok: built.ok,
            verified: built.verified,
            error: built.error,
            detail: built.detail,
            providerResponse: built.providerResponse,
            // readback carries the structured saga state (createdResources,
            // failedAt, adopted) — stored in pending_actions.readback.
            readback: built.readback ?? built.state,
          };
        }
        case "delete_campaign_tree": {
          // Saga compensation: delete what a (partially) failed create left at
          // the provider. Order: ads → keywords → adgroups → campaign; verified
          // only when the campaign read-back is empty.
          const local = (await db.select().from(campaigns).where(eq(campaigns.id, op.campaignId)))[0];
          if (!local?.externalId) return fail("Direct: у кампании нет externalId — нечего удалять на провайдере");
          const extId = Number(local.externalId);
          const ads = (await api.call("ads", "get", { SelectionCriteria: { CampaignIds: [extId] }, FieldNames: ["Id"] })) as { Ads?: Record<string, unknown>[] };
          const adIds = (ads.Ads ?? []).map((a) => Number(a.Id)).filter(Number.isFinite);
          if (adIds.length) await api.call("ads", "delete", { SelectionCriteria: { Ids: adIds } });
          const kws = (await api.call("keywords", "get", { SelectionCriteria: { CampaignIds: [extId] }, FieldNames: ["Id"] })) as { Keywords?: Record<string, unknown>[] };
          const kwIds = (kws.Keywords ?? []).map((k) => Number(k.Id)).filter(Number.isFinite);
          if (kwIds.length) await api.call("keywords", "delete", { SelectionCriteria: { Ids: kwIds } });
          const groups = (await api.call("adgroups", "get", { SelectionCriteria: { CampaignIds: [extId] }, FieldNames: ["Id"] })) as { AdGroups?: Record<string, unknown>[] };
          const groupIds = (groups.AdGroups ?? []).map((g) => Number(g.Id)).filter(Number.isFinite);
          if (groupIds.length) await api.call("adgroups", "delete", { SelectionCriteria: { Ids: groupIds } });
          const delResp = await api.call("campaigns", "delete", { SelectionCriteria: { Ids: [extId] } });
          const back = (await api.call("campaigns", "get", { SelectionCriteria: { Ids: [extId] }, FieldNames: ["Id"] })) as { Campaigns?: Record<string, unknown>[] };
          const gone = (back.Campaigns ?? []).length === 0;
          return {
            ok: true,
            verified: gone,
            providerResponse: delResp,
            readback: { campaign: back.Campaigns ?? [], removed: { ads: adIds.length, keywords: kwIds.length, adGroups: groupIds.length, campaign: gone } },
            detail: gone ? `Direct: кампания ${extId} и её дерево (объявлений: ${adIds.length}, ключей: ${kwIds.length}, групп: ${groupIds.length}) удалены — read-back пуст` : "Direct: read-back: кампания всё ещё существует",
          };
        }
        case "negative_keywords": {
          const local = (await db.select().from(campaigns).where(eq(campaigns.id, op.campaignId)))[0];
          const resp = await api.call("negativekeywords", "add", {
            NegativeKeywords: op.words.map((w) => ({ CampaignId: Number(local.externalId), TextKeyword: { Keyword: w } })),
          });
          const results = (resp as any).AddResults as { Errors?: { Code: number; Message: string }[] }[];
          const errors = (results ?? []).flatMap((r) => r.Errors ?? []);
          if (errors.length) return fail(`Direct: ${errors.map((e) => `${e.Code}: ${e.Message}`).join("; ")}`, resp);
          const kwRes = (await api.call("negativekeywords", "get", {
            SelectionCriteria: { CampaignIds: [Number(local.externalId)] },
            FieldNames: ["CampaignId", "Keyword"],
          })) as { NegativeKeywords?: Record<string, unknown>[] };
          const present = new Set((kwRes.NegativeKeywords ?? []).map((n) => String(n.Keyword)));
          const verified = op.words.every((w) => present.has(w));
          return { ok: true, verified, providerResponse: resp, readback: kwRes.NegativeKeywords, detail: verified ? `read-back: ${op.words.length} минус-фраз на месте` : "read-back mismatch: минус-фразы не найдены" };
        }
        default:
          return fail(`Direct: операция ${op.kind} не поддерживается этой версией адаптера`);
      }
    } catch (e) {
      return fail((e as Error).message);
    }
  }

  return {
    platform: "yandex",
    isProduction: true, // real API (or its simulator) — execution is verified either way
    sync,
    execute,
  };
}
