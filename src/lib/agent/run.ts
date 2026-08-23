// Agent core: intent (LLM → rules) → adapter sync → tool routing → safety layer → audit → chat persistence.

import { and, eq, inArray } from "drizzle-orm";
import { db, currentTenant } from "@/db";
import {
  accounts,
  campaigns,
  keywords,
  messages,
  negativeKeywords,
  pendingActions,
  recommendations,
} from "@/db/schema";
import { fmtMoney } from "@/lib/format";
import { resolveIntent, WRITE_TOOLS } from "./router";
import { authorize, type Role } from "./rbac";
import type { TenantContext } from "@/lib/tenant/pool";
import type { ParsedIntent } from "./router";
import { getSettings, writeAudit } from "./safety";
import { evaluatePolicy, toolToAction } from "./policy";
import type { SafetySettings } from "./safety";
import * as tools from "./tools";
import type { AgentMeta, ChatMessageRow, Platform, ResultPayload, TraceStep } from "./types";
import { PLATFORM_LABEL } from "./types";
import { buildSessionContext } from "./session-context";
import { persistBudgetShift, suggestBudgetShift } from "./cross-platform-advisor";
import { syncAdapters, writeAdapters } from "@/lib/adapters";
import type { WriteOp } from "@/lib/adapters/types";

const TOOL_DESC: Record<string, string> = {
  get_spend_report: "сводный расход по платформам",
  compare_cpa: "сравнение CPA между площадками",
  pause_low_ctr_campaigns: "пауза кампаний с низким CTR",
  set_campaign_status: "пауза/запуск конкретной кампании",
  promote_low_view_listings: "продвижение объявлений Авито",
  run_account_audit: "автоматический аудит кабинетов",
  adjust_bids: "корректировка ставок",
  create_campaign: "создание кампании",
  list_campaigns: "список кампаний",
  get_keyword_performance: "статистика по ключевым фразам",
  add_negative_keywords: "добавление минус-фраз",
  get_avito_chat_summary: "сводка по чатам Авито",
  apply_recommendation: "применение рекомендаций",
  list_recommendations: "список рекомендаций",
  help: "справка по командам",
  fallback: "уточнение запроса",
};

function orgId(): number {
  return currentTenant()?.orgId ?? 1;
}

/** Risk context known before dispatch (from the parsed intent). */
function preDispatchRisk(intent: ParsedIntent): { costDaily?: number; bidChangePercent?: number; budgetDelta?: number } {
  const risk: { costDaily?: number; bidChangePercent?: number; budgetDelta?: number } = {};
  if (intent.tool === "create_campaign" && typeof intent.params.budget === "number") {
    risk.costDaily = intent.params.budget;
    risk.budgetDelta = intent.params.budget;
  }
  if (intent.tool === "adjust_bids" && typeof intent.params.percent === "number") {
    risk.bidChangePercent = intent.params.direction === "down" ? -intent.params.percent : intent.params.percent;
  }
  return risk;
}

