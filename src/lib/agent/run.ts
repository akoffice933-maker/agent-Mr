// Agent core: intent (LLM → rules) → adapter sync → tool routing → safety layer → audit → chat persistence.

import { createHash } from "crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, currentTenant } from "@/db";
import {
  accounts,
  campaigns,
  keywords,
  messages,
  metricsDaily,
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
import { executeAdapters, syncAdapters } from "@/lib/adapters";
import type { AdapterOutcome } from "@/lib/adapters";
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
  delete_created_campaign: "удаление созданной кампании (compensation)",
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

// Deterministic idempotency key for a pending action (E6).
function idempotencyKey(tool: string, params: Record<string, unknown>, org: number): string {
  return createHash("sha256").update(`${org}:${tool}:${JSON.stringify(params)}`).digest("hex").slice(0, 32);
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
    // Strict execution pipeline (Phase E invariant): the raw LLM/user intent is
    // normalized ONCE here into an execution command; the adapter and preview
    // only ever see the normalized command — RBAC can clamp it (LIMITED).
    const execIntent: ParsedIntent = { ...intent, params: { ...intent.params } };
    if (isWrite && prePolicy.action === "require_approval" && prePolicy.bidPercentCap != null && execIntent.tool === "adjust_bids") {
      const cap = prePolicy.bidPercentCap;
      execIntent.params.percent = Math.abs(cap);
      execIntent.params.direction = cap > 0 ? "up" : "down";
      trace.push({ label: `RBAC: изменение ставки ограничено до ±${Math.abs(cap)}% для роли`, status: "warn" });
    }

    const out = await dispatch(execIntent.tool, execIntent, settings);
    result = out.result;
    auditSummary = out.auditSummary;

    if (out.pending) {
      // Policy Engine — full decision including role, risk and added daily cost.
      const costDaily = out.pending.costDaily ?? 0;
      const postRisk = { ...preDispatchRisk(execIntent), costDaily };
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
              idempotencyKey: idempotencyKey(intent.tool, out.pending.params, orgId()),
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
    case "delete_created_campaign":
      return tools.deleteCreatedCampaign(intent);
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

  // ── Execution pipeline (Phase E): pending → executing → provider → read-back → verified | failed
  const params = (pending.params ?? {}) as Record<string, unknown>;

  // Idempotent transition (E6): only pending|failed may enter executing.
  const started = await db
    .update(pendingActions)
    .set({ status: "executing", attempts: sql`${pendingActions.attempts} + 1`, executedAt: new Date(), lastError: null })
    .where(and(eq(pendingActions.id, id), eq(pendingActions.organizationId, org), inArray(pendingActions.status, ["pending", "failed"])))
    .returning();
  if (!started.length) {
    return insertAgentMessage("Действие уже исполняется или уже выполнено — повторная операция не требуется (идемпотентность).", {
      tool: "apply_pending", toolLabel: pending.tool, platforms: [],
      trace: [{ label: "Идемпотентность: переход в executing невозможен (уже executing/verified)", status: "warn" }],
      durationMs: 60, result: { kind: "text", text: "Действие уже исполняется или выполнено." },
    });
  }

  const plan = await planEffect(pending.tool, params, pending.id);

  if (plan.ops.length > 0) {
    // Provider first (E3/E4/E7): execute with retry, capture the provider
    // response and READ BACK the changed resources; verified only on match.
    const adapterResults = await executeAdapters(plan.ops);
    const allVerified = adapterResults.every((r) => r.ok && r.verified);
    const providerResponse: Record<string, unknown> = {};
    const readback: Record<string, unknown> = {};
    for (const r of adapterResults) {
      if (r.providerResponse != null) providerResponse[r.platform] = r.providerResponse;
      if (r.readback != null) readback[r.platform] = r.readback;
    }

    if (!allVerified) {
      const bad = adapterResults.find((r) => !r.ok || !r.verified);
      const errMsg = bad?.error ?? bad?.detail ?? "read-back mismatch";
      // E.1 saga state: a partial provider build carries createdResources +
      // failedAt in the read-back — tell the user exactly what exists and
      // that a retry RESUMES (idempotent by correlation name), plus the
      // cleanup option.
      const partial = (bad?.readback as { createdResources?: { kind: string; id: number; name?: string; adopted?: boolean }[]; failedAt?: string } | undefined) ?? null;
      const partialNote =
        partial?.createdResources?.length
          ? ` На провайдере уже создано: ${partial.createdResources
              .map((r) => `${r.kind === "campaign" ? "кампания" : r.kind === "adgroup" ? "группа" : r.kind === "ad" ? "объявление" : "ключ"} #${r.id}${r.name ? ` «${r.name}»` : ""}`)
              .join(", ")}. Сбой на шаге: ${partial.failedAt ?? "?"}. Повторное подтверждение ПРОДОЛЖИТ создание с места сбоя без дублей (идемпотентность по кореляционному тегу) — или попросите удалить созданные объекты (удаление созданной кампании).`
          : "";
      await db.update(pendingActions).set({ status: "failed", lastError: errMsg, readback: bad?.readback ?? null, providerResponse: bad?.providerResponse ?? null }).where(and(eq(pendingActions.id, id), eq(pendingActions.organizationId, org)));
      await writeAudit({ actor, tool: pending.tool, params, platforms: plan.platforms, dryRun: false, status: "failed", summary: `Исполнение не подтверждено read-back: ${errMsg}${partial?.createdResources?.length ? ` · частичное создание: ${partial.createdResources.length} ресурс(а) на провайдере, сбой на шаге ${partial.failedAt ?? "?"}` : ""}` });
      return insertAgentMessage(`Действие #${id} не подтверждено провайдером: ${errMsg}.${partialNote} Локальное зеркало не менялось; повторное подтверждение запустит новую попытку (попытка ${pending.attempts + 1}).`, {
        tool: "apply_pending",
        toolLabel: pending.tool,
        platforms: plan.platforms as Platform[],
        trace: [
          { label: `Подтверждение #${id} получено, попытка ${pending.attempts + 1}`, status: "ok" },
          { label: "Исполнение у провайдера завершено с ошибкой или read-back не совпал", detail: errMsg, status: "block" },
          { label: "Локальное зеркало НЕ изменено; статус failed (повтор возможен)", status: "warn" },
          { label: "Запись в audit-log создана (failed)", status: "ok" },
        ],
        durationMs: 240,
        result: { kind: "text", text: `Не удалось применить: ${errMsg}` },
      });
    }

    // Verified → the local mirror follows the provider's truth.
    const summary = await plan.applyLocal({ results: adapterResults });
    await db
      .update(pendingActions)
      .set({ status: "verified", verifiedAt: new Date(), providerResponse, readback })
      .where(and(eq(pendingActions.id, id), eq(pendingActions.organizationId, org), eq(pendingActions.status, "executing")));
    await writeAudit({ actor, tool: pending.tool, params, platforms: plan.platforms, dryRun: false, status: "verified", summary: `${summary} · read-back подтверждён` });
    const adapterDetail = adapterResults.map((r) => `${r.platform}[${r.mode}]: ${r.verified ? "read-back OK" : "mismatch"}`).join("; ");
    return insertAgentMessage(`Выполнено и подтверждено read-back: ${summary}. Все изменения зафиксированы в журнале аудита.`, {
      tool: "apply_pending",
      toolLabel: pending.tool,
      platforms: plan.platforms as Platform[],
      trace: [
        { label: `Подтверждение #${id} получено, попытка ${pending.attempts + 1}`, status: "ok" },
        { label: "Исполнение у провайдера: ответ получен", detail: adapterDetail, status: "ok" },
        { label: "Read-back: фактическое состояние совпало с целевым", status: "ok" },
        { label: "Локальное зеркало обновлено", detail: summary, status: "ok" },
        { label: "Статус verified, запись в audit-log создана", status: "ok" },
      ],
      durationMs: 320,
      result: { kind: "text", text: `Готово. ${summary} Изменения подтверждены read-back.` },
    });
  }

  // No provider ops: apply locally and mark verified.
  const summary = await plan.applyLocal({ results: [] });
  await db.update(pendingActions).set({ status: "verified", verifiedAt: new Date() }).where(and(eq(pendingActions.id, id), eq(pendingActions.organizationId, org), eq(pendingActions.status, "executing")));
  await writeAudit({ actor, tool: pending.tool, params, platforms: plan.platforms, dryRun: false, status: "verified", summary });
  return insertAgentMessage(`Выполнено: ${summary}. Записано в журнал аудита.`, {
    tool: "apply_pending", toolLabel: pending.tool, platforms: plan.platforms as Platform[],
    trace: [{ label: `Подтверждение #${id} получено`, status: "ok" }, { label: "Запись в audit-log создана", status: "ok" }],
    durationMs: 120,
    result: { kind: "text", text: `Готово. ${summary}` },
  });
}

