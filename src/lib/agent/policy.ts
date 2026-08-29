// Policy Engine (Phase A + D) — the single deterministic decision point that
// answers "is this action allowed?".
//
// Architecture rule R1: the LLM NEVER makes security decisions. It produces a
// structured intent; this module decides. Final decision =
// Role (RBAC) + Tenant ownership (RLS, Phase C) + Action + Resource + Risk
// + safety settings (read-only toggle, spend limits).
//
// Decisions:
//   allow              — read operation, pass through
//   require_approval   — write operation → dry-run preview + human confirmation
//                        (a product rule for ALL writes, regardless of role)
//   block              — refused (read-only mode, RBAC deny, spend limit)
import { checkBudgetHeadroom } from "./safety";
import type { SafetySettings } from "./safety";
import { authorize, isExecuteAction, type Action, type Role, type RiskContext } from "./rbac";
import { hasScope, scopeForAction } from "./scopes";

export type PolicyDecision =
  | { action: "allow"; note?: string }
  | { action: "require_approval"; note?: string; riskNote?: string; bidPercentCap?: number }
  | { action: "block"; reason: string };

export interface PolicyInput {
  tool: string;
  isWrite: boolean;
  settings: SafetySettings;
  /** extra ₽/day the action would add (known after the preview is built) */
  costDaily?: number;
  role: Role;
  risk?: RiskContext;
  /** null = legacy unrestricted machine key / browser session */
  scopes?: string[] | null;
}

/** Map a unified tool to its RBAC action class. */
export function toolToAction(tool: string): Action {
  switch (tool) {
    case "pause_low_ctr_campaigns":
    case "set_campaign_status":
      return "execute_campaign_status";
    case "adjust_bids":
      return "execute_bids";
    case "create_campaign":
    case "delete_created_campaign":
    case "apply_recommendation":
      return "execute_budget"; // conservative: recommendations can touch bids/budgets
    case "promote_low_view_listings":
      return "execute_promotion";
    case "add_negative_keywords":
      return "execute_negative";
    default:
      // reads, audit, recommendations listing, help
      return "read";
  }
}

export async function evaluatePolicy(input: PolicyInput): Promise<PolicyDecision> {
  const { tool, isWrite, settings, costDaily = 0, role, risk, scopes = null } = input;

  // 1. Reads pass without restrictions.
  if (!isWrite) return { action: "allow", note: "Операция чтения" };

  // 2. Org-level safety toggle: read-only wins over everything (product default).
  if (settings.readOnly) {
    return {
      action: "block",
      reason:
        "Действие заблокировано: включён режим «только чтение» (по умолчанию для организации). " +
        "Агент анализирует и отчитывается, но не управляет аккаунтами. " +
        "Чтобы разрешить операции — страница «Безопасность» → выключите «Режим только чтение» (нужна роль «Администратор» или «Владелец»).",
    };
  }

  // 3. RBAC + risk: may this role initiate this class of action?
  const action = toolToAction(tool);
  if (scopes !== null && !hasScope(scopes, scopeForAction(action))) {
    return { action: "block", reason: `API key не имеет scope: ${scopeForAction(action)}` };
  }
  const authz = authorize({ role, action, context: { ...risk, costDaily: risk?.costDaily ?? costDaily } });
  if (authz.decision === "DENY") {
    return { action: "block", reason: authz.reason ?? "Доступ запрещён." };
  }

  // 4. Spend limits (day/week/month) against the action's added cost.
  if (costDaily > 0) {
    const check = await checkBudgetHeadroom(costDaily);
    if (!check.ok) return { action: "block", reason: check.reason ?? "Превышен лимит расхода." };
  }

  // 5. Every write goes through the approval flow (product rule). RBAC nuance:
  //    large changes get a risk flag; LIMITED applies the bid cap.
  const riskNote = authz.decision === "REQUIRE_APPROVAL" || authz.decision === "LIMITED" ? authz.reason : undefined;
  return {
    action: "require_approval",
    note: settings.dryRun ? "dry-run включён → подготовлен предпросмотр" : "требуется подтверждение (влияет на бюджет)",
    ...(riskNote ? { riskNote } : {}),
    ...(authz.bidPercentCap != null ? { bidPercentCap: authz.bidPercentCap } : {}),
  };
}

export { isExecuteAction };