export function serializeMessage(row: {
  id: number;
  role: string;
  content: string;
  meta: unknown;
  createdAt: Date;
}): ChatMessageRow {
  return {
    id: row.id,
    role: row.role as "user" | "agent",
    content: row.content,
    meta: row.meta as AgentMeta | null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function getChatHistory(): Promise<ChatMessageRow[]> {
  const rows = await db.select().from(messages).orderBy(messages.id);
  return rows.map(serializeMessage);
}

async function insertAgentMessage(content: string, meta: AgentMeta | null): Promise<ChatMessageRow> {
  const row = (await db.insert(messages).values({ organizationId: orgId(), role: "agent", content, meta }).returning())[0];
  return serializeMessage(row);
}

export async function runAgent(raw: string, actor: "chat" | "ui" = "chat", ctx?: TenantContext) {
  const started = Date.now();
  const text = raw.trim();
  const userRow = (await db.insert(messages).values({ organizationId: orgId(), role: "user", content: text }).returning())[0];

  const role: Role = (ctx?.role as Role) ?? "admin";
  const session = await buildSessionContext();
  const resolved = await resolveIntent(text, session);
  const intent = resolved.intent;
  const settings = await getSettings();
  const isWrite = WRITE_TOOLS.has(intent.tool);
  const trace: TraceStep[] = [];

  trace.push({
    label:
      resolved.engine === "llm"
        ? `AI Core (LLM ${resolved.model}): намерение → ${intent.tool}`
        : resolved.llmError
          ? `AI Core: LLM недоступна (${resolved.llmError}) → rule-based → ${intent.tool}`
          : `AI Core: намерение распознано (rule-based) → ${intent.tool}`,
    detail: TOOL_DESC[intent.tool] ?? intent.tool,
    status: "ok",
  });

  const defaultPlat: Platform[] =
    intent.platforms.length > 0
      ? intent.platforms
      : intent.tool === "promote_low_view_listings" || intent.tool === "get_avito_chat_summary"
        ? ["avito"]
        : intent.tool === "compare_cpa" || intent.tool === "adjust_bids" || intent.tool === "get_keyword_performance"
          ? ["google", "yandex"]
          : ["google", "yandex", "avito"];

  // Adapter sync: in production mode pull fresh state from the platforms (no-op in sandbox).
  const syncResults = await syncAdapters(defaultPlat);
  const prodPlatforms = syncResults.filter((s) => s.mode === "production");
  trace.push({
    label: `Маршрутизация адаптерам: ${defaultPlat.map((p) => PLATFORM_LABEL[p]).join(", ")}`,
    detail: prodPlatforms.length
      ? prodPlatforms.map((s) => `${s.platform}: ${s.ok ? "sync ok" : "sync error: " + s.detail}`).join("; ")
      : "sandbox-режим: данные из локального зеркала",
    status: "ok",
  });

  let result: ResultPayload;
  let auditStatus = "ok";
  let auditSummary = "";
  let pendingId: number | undefined;

  // Policy Engine — pre-dispatch decision (the LLM never executes anything directly).
  // Role + risk are evaluated here; the LLM's parameters can never override this.
  const preRisk = preDispatchRisk(intent);
  const prePolicy = await evaluatePolicy({ tool: intent.tool, isWrite, settings, role, risk: preRisk });

  if (prePolicy.action === "block") {
    trace.push({ label: "Policy Engine: действие заблокировано", detail: prePolicy.reason, status: "block" });
    result = { kind: "text", text: prePolicy.reason };
    auditStatus = "blocked";
    auditSummary = `Блокировка ${intent.tool}: политика безопасности`;
  } else {
    // RBAC LIMITED: clamp the bid change to the role cap before the preview is built.
    if (isWrite && prePolicy.action === "require_approval" && prePolicy.bidPercentCap != null && intent.tool === "adjust_bids") {
      const cap = prePolicy.bidPercentCap;
      intent.params.percent = Math.abs(cap);
      intent.params.direction = cap > 0 ? "up" : "down";
      trace.push({ label: `RBAC: изменение ставки ограничено до ±${Math.abs(cap)}% для роли`, status: "warn" });
    }

    const out = await dispatch(intent.tool, intent, settings);
    result = out.result;
    auditSummary = out.auditSummary;

    if (out.pending) {
      // Policy Engine — full decision including role, risk and added daily cost.
      const costDaily = out.pending.costDaily ?? 0;
      const postRisk = { ...preDispatchRisk(intent), costDaily };
      const policy = await evaluatePolicy({ tool: intent.tool, isWrite: true, settings, role, costDaily, risk: postRisk });

      if (policy.action === "block") {
        trace.push({ label: "Policy Engine: действие отклонено", detail: policy.reason, status: "block" });
        result = {
          ...(result as Extract<ResultPayload, { kind: "preview" }>),
          verdict: "blocked",
          reason: policy.reason,
        };
        auditStatus = "blocked";
      } else {
        const riskNote = policy.action === "require_approval" ? policy.riskNote : undefined;
        trace.push({
          label: `Policy Engine: ${policy.note ?? "требуется подтверждение"}`,
          detail: riskNote ?? "Изменения не применяются без явного подтверждения",
          status: "warn",
        });
        if (costDaily > 0) {
          trace.push({ label: "Policy Engine: лимиты расхода (день/неделя/месяц) — запас есть", status: "ok" });
        }
        const pending = (
          await db
            .insert(pendingActions)
            .values({
              organizationId: orgId(),
              tool: intent.tool,
              params: out.pending.params,
              preview: result,
              costDaily,
              status: "pending",
              source: actor,
            })
            .returning()
        )[0];
        pendingId = pending.id;
        result = { ...(result as Extract<ResultPayload, { kind: "preview" }>), pendingActionId: pending.id };
        auditStatus = settings.dryRun ? "dry_run" : "pending";
      }
    } else {
      trace.push({ label: "Safety-слой: операция чтения, ограничения не применяются", status: "ok" });
    }
  }

  const durationMs = Math.max(40, Date.now() - started);
  trace.push({
    label:
      auditStatus === "blocked"
        ? "Действие отклонено политикой безопасности"
        : isWrite
          ? "Результат записан, ожидает подтверждения"
          : "Результат агрегирован и возвращён",
    status: auditStatus === "blocked" ? "block" : "ok",
  });

  const meta: AgentMeta = {
    tool: intent.tool,
    toolLabel: intent.tool,
    platforms: defaultPlat,
    trace,
    durationMs,
    result,
    pendingActionId: pendingId,
  };

  let content = briefSummary(result);

  // Cross-Platform Advisor (US-8): after analytics propose a budget shift if justified.
  if (intent.tool === "get_spend_report" && result.kind === "spend_report") {
    const s = suggestBudgetShift(result.rows, 25, 15);
    if (s) {
      const recId = await persistBudgetShift(s, result.period.days);
      if (recId) {
        content += `\n📈 Кросс-платформенная рекомендация: ${s.insight} (реком. #${recId} — скажите «примени рекомендацию ${recId}» или «все» для подтверждения).`;
      }
    }
  }

  const agentRow = await insertAgentMessage(content, meta);

  await writeAudit({
    actor,
    tool: intent.tool,
    params: intent.params,
    platforms: defaultPlat,
    dryRun: settings.dryRun && isWrite,
    status: auditStatus,
    summary: auditSummary,
  });

  return { user: serializeMessage(userRow), agent: agentRow };
}

async function dispatch(tool: string, intent: ParsedIntent, _settings: SafetySettings): Promise<tools.ToolOutput> {
  switch (tool) {
    case "get_spend_report":
      return tools.getSpendReport(intent);
    case "compare_cpa":
      return tools.compareCpa(intent);
    case "list_campaigns":
      return tools.listCampaigns(intent);
    case "get_keyword_performance":
      return tools.getKeywordPerformance(intent);
    case "get_avito_chat_summary":
      return tools.getAvitoChatSummary(intent);
    case "run_account_audit":
      return tools.runAccountAudit(intent);
    case "pause_low_ctr_campaigns":
      return tools.pauseLowCtrCampaigns(intent);
    case "set_campaign_status":
      return tools.setCampaignStatus(intent);
    case "adjust_bids":
      return tools.adjustBids(intent);
    case "create_campaign":
      return tools.createCampaign(intent);
    case "promote_low_view_listings":
      return tools.promoteLowViewListings(intent);
    case "add_negative_keywords":
      return tools.addNegativeKeywords(intent);
    case "list_recommendations":
      return tools.listRecommendations();
    case "apply_recommendation":
      return tools.applyRecommendation(intent);
    case "help":
      return tools.help();
    default:
      return tools.fallback();
  }
}

function briefSummary(result: ResultPayload): string {
  switch (result.kind) {
    case "spend_report":
      return `Готово: суммарный расход ${fmtMoney(result.total.spend)} за ${result.period.days} дн.`;
    case "cpa_compare":
      return result.insight;
    case "campaigns":
      return `Найдено ${result.rows.length} кампаний и объявлений.`;
    case "keywords":
      return `Собрал статистику по ${result.rows.length} ключевым фразам.`;
    case "chats":
      return `Сводка по чатам: ${result.summary.total} диалогов, из них ${result.summary.leads} лидов.`;
    case "audit":
      return `Аудит завершён, итоговая оценка ${result.score}/100.`;
    case "recommendations":
      return `Открытых рекомендаций: ${result.rows.filter((r) => r.status === "open").length}.`;
    case "preview":
      return result.verdict === "blocked"
        ? "Действие заблокировано политикой безопасности."
        : "Предпросмотр изменений готов — подтвердите выполнение.";
    default:
      return result.text.split("\n")[0];
  }
}

// ─── Applying / rejecting pending actions ──────────────────────────────────
export async function resolvePending(
  id: number,
  decision: "approve" | "reject",
  actor = "chat",
  ctx?: TenantContext
) {
  const org = ctx?.orgId ?? orgId();
  // Tenant check (defense in depth on top of RLS): the action must belong to
  // the caller's organization. Knowing another org's action id grants nothing.
  const pending = (
    await db.select().from(pendingActions).where(and(eq(pendingActions.id, id), eq(pendingActions.organizationId, org)))
  )[0];
  if (!pending || pending.status !== "pending") {
    // 404-equivalent: do not leak that another org's action exists.
    return null;
  }

  // RBAC: the approver's role must be allowed to execute this action class.
  if (decision === "approve") {
    const approverRole: Role = (ctx?.role as Role) ?? "admin";
    const authz = authorize({ role: approverRole, action: toolToAction(pending.tool) });
    if (authz.decision === "DENY") {
      return insertAgentMessage(`Не могу применить действие: ${authz.reason}. Попросите пользователя с ролью «Медиа-байер» или выше.`, {
        tool: "apply_pending",
        toolLabel: pending.tool,
        platforms: [],
        trace: [{ label: `RBAC: подтверждение запрещено для роли`, detail: authz.reason, status: "block" }],
        durationMs: 60,
        result: { kind: "text", text: authz.reason ?? "Доступ запрещён." },
      });
    }
  }

  if (decision === "reject") {
    const rej = await db.update(pendingActions).set({ status: "rejected" }).where(and(eq(pendingActions.id, id), eq(pendingActions.organizationId, org), eq(pendingActions.status, "pending"))).returning();
    if (!rej.length) {
      return insertAgentMessage("Это действие уже обработано ранее — проверьте журнал аудита.", {
        tool: "apply_pending", toolLabel: "apply_pending", platforms: [],
        trace: [{ label: "Pending-действие уже закрыто", status: "block" }],
        durationMs: 60, result: { kind: "text", text: "Действие уже было обработано." },
      });
    }
    await writeAudit({ actor, tool: pending.tool, params: pending.params, platforms: [], dryRun: false, status: "rejected", summary: `Отклонено пользователем: ${pending.tool} #${id}` });
    return insertAgentMessage("Отменил действие — изменения не применены. Записал в журнал аудита.", {
      tool: "apply_pending",
      toolLabel: pending.tool,
      platforms: [],
      trace: [
        { label: `Подтверждение #${id}: отклонено пользователем`, status: "warn" },
        { label: "Запись в audit-log создана", status: "ok" },
      ],
      durationMs: 80,
      result: { kind: "text", text: "Действие отклонено. Изменения не применялись." },
    });
  }

  // Policy Engine re-check at approval time: limits may have been exhausted since the preview.
  const costDaily = Number(pending.costDaily ?? 0);
  const approvalPolicy = await evaluatePolicy({ tool: pending.tool, isWrite: true, settings: await getSettings(), role: (ctx?.role as Role) ?? "admin", costDaily });
  if (approvalPolicy.action === "block") {
    await db.update(pendingActions).set({ status: "rejected" }).where(and(eq(pendingActions.id, id), eq(pendingActions.organizationId, org), eq(pendingActions.status, "pending")));
    await writeAudit({ actor, tool: pending.tool, params: pending.params, platforms: [], dryRun: false, status: "blocked", summary: `Отклонено при подтверждении #${id}: ${approvalPolicy.reason}` });
    return insertAgentMessage(`Не применил действие #${id}: ${approvalPolicy.reason}`, {
        tool: "apply_pending",
        toolLabel: pending.tool,
        platforms: [],
        trace: [
          { label: `Подтверждение #${id} получено, но лимиты расхода превышены`, status: "block" },
          { label: "Действие отклонено, изменения не применялись", status: "block" },
        ],
        durationMs: 120,
        result: { kind: "text", text: `Действие отклонено: ${approvalPolicy.reason}` },
      });
  }

  const params = (pending.params ?? {}) as Record<string, unknown>;
  const applied = await applyEffect(pending.tool, params);

  // Push the confirmed change to the real platforms (no-op detail in sandbox mode).
  const adapterResults = await writeAdapters(applied.ops);
  const adapterDetail = adapterResults.map((r) => `${r.platform}[${r.mode}]: ${r.detail ?? (r.ok ? "ok" : "error")}`).join("; ");

  const appliedRow = await db.update(pendingActions).set({ status: "applied" }).where(and(eq(pendingActions.id, id), eq(pendingActions.organizationId, org), eq(pendingActions.status, "pending"))).returning();
  if (!appliedRow.length) {
    return insertAgentMessage("Действие не применено: оно уже было обработано или не принадлежит вашей организации.", {
      tool: "apply_pending", toolLabel: "apply_pending", platforms: [],
      trace: [{ label: "Tenant check: действие недоступно", status: "block" }],
      durationMs: 60, result: { kind: "text", text: "Действие не применено." },
    });
  }
  await writeAudit({
    actor,
    tool: pending.tool,
    params,
    platforms: applied.platforms,
    dryRun: false,
    status: "applied",
    summary: `${applied.summary} · адаптеры: ${adapterDetail || "sandbox"}`,
  });

  return insertAgentMessage(`Выполнено: ${applied.summary}. ${adapterDetail ? `Платформы: ${adapterDetail}.` : ""} Все изменения зафиксированы в журнале аудита.`, {
    tool: "apply_pending",
    toolLabel: pending.tool,
    platforms: applied.platforms as Platform[],
    trace: [
      { label: `Подтверждение #${id} получено`, status: "ok" },
      { label: "Локальное зеркало обновлено", detail: applied.summary, status: "ok" },
      { label: "Адаптеры: изменения переданы площадкам", detail: adapterDetail || "sandbox-режим", status: "ok" },
      { label: "Запись в audit-log создана", status: "ok" },
    ],
    durationMs: 240,
    result: { kind: "text", text: `Готово. ${applied.summary}` },
  });
}

interface ApplyResult {
  summary: string;
  platforms: string[];
  ops: { platform: Platform; op: WriteOp }[];
}

async function applyEffect(tool: string, params: Record<string, unknown>): Promise<ApplyResult> {
  switch (tool) {
    case "pause_low_ctr_campaigns": {
      const ids = (params.ids as number[]) ?? [];
      if (ids.length) await db.update(campaigns).set({ status: "paused" }).where(inArray(campaigns.id, ids));
      const names = await db.select({ id: campaigns.id, name: campaigns.name, platform: campaigns.platform }).from(campaigns).where(inArray(campaigns.id, ids));
      const byPlatform = new Map<Platform, number[]>();
      for (const n of names) {
        byPlatform.set(n.platform as Platform, [...(byPlatform.get(n.platform as Platform) ?? []), 0]);
      }
      const ops = [...byPlatform.entries()].map(([platform]) => ({ platform, op: { kind: "campaign_status", campaignIds: ids.filter((i) => names.some((n) => n.id === i)), status: "paused" } as WriteOp }));
      return { summary: `на паузу поставлено ${ids.length} камп. (${names.map((n) => `«${n.name}»`).join(", ")})`, platforms: [...new Set(names.map((n) => n.platform))], ops };
    }
    case "set_campaign_status": {
      const id = Number(params.campaignId);
      const status = params.status === "active" ? "active" : "paused";
      await db.update(campaigns).set({ status }).where(eq(campaigns.id, id));
      const camp = (await db.select({ name: campaigns.name, platform: campaigns.platform }).from(campaigns).where(eq(campaigns.id, id)))[0];
      return {
        summary: `«${camp?.name}» ${status === "active" ? "запущена" : "поставлена на паузу"}`,
        platforms: camp ? [camp.platform] : [],
        ops: camp ? [{ platform: camp.platform as Platform, op: { kind: "campaign_status", campaignIds: [id], status } as WriteOp }] : [],
      };
    }
    case "adjust_bids": {
      const ids = (params.ids as number[]) ?? [];
      const factor = Number(params.factor ?? 1);
      const rows = await db.select().from(keywords).where(inArray(keywords.id, ids));
      for (const k of rows) {
        await db.update(keywords).set({ bid: Math.round(k.bid * factor * 10) / 10 }).where(eq(keywords.id, k.id));
      }
      const campIds = [...new Set(rows.map((k) => k.campaignId))];
      const camps = await db.select({ platform: campaigns.platform }).from(campaigns).where(inArray(campaigns.id, campIds));
      const byPlatform = new Map<Platform, number[]>();
      for (const c of camps) byPlatform.set(c.platform as Platform, [...(byPlatform.get(c.platform as Platform) ?? []), 0]);
      const ops = [...byPlatform.entries()].map(([platform]) => ({ platform, op: { kind: "bids_factor", keywordIds: ids, factor } as WriteOp }));
      return { summary: `ставки изменены ×${factor} по ${ids.length} ключевым фразам`, platforms: [...byPlatform.keys()] as string[], ops };
    }
    case "create_campaign": {
      const platform = (params.platform as string) ?? "google";
      const acc = (await db.select().from(accounts).where(eq(accounts.platform, platform)))[0];
      await db.insert(campaigns).values({
        organizationId: orgId(),
        accountId: acc?.id ?? null,
        platform,
        kind: "campaign",
        externalId: `${platform}-new-${Date.now() % 100000}`,
        name: String(params.name ?? "Новая кампания"),
        status: "active",
        budgetDaily: Number(params.budget ?? 2000),
        strategy: String(params.strategy ?? "Автостратегия"),
      });
      return {
        summary: `кампания «${params.name}» создана в ${PLATFORM_LABEL[platform as Platform]} и запущена`,
        platforms: [platform],
        ops: [{ platform: platform as Platform, op: { kind: "create_campaign", name: String(params.name ?? "Новая кампания"), budgetDaily: Number(params.budget ?? 2000), strategy: String(params.strategy ?? "") } as WriteOp }],
      };
    }
    case "promote_low_view_listings": {
      const ids = (params.ids as number[]) ?? [];
      const service = String(params.service ?? "boost7");
      if (ids.length) await db.update(campaigns).set({ promotion: service === "boost7" ? "boost7" : "turbo" }).where(inArray(campaigns.id, ids));
      return {
        summary: `${ids.length} объявлений Авито подключены к услуге «Поднять в поиске» на 7 дней`,
        platforms: ["avito"],
        ops: [{ platform: "avito", op: { kind: "promote_listings", campaignIds: ids, service } as WriteOp }],
      };
    }
    case "add_negative_keywords": {
      const campaignId = Number(params.campaignId);
      const words = (params.words as string[]) ?? [];
      if (campaignId && words.length) {
        await db.insert(negativeKeywords).values(words.map((w) => ({ campaignId, text: w, source: "agent" })));
      }
      const camp = (await db.select({ name: campaigns.name, platform: campaigns.platform }).from(campaigns).where(eq(campaigns.id, campaignId)))[0];
      return {
        summary: `${words.length} минус-фраз добавлено в «${camp?.name ?? campaignId}»`,
        platforms: camp ? [camp.platform] : [],
        ops: camp ? [{ platform: camp.platform as Platform, op: { kind: "negative_keywords", campaignId, words } as WriteOp }] : [],
      };
    }
    case "apply_recommendation": {
      const ids = (params.ids as number[]) ?? [];
      const recs = await db.select().from(recommendations).where(inArray(recommendations.id, ids));
      const ops: { platform: Platform; op: WriteOp }[] = [];
      let paused = 0;
      let promoted = 0;
      let bids = 0;
      let shifted = 0;
      for (const r of recs) {
        const rp = (r.params ?? {}) as Record<string, unknown>;
        if (r.type === "pause" && r.campaignId) {
          await db.update(campaigns).set({ status: "paused" }).where(eq(campaigns.id, r.campaignId));
          ops.push({ platform: r.platform as Platform, op: { kind: "campaign_status", campaignIds: [r.campaignId], status: "paused" } as WriteOp });
          paused++;
        }
        if (r.type === "promote" && r.campaignId) {
          await db.update(campaigns).set({ promotion: "boost7" }).where(eq(campaigns.id, r.campaignId));
          ops.push({ platform: r.platform as Platform, op: { kind: "promote_listings", campaignIds: [r.campaignId], service: "boost7" } as WriteOp });
          promoted++;
        }
        if (r.type === "bids_up" && r.campaignId) {
          const kws = await db.select({ id: keywords.id }).from(keywords).where(eq(keywords.campaignId, r.campaignId));
          const kwIds = kws.map((k) => k.id).slice(0, 60);
          for (const k of kwIds) {
            const row = (await db.select().from(keywords).where(eq(keywords.id, k)))[0];
            if (row) await db.update(keywords).set({ bid: Math.round(row.bid * 1.1 * 10) / 10 }).where(eq(keywords.id, k));
          }
          if (kwIds.length) ops.push({ platform: r.platform as Platform, op: { kind: "bids_factor", keywordIds: kwIds, factor: 1.1 } as WriteOp });
          bids++;
        }
        if (r.type === "budget_shift" && rp.from && rp.to) {
          const from = rp.from as Platform;
          const to = rp.to as Platform;
          const percent = Number(rp.percent ?? 15);
          const fromCamps = await db.select().from(campaigns).where(and(inArray(campaigns.platform, [from]), eq(campaigns.status, "active")));
          const toCamps = await db.select().from(campaigns).where(and(inArray(campaigns.platform, [to]), eq(campaigns.status, "active")));
          for (const c of fromCamps) {
            const nb = Math.max(100, Math.round(c.budgetDaily * (1 - percent / 100)));
            await db.update(campaigns).set({ budgetDaily: nb }).where(eq(campaigns.id, c.id));
          }
          for (const c of toCamps) {
            const nb = Math.round(c.budgetDaily * (1 + percent / 100));
            await db.update(campaigns).set({ budgetDaily: nb }).where(eq(campaigns.id, c.id));
          }
          if (fromCamps.length) ops.push({ platform: from, op: { kind: "campaign_budget", campaignId: fromCamps[0].id, budgetDaily: Math.max(100, Math.round(fromCamps[0].budgetDaily * (1 - percent / 100))) } as WriteOp });
          shifted++;
        }
      }
      await db.update(recommendations).set({ status: "applied" }).where(inArray(recommendations.id, ids));
      const parts = [
        paused ? `пауза: ${paused}` : "",
        promoted ? `продвижение: ${promoted}` : "",
        bids ? `ставки: ${bids}` : "",
        shifted ? `бюджет: ${shifted}` : "",
      ].filter(Boolean);
      return {
        summary: `применено ${ids.length} рекомендаций (${parts.join(", ") || "статус обновлён"})`,
        platforms: [...new Set(recs.map((r) => r.platform))],
        ops,
      };
    }
    default:
      return { summary: `действие ${tool} выполнено`, platforms: [], ops: [] };
  }
}