interface EffectPlan {
  platforms: string[];
  ops: { platform: Platform; op: WriteOp }[];
  /**
   * Apply the change to the local mirror; returns a human-readable summary.
   * Receives the provider execution results (E.1: create_campaign uses the
   * verified read-back — the REAL provider id — instead of a placeholder).
   */
  applyLocal: (ctx: { results: AdapterOutcome[] }) => Promise<string>;
}

async function planEffect(tool: string, params: Record<string, unknown>, pendingId: number): Promise<EffectPlan> {
  switch (tool) {
    case "pause_low_ctr_campaigns": {
      const ids = (params.ids as number[]) ?? [];
      const names = await db.select({ id: campaigns.id, name: campaigns.name, platform: campaigns.platform }).from(campaigns).where(inArray(campaigns.id, ids));
      const platforms = [...new Set(names.map((n) => n.platform as Platform))];
      const ops: { platform: Platform; op: WriteOp }[] = platforms.map((platform) => ({
        platform,
        op: { kind: "campaign_status", campaignIds: ids.filter((i) => names.some((n) => n.id === i)), status: "paused" },
      }));
      return {
        platforms,
        ops,
        applyLocal: async () => {
          if (ids.length) await db.update(campaigns).set({ status: "paused" }).where(inArray(campaigns.id, ids));
          return `на паузу поставлено ${ids.length} камп. (${names.map((n) => `«${n.name}»`).join(", ")})`;
        },
      };
    }
    case "set_campaign_status": {
      const id = Number(params.campaignId);
      const status = params.status === "active" ? ("active" as const) : ("paused" as const);
      const camp = (await db.select({ name: campaigns.name, platform: campaigns.platform }).from(campaigns).where(eq(campaigns.id, id)))[0];
      return {
        platforms: camp ? [camp.platform as Platform] : [],
        ops: camp ? [{ platform: camp.platform as Platform, op: { kind: "campaign_status", campaignIds: [id], status } }] : [],
        applyLocal: async () => {
          await db.update(campaigns).set({ status }).where(eq(campaigns.id, id));
          return `«${camp?.name}» ${status === "active" ? "запущена" : "поставлена на паузу"}`;
        },
      };
    }
    case "adjust_bids": {
      const ids = (params.ids as number[]) ?? [];
      const factor = Number(params.factor ?? 1);
      const rows = await db.select().from(keywords).where(inArray(keywords.id, ids));
      const campIds = [...new Set(rows.map((k) => k.campaignId))];
      const camps = await db.select({ platform: campaigns.platform }).from(campaigns).where(inArray(campaigns.id, campIds));
      const platforms = [...new Set(camps.map((c) => c.platform as Platform))];
      const ops: { platform: Platform; op: WriteOp }[] = platforms.map((platform) => ({ platform, op: { kind: "bids_factor", keywordIds: ids, factor } }));
      return {
        platforms,
        ops,
        applyLocal: async () => {
          for (const k of rows) {
            await db.update(keywords).set({ bid: Math.round(k.bid * factor * 10) / 10 }).where(eq(keywords.id, k.id));
          }
          return `ставки изменены ×${factor} по ${ids.length} ключевым фразам`;
        },
      };
    }
    case "create_campaign": {
      const platform = (params.platform as string) ?? "google";
      const acc = (await db.select().from(accounts).where(eq(accounts.platform, platform)))[0];
      const strategy = String(params.strategy ?? "");
      return {
        platforms: [platform as Platform],
        ops: [
          {
            platform: platform as Platform,
            op: {
              kind: "create_campaign",
              name: String(params.name ?? "Новая кампания"),
              budgetDaily: Number(params.budget ?? 2000),
              strategy,
              // E.1 idempotency: the provider-side correlation tag is stable
              // for this pending action, so a retried create ADOPTS the
              // already-created campaign instead of duplicating it.
              correlationId: pendingId,
              url: typeof params.url === "string" ? params.url : undefined,
              adGroupName: typeof params.adGroupName === "string" ? params.adGroupName : undefined,
              title: typeof params.title === "string" ? params.title : undefined,
              text: typeof params.text === "string" ? params.text : undefined,
              keywords: Array.isArray(params.keywords) ? (params.keywords as string[]) : undefined,
              negativeKeywords: Array.isArray(params.negativeKeywords) ? (params.negativeKeywords as string[]) : undefined,
              regionIds: Array.isArray(params.regionIds) ? (params.regionIds as number[]) : undefined,
            },
          },
        ],
        applyLocal: async ({ results }) => {
          // E.1: exactly ONE mirror row per provider campaign. Yandex's
          // verified read-back carries the REAL provider id; other platforms
          // (sandbox) keep a placeholder external id.
          const yandexResult = results.find((r) => r.platform === "yandex");
          const rb = yandexResult?.readback as { campaign?: { id?: number }[]; createdResources?: unknown[] } | undefined;
          const realId = Array.isArray(rb?.campaign) && rb.campaign.length ? Number(rb.campaign[0].id) : NaN;
          const externalId = Number.isFinite(realId) ? String(realId) : `${platform}-new-${Date.now() % 100000}`;
          await db.insert(campaigns).values({
            organizationId: orgId(),
            accountId: acc?.id ?? null,
            platform,
            kind: "campaign",
            externalId,
            name: String(params.name ?? "Новая кампания"),
            status: "active",
            budgetDaily: Number(params.budget ?? 2000),
            strategy: strategy || "Автостратегия",
          });
          return `кампания «${params.name}» создана в ${PLATFORM_LABEL[platform as Platform]} и запущена (id ${externalId})`;
        },
      };
    }
    case "delete_created_campaign": {
      // Saga compensation (E.1): remove what a (partially) failed create left
      // at the provider, then drop the local mirror rows.
      const platform = (params.platform as string) ?? "yandex";
      const campaignId = Number(params.campaignId);
      const camp = (await db.select({ id: campaigns.id, name: campaigns.name, platform: campaigns.platform }).from(campaigns).where(eq(campaigns.id, campaignId)))[0];
      if (!camp || camp.platform !== platform) return { platforms: [], ops: [], applyLocal: async () => "кампания не найдена в локальном зеркале" };
      return {
        platforms: [platform as Platform],
        ops: [{ platform: platform as Platform, op: { kind: "delete_campaign_tree", campaignId } }],
        applyLocal: async () => {
          await db.delete(keywords).where(eq(keywords.campaignId, campaignId));
          await db.delete(negativeKeywords).where(eq(negativeKeywords.campaignId, campaignId));
          await db.delete(metricsDaily).where(eq(metricsDaily.campaignId, campaignId));
          await db.delete(campaigns).where(eq(campaigns.id, campaignId));
          return `кампания «${camp.name}» удалена с провайдера и из локального зеркала`;
        },
      };
    }
    case "promote_low_view_listings": {
      const ids = (params.ids as number[]) ?? [];
      const service = String(params.service ?? "boost7");
      return {
        platforms: ["avito"],
        ops: ids.length ? [{ platform: "avito" as Platform, op: { kind: "promote_listings", campaignIds: ids, service } }] : [],
        applyLocal: async () => {
          if (ids.length) await db.update(campaigns).set({ promotion: service === "boost7" ? "boost7" : "turbo" }).where(inArray(campaigns.id, ids));
          return `${ids.length} объявлений Авито подключены к услуге «Поднять в поиске» на 7 дней`;
        },
      };
    }
    case "add_negative_keywords": {
      const campaignId = Number(params.campaignId);
      const words = (params.words as string[]) ?? [];
      const camp = (await db.select({ name: campaigns.name, platform: campaigns.platform }).from(campaigns).where(eq(campaigns.id, campaignId)))[0];
      return {
        platforms: camp ? [camp.platform as Platform] : [],
        ops: camp ? [{ platform: camp.platform as Platform, op: { kind: "negative_keywords", campaignId, words } }] : [],
        applyLocal: async () => {
          if (campaignId && words.length) {
            await db.insert(negativeKeywords).values(words.map((w) => ({ campaignId, text: w, source: "agent" })));
          }
          return `${words.length} минус-фраз добавлено в «${camp?.name ?? campaignId}»`;
        },
      };
    }
    case "apply_recommendation": {
      const ids = (params.ids as number[]) ?? [];
      const recs = await db.select().from(recommendations).where(inArray(recommendations.id, ids));
      const ops: { platform: Platform; op: WriteOp }[] = [];
      const localJobs: (() => Promise<void>)[] = [];
      let paused = 0, promoted = 0, bids = 0, shifted = 0;
      for (const r of recs) {
        const rp = (r.params ?? {}) as Record<string, unknown>;
        if (r.type === "pause" && r.campaignId) {
          const cid = r.campaignId;
          localJobs.push(async () => { await db.update(campaigns).set({ status: "paused" }).where(eq(campaigns.id, cid)); });
          ops.push({ platform: r.platform as Platform, op: { kind: "campaign_status", campaignIds: [cid], status: "paused" } });
          paused++;
        }
        if (r.type === "promote" && r.campaignId) {
          const cid = r.campaignId;
          localJobs.push(async () => { await db.update(campaigns).set({ promotion: "boost7" }).where(eq(campaigns.id, cid)); });
          ops.push({ platform: r.platform as Platform, op: { kind: "promote_listings", campaignIds: [cid], service: "boost7" } });
          promoted++;
        }
        if (r.type === "bids_up" && r.campaignId) {
          const cid = r.campaignId;
          const kws = await db.select({ id: keywords.id }).from(keywords).where(eq(keywords.campaignId, cid));
          const kwIds = kws.map((k) => k.id).slice(0, 60);
          if (kwIds.length) {
            localJobs.push(async () => {
              const rows = await db.select().from(keywords).where(inArray(keywords.id, kwIds));
              for (const k of rows) {
                await db.update(keywords).set({ bid: Math.round(k.bid * 1.1 * 10) / 10 }).where(eq(keywords.id, k.id));
              }
            });
            ops.push({ platform: r.platform as Platform, op: { kind: "bids_factor", keywordIds: kwIds, factor: 1.1 } });
            bids++;
          }
        }
        if (r.type === "budget_shift" && rp.from && rp.to) {
          const from = rp.from as Platform;
          const to = rp.to as Platform;
          const percent = Number(rp.percent ?? 15);
          const fromCamps = await db.select().from(campaigns).where(and(inArray(campaigns.platform, [from]), eq(campaigns.status, "active")));
          const toCamps = await db.select().from(campaigns).where(and(inArray(campaigns.platform, [to]), eq(campaigns.status, "active")));
          localJobs.push(async () => {
            for (const c of fromCamps) {
              const nb = Math.max(100, Math.round(c.budgetDaily * (1 - percent / 100)));
              await db.update(campaigns).set({ budgetDaily: nb }).where(eq(campaigns.id, c.id));
            }
            for (const c of toCamps) {
              const nb = Math.round(c.budgetDaily * (1 + percent / 100));
              await db.update(campaigns).set({ budgetDaily: nb }).where(eq(campaigns.id, c.id));
            }
          });
          if (fromCamps.length) {
            ops.push({ platform: from, op: { kind: "campaign_budget", campaignId: fromCamps[0].id, budgetDaily: Math.max(100, Math.round(fromCamps[0].budgetDaily * (1 - percent / 100))) } });
          }
          shifted++;
        }
      }
      localJobs.push(async () => {
        await db.update(recommendations).set({ status: "applied" }).where(inArray(recommendations.id, ids));
      });
      const parts = [
        paused ? `пауза: ${paused}` : "",
        promoted ? `продвижение: ${promoted}` : "",
        bids ? `ставки: ${bids}` : "",
        shifted ? `бюджет: ${shifted}` : "",
      ].filter(Boolean);
      return {
        platforms: [...new Set(recs.map((r) => r.platform as Platform))],
        ops,
        applyLocal: async () => {
          for (const job of localJobs) await job();
          return `применено ${ids.length} рекомендаций (${parts.join(", ") || "статус обновлён"})`;
        },
      };
    }
    default:
      return { platforms: [], ops: [], applyLocal: async () => `действие ${tool} выполнено` };
  }
}
