// Policy Engine (Production Hardening v1) — the single decision point that
// answers "is this action allowed?".
//
// The LLM / rule parser only produce a structured intent (tool + parameters).
// They NEVER execute anything. This module decides:
//
//   allow            — read operation, pass through
//   require_approval — write operation → dry-run preview + human confirmation
//                      (+ budget-limit check if the action adds spend)
//   block            — policy violation (read-only mode, limit exceeded)
//
// The same evaluation runs twice: before execution (preview stage) and again
// at approval time (limits may have been exhausted in between).

import { checkBudgetHeadroom } from "./safety";
import type { SafetySettings } from "./safety";

export type PolicyDecision =
  | { action: "allow"; note?: string }
  | { action: "require_approval"; note?: string }
  | { action: "block"; reason: string };

export interface PolicyInput {
  tool: string;
  isWrite: boolean;
  settings: SafetySettings;
  /** Extra ₽/day the action would add (known after the preview is built). */
  costDaily?: number;
}

export async function evaluatePolicy(input: PolicyInput): Promise<PolicyDecision> {
  const { tool: _tool, isWrite, settings, costDaily = 0 } = input;

  // 1. Reads pass without restrictions.
  if (!isWrite) return { action: "allow", note: "Операция чтения" };

  // 2. Read-only mode (default): all writes are blocked.
  if (settings.readOnly) {
    return {
      action: "block",
      reason:
        "Действие заблокировано: включён режим «только чтение» (по умолчанию). Агент анализирует и отчитывается, но не управляет аккаунтами. " +
        "Чтобы разрешить операции — страница «Безопасность» → выключите «Режим только чтение».",
    };
  }

  // 3. Budget limits (daily/weekly/monthly) against the action's added cost.
  if (costDaily > 0) {
    const check = await checkBudgetHeadroom(costDaily);
    if (!check.ok) return { action: "block", reason: check.reason ?? "Превышен лимит расхода." };
  }

  // 4. Every write requires a dry-run preview and explicit human approval.
  return {
    action: "require_approval",
    note: settings.dryRun ? "dry-run включён → подготовлен предпросмотр" : "требуется подтверждение (влияет на бюджет)",
  };
}
