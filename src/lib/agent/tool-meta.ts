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
}

export const TOOL_META: Record<string, ToolMeta> = {
  // Reads / analytics
  get_spend_report: { name: "get_spend_report", kind: "read", action: "read" },
  compare_cpa: { name: "compare_cpa", kind: "read", action: "read" },
  list_campaigns: { name: "list_campaigns", kind: "read", action: "read" },
  get_keyword_performance: { name: "get_keyword_performance", kind: "read", action: "read" },
  get_avito_chat_summary: { name: "get_avito_chat_summary", kind: "read", action: "read" },
  run_account_audit: { name: "run_account_audit", kind: "read", action: "recommend" },
  list_recommendations: { name: "list_recommendations", kind: "read", action: "recommend" },
  help: { name: "help", kind: "read", action: "read" },
  fallback: { name: "fallback", kind: "read", action: "read" },
  // Writes (all require approval via the Policy Engine)
  pause_low_ctr_campaigns: { name: "pause_low_ctr_campaigns", kind: "write", action: "execute_campaign_status" },
  set_campaign_status: { name: "set_campaign_status", kind: "write", action: "execute_campaign_status" },
  adjust_bids: { name: "adjust_bids", kind: "write", action: "execute_bids" },
  create_campaign: { name: "create_campaign", kind: "write", action: "execute_budget" },
  delete_created_campaign: { name: "delete_created_campaign", kind: "write", action: "execute_budget" },
  apply_recommendation: { name: "apply_recommendation", kind: "write", action: "execute_budget" },
  promote_low_view_listings: { name: "promote_low_view_listings", kind: "write", action: "execute_promotion" },
  add_negative_keywords: { name: "add_negative_keywords", kind: "write", action: "execute_negative" },
};

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
