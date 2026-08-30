// Single source of truth for the write/read classification and the RBAC action
// class of every unified tool (review: previously WRITE_TOOLS in router.ts and
// toolToAction in policy.ts were two independent maps with no consistency test).
//
// Invariants (covered by tests/unit/tool-meta.test.ts):
//   1. Every tool reachable by the LLM/rule parser has exactly one TOOL_META.
//   2. kind === "write"  ⇔  action !== "read"  (a write is never classified read).
//   3. kind === "read"   ⇔  the tool must not mutate the provider.
//
// Rule R1: the LLM never decides whether a request is a write — this table does.

import type { Action } from "./rbac";

export type ToolKind = "read" | "write";

export interface ToolMeta {
  name: string;
  kind: ToolKind;
  /** RBAC action class (see rbac.ts). Reads → "read". */
  action: Action;
  /**
   * How the tool is presented in the "Unified Tool Layer" panel on /agent.
   *
   * Review (user-flow pass): that panel used to be a THIRD hand-written list of
   * tools, next to TOOL_META and the dispatch switch. It had already drifted —
   * it advertised 12 tools while 17 existed, hiding `set_campaign_status` and
   * `list_recommendations` (ordinary operations) and `help` (the one command
   * that explains the others). Keeping the label here makes the panel a
   * projection of this table instead of a copy of it.
   *
   * Omit `ui` for tools that are plumbing rather than user-facing (`fallback`).
   */
  ui?: {
    /** Short human description shown under the tool name. */
    desc: string;
    /** Platforms the tool reaches: g = Google Ads, y = Яндекс.Директ, a = Авито. */
    platforms: ("g" | "y" | "a")[];
  };
}

export const TOOL_META: Record<string, ToolMeta> = {
  // Reads / analytics
  get_spend_report: { name: "get_spend_report", kind: "read", action: "read", ui: { desc: "Сводный расход за период", platforms: ["g", "y", "a"] } },
  compare_cpa: { name: "compare_cpa", kind: "read", action: "read", ui: { desc: "Сравнение CPA между площадками", platforms: ["g", "y"] } },
  list_campaigns: { name: "list_campaigns", kind: "read", action: "read", ui: { desc: "Список кампаний и объявлений", platforms: ["g", "y", "a"] } },
  get_keyword_performance: { name: "get_keyword_performance", kind: "read", action: "read", ui: { desc: "Статистика по ключевым фразам", platforms: ["g", "y"] } },
  get_avito_chat_summary: { name: "get_avito_chat_summary", kind: "read", action: "read", ui: { desc: "Сводка по чатам и лидам Авито", platforms: ["a"] } },
  run_account_audit: { name: "run_account_audit", kind: "read", action: "recommend", ui: { desc: "Аудит подключённых кабинетов", platforms: ["g", "y", "a"] } },
  list_recommendations: { name: "list_recommendations", kind: "read", action: "recommend", ui: { desc: "Список открытых рекомендаций", platforms: ["g", "y", "a"] } },
  help: { name: "help", kind: "read", action: "read", ui: { desc: "Справка: что умеет агент", platforms: ["g", "y", "a"] } },
  fallback: { name: "fallback", kind: "read", action: "read" },
  // Writes (all require approval via the Policy Engine)
  pause_low_ctr_campaigns: { name: "pause_low_ctr_campaigns", kind: "write", action: "execute_campaign_status", ui: { desc: "Пауза кампаний с CTR ниже порога", platforms: ["g", "y"] } },
  set_campaign_status: { name: "set_campaign_status", kind: "write", action: "execute_campaign_status", ui: { desc: "Запуск или остановка кампании", platforms: ["g", "y", "a"] } },
  adjust_bids: { name: "adjust_bids", kind: "write", action: "execute_bids", ui: { desc: "Изменение ставок по фильтру", platforms: ["g", "y"] } },
  create_campaign: { name: "create_campaign", kind: "write", action: "execute_budget", ui: { desc: "Создание кампании", platforms: ["g", "y", "a"] } },
  delete_created_campaign: { name: "delete_created_campaign", kind: "write", action: "execute_budget", ui: { desc: "Удаление созданной кампании", platforms: ["g", "y", "a"] } },
  apply_recommendation: { name: "apply_recommendation", kind: "write", action: "execute_budget", ui: { desc: "Применение оптимизационной рекомендации", platforms: ["g", "y", "a"] } },
  promote_low_view_listings: { name: "promote_low_view_listings", kind: "write", action: "execute_promotion", ui: { desc: "Продвижение объявлений с низким охватом", platforms: ["a"] } },
  add_negative_keywords: { name: "add_negative_keywords", kind: "write", action: "execute_negative", ui: { desc: "Добавление минус-фраз", platforms: ["g", "y"] } },
};

/** Tool metadata narrowed to entries that carry a `ui` block. */
export type CatalogEntry = ToolMeta & { ui: NonNullable<ToolMeta["ui"]> };

/**
 * Tools to advertise in the /agent panel, reads first then writes.
 *
 * Derived from TOOL_META so the catalogue cannot silently fall behind the set
 * of tools the agent can actually run.
 */
export function uiToolCatalog(): CatalogEntry[] {
  const entries = Object.values(TOOL_META).filter((m): m is CatalogEntry => Boolean(m.ui));
  const order = (m: CatalogEntry) => (m.kind === "read" ? 0 : 1);
  return entries.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
}

export const WRITE_TOOLS: ReadonlySet<string> = new Set(
  Object.values(TOOL_META).filter((m) => m.kind === "write").map((m) => m.name)
);

export function isWriteTool(tool: string): boolean {
  return WRITE_TOOLS.has(tool);
}

/** Map a unified tool to its RBAC action class (consistent with WRITE_TOOLS). */
export function toolToAction(tool: string): Action {
  return TOOL_META[tool]?.action ?? "read";
}

export function toolMeta(tool: string): ToolMeta | null {
  return TOOL_META[tool] ?? null;
}
