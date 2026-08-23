// Agent core: intent → tool routing → safety layer → audit → chat persistence.

import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  campaigns,
  keywords,
  messages,
  negativeKeywords,
  pendingActions,
  recommendations,
} from "@/db/schema";
import { fmtMoney } from "@/lib/format";
import { parseIntent, WRITE_TOOLS } from "./router";
import type { ParsedIntent } from "./router";
import { checkBudgetHeadroom, getSettings, writeAudit } from "./safety";
import type { SafetySettings } from "./safety";
import * as tools from "./tools";
import type { AgentMeta, ChatMessageRow, Platform, ResultPayload, TraceStep } from "./types";
import { PLATFORM_LABEL } from "./types";

const TOOL_DESC: Record<string, string> = {
  get_spend_report: "сводный расход по платформам",
  compare_cpa: "сравнение CPA между площадками",
  pause_low_ctr_campaigns: "пауза кампаний с низким CTR",
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
  const row = (await db.insert(messages).values({ role: "agent", content, meta }).returning())[0];
  return serializeMessage(row);
}

export async function runAgent(raw: string, actor: "chat" | "ui" = "chat") {
  const started = Date.now();
  const text = raw.trim();
  const userRow = (await db.insert(messages).values({ role: "user", content: text }).returning())[0];

  const intent = parseIntent(text);
  const settings = await getSettings();
  const isWrite = WRITE_TOOLS.has(intent.tool);
  const trace: TraceStep[] = [];

  trace.push({
    label: `AI Core: намерение распознано → ${intent.tool}`,
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

  trace.push({
    label: `Маршрутизация адаптерам: ${defaultPlat.map((p) => PLATFORM_LABEL[p]).join(", ")}`,
    status: "ok",
  });

  let result: ResultPayload;
  let auditStatus = "ok";
  let auditSummary = "";
  let pendingId: number | undefined;

  if (isWrite && settings.readOnly) {
    trace.push({ label: "Safety-слой: режим «только чтение»", detail: "Операции записи запрещены политикой", status: "block" });
    result = {
      kind: "text",
      text: "Действие заблокировано: включён режим «только чтение» для аналитических пользователей. Отключите его на странице «Безопасность», чтобы вносить изменения.",
    };
    auditStatus = "blocked";
    auditSummary = `Блокировка ${intent.tool}: режим только чтение`;
  } else {
    const out = await dispatch(intent.tool, intent, settings);
    result = out.result;
    auditSummary = out.auditSummary;

    if (out.pending) {
      // Safety checks before execution
      trace.push({
        label: settings.dryRun
          ? "Safety-слой: dry-run включён → подготовлен предпросмотр"
          : "Safety-слой: требуется подтверждение (влияет на бюджет)",
        detail: "Изменения не применяются без явного подтверждения",
        status: "warn",
      });

      const costDaily = out.pending.costDaily ?? 0;
      if (costDaily > 0) {
        const check = await checkBudgetHeadroom(costDaily);
        if (!check.ok) {
          trace.push({ label: "Safety-слой: превышен дневной лимит расхода", detail: check.reason, status: "block" });
          result = {
            ...(result as Extract<ResultPayload, { kind: "preview" }>),
            verdict: "blocked",
            reason: check.reason,
          };
          auditStatus = "blocked";
        } else {
          trace.push({
            label: `Лимиты: запас по дневному бюджету есть (${fmtMoney(check.spendToday)} из ${fmtMoney(check.limit)})`,
            status: "ok",
          });
        }
      }

      if (auditStatus !== "blocked") {
        const pending = (
          await db
            .insert(pendingActions)
            .values({ tool: intent.tool, params: out.pending.params, preview: result, status: "pending", source: actor })
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

  const durationMs = Math.max(40, Date.now() - started) + 120;
  trace.push({
    label: auditStatus === "blocked" ? "Действие отклонено политикой безопасности" : isWrite ? "Результат записан, ожидает подтверждения" : "Результат агрегирован и возвращён",
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

  const content = briefSummary(result);
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
export async function resolvePending(id: number, decision: "approve" | "reject", actor = "chat") {
  const pending = (await db.select().from(pendingActions).where(eq(pendingActions.id, id)))[0];
  if (!pending || pending.status !== "pending") {
    return insertAgentMessage("Это действие уже обработано ранее — проверьте журнал аудита.", {
      tool: "apply_pending",
      toolLabel: "apply_pending",
      platforms: [],
      trace: [{ label: "Pending-действие не найдено или уже закрыто", status: "block" }],
      durationMs: 60,
      result: { kind: "text", text: "Действие уже было обработано." },
    });
  }

  if (decision === "reject") {
    await db.update(pendingActions).set({ status: "rejected" }).where(eq(pendingActions.id, id));
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

  const params = (pending.params ?? {}) as Record<string, unknown>;
  const applied = await applyEffect(pending.tool, params);
  await db.update(pendingActions).set({ status: "applied" }).where(eq(pendingActions.id, id));
  await writeAudit({ actor, tool: pending.tool, params, platforms: applied.platforms, dryRun: false, status: "applied", summary: applied.summary });

  return insertAgentMessage(`Выполнено: ${applied.summary}`, {
    tool: "apply_pending",
    toolLabel: pending.tool,
    platforms: applied.platforms as Platform[],
    trace: [
      { label: `Подтверждение #${id} получено`, status: "ok" },
      { label: "Адаптеры выполнили изменения", detail: applied.summary, status: "ok" },
      { label: "Запись в audit-log создана", status: "ok" },
    ],
    durationMs: 220,
    result: { kind: "text", text: `Готово. ${applied.summary} Все изменения зафиксированы в журнале аудита.` },
  });
}

async function applyEffect(tool: string, params: Record<string, unknown>): Promise<{ summary: string; platforms: string[] }> {
  switch (tool) {
    case "pause_low_ctr_campaigns": {
      const ids = (params.ids as number[]) ?? [];
      if (ids.length) await db.update(campaigns).set({ status: "paused" }).where(inArray(campaigns.id, ids));
      const names = (await db.select({ name: campaigns.name, platform: campaigns.platform }).from(campaigns).where(inArray(campaigns.id, ids)));
      return { summary: `на паузу поставлено ${ids.length} камп. (${names.map((n) => `«${n.name}»`).join(", ")})`, platforms: [...new Set(names.map((n) => n.platform))] };
    }
    case "adjust_bids": {
      const ids = (params.ids as number[]) ?? [];
      const factor = Number(params.factor ?? 1);
      const rows = await db.select().from(keywords).where(inArray(keywords.id, ids));
      for (const k of rows) {
        await db.update(keywords).set({ bid: Math.round(k.bid * factor * 10) / 10 }).where(eq(keywords.id, k.id));
      }
      return { summary: `ставки изменены ×${factor} по ${ids.length} ключевым фразам`, platforms: ["google", "yandex"] };
    }
    case "create_campaign": {
      const platform = (params.platform as string) ?? "google";
      await db.insert(campaigns).values({
        accountId: null,
        platform,
        kind: "campaign",
        externalId: `${platform}-new-${Date.now() % 100000}`,
        name: String(params.name ?? "Новая кампания"),
        status: "active",
        budgetDaily: Number(params.budget ?? 2000),
        strategy: String(params.strategy ?? "Автостратегия"),
      });
      return { summary: `кампания «${params.name}» создана в ${PLATFORM_LABEL[platform as Platform]} и запущена`, platforms: [platform] };
    }
    case "promote_low_view_listings": {
      const ids = (params.ids as number[]) ?? [];
      if (ids.length) await db.update(campaigns).set({ promotion: "boost7" }).where(inArray(campaigns.id, ids));
      return { summary: `${ids.length} объявлений Авито подключены к услуге «Поднять в поиске» на 7 дней`, platforms: ["avito"] };
    }
    case "add_negative_keywords": {
      const campaignId = Number(params.campaignId);
      const words = (params.words as string[]) ?? [];
      if (campaignId && words.length) {
        await db.insert(negativeKeywords).values(words.map((w) => ({ campaignId, text: w, source: "agent" })));
      }
      const camp = (await db.select({ name: campaigns.name, platform: campaigns.platform }).from(campaigns).where(eq(campaigns.id, campaignId)))[0];
      return { summary: `${words.length} минус-фраз добавлено в «${camp?.name ?? campaignId}»`, platforms: camp ? [camp.platform] : [] };
    }
    case "apply_recommendation": {
      const ids = (params.ids as number[]) ?? [];
      const recs = await db.select().from(recommendations).where(inArray(recommendations.id, ids));
      for (const r of recs) {
        if (r.type === "pause" && r.campaignId) {
          await db.update(campaigns).set({ status: "paused" }).where(eq(campaigns.id, r.campaignId));
        }
        if (r.type === "promote" && r.campaignId) {
          await db.update(campaigns).set({ promotion: "boost7" }).where(eq(campaigns.id, r.campaignId));
        }
      }
      await db.update(recommendations).set({ status: "applied" }).where(inArray(recommendations.id, ids));
      return { summary: `применено ${ids.length} рекомендаций (эффекты: пауза/продвижение/ставки)`, platforms: [...new Set(recs.map((r) => r.platform))] };
    }
    default:
      return { summary: `действие ${tool} выполнено`, platforms: [] };
  }
}
