// RBAC core (Phase D).
//
// Central model — a single structured decision function, NOT scattered
// `if (role === ...)` checks in middleware:
//
//   authorize({ role, action, context }) → ALLOW | DENY | REQUIRE_APPROVAL | LIMITED
//
// Final decision = Role + Tenant ownership (enforced by RLS, Phase C)
//                 + Action + Resource + Risk (context).
//
// Semantics:
//   ALLOW             — the role may initiate this class of action. Every write
//                       STILL passes the product approval flow (dry-run preview
//                       + human confirmation) — that is a product rule, not RBAC.
//   DENY              — refused with a reason (never executed, no preview).
//   REQUIRE_APPROVAL  — goes through the approval flow flagged as a "large
//                       change" (shown in the preview).
//   LIMITED           — allowed with constraints applied (e.g. a media buyer's
//                       bid change is capped to ±RISK.bidPercent).

export type Role = "owner" | "admin" | "media_buyer" | "analyst" | "viewer";

export type Decision = "ALLOW" | "DENY" | "REQUIRE_APPROVAL" | "LIMITED";

export type Action =
  | "read" // stats, reports, lists, audit viewing
  | "recommend" // run audit, view recommendations
  | "execute_campaign_status" // pause / resume campaigns
  | "execute_bids" // bid changes
  | "execute_budget" // budget changes, campaign creation, applying recommendations
  | "execute_promotion" // Avito promotion
  | "execute_negative" // negative keywords
  | "credentials" // platform OAuth connect / platform mode
  | "policy" // safety settings changes
  | "manage_members"; // org membership (owner-only; UI later)

export interface RiskContext {
  /** extra ₽/day the action would add */
  costDaily?: number;
  /** bid change in percent (signed) */
  bidChangePercent?: number;
  /** budget delta in ₽ (signed) */
  budgetDelta?: number;
}

export interface AuthorizationResult {
  decision: Decision;
  reason?: string;
  /** applied constraint (Phase D: bid cap for media buyer) */
  bidPercentCap?: number;
}

/** Risk thresholds. Org-configurable later; fixed for the first SaaS cut. */
export const RISK = {
  /** ₽/day: added spend above this is a "large change" for a media buyer */
  costDailyLarge: 10000,
  /** %: media buyer bid changes are capped at ±this; beyond it — DENY */
  bidPercentCap: 10,
  bidPercentDeny: 25,
  /** ₽: budget delta above this requires approval (any role incl. admin) */
  budgetDeltaLarge: 10000,
};

const MATRIX: Record<Role, Record<Action, Decision>> = {
  viewer: {
    read: "ALLOW",
    recommend: "ALLOW",
    execute_campaign_status: "DENY",
    execute_bids: "DENY",
    execute_budget: "DENY",
    execute_promotion: "DENY",
    execute_negative: "DENY",
    credentials: "DENY",
    policy: "DENY",
    manage_members: "DENY",
  },
  analyst: {
    read: "ALLOW",
    recommend: "ALLOW",
    execute_campaign_status: "DENY",
    execute_bids: "DENY",
    execute_budget: "DENY",
    execute_promotion: "DENY",
    execute_negative: "DENY",
    credentials: "DENY",
    policy: "DENY",
    manage_members: "DENY",
  },
  media_buyer: {
    read: "ALLOW",
    recommend: "ALLOW",
    execute_campaign_status: "ALLOW",
    execute_bids: "ALLOW", // risk-checked below (cap / deny)
    execute_budget: "REQUIRE_APPROVAL", // budget changes always get an explicit approval for a buyer
    execute_promotion: "ALLOW", // risk-checked below (costDaily)
    execute_negative: "ALLOW",
    credentials: "DENY",
    policy: "DENY",
    manage_members: "DENY",
  },
  admin: {
    read: "ALLOW",
    recommend: "ALLOW",
    execute_campaign_status: "ALLOW",
    execute_bids: "ALLOW",
    execute_budget: "ALLOW",
    execute_promotion: "ALLOW",
    execute_negative: "ALLOW",
    credentials: "ALLOW",
    policy: "ALLOW",
    manage_members: "DENY",
  },
  owner: {
    read: "ALLOW",
    recommend: "ALLOW",
    execute_campaign_status: "ALLOW",
    execute_bids: "ALLOW",
    execute_budget: "ALLOW",
    execute_promotion: "ALLOW",
    execute_negative: "ALLOW",
    credentials: "ALLOW",
    policy: "ALLOW",
    manage_members: "ALLOW",
  },
};

export const ROLES: Role[] = ["owner", "admin", "media_buyer", "analyst", "viewer"];

/**
 * Parse a role from storage/headers.
 * FAIL-CLOSED (review P0): an unknown/missing role must NEVER escalate —
 * it maps to the least-privileged role (viewer), not admin. A corrupted row
 * or a stripped internal header yields no execute permissions.
 */
export function parseRole(r: string | null | undefined): Role {
  return (ROLES.includes(r as Role) ? r : "viewer") as Role;
}

export const ROLE_LABEL: Record<Role, string> = {
  owner: "Владелец",
  admin: "Администратор",
  media_buyer: "Медиа-байер",
  analyst: "Аналитик",
  viewer: "Наблюдатель",
};

const EXECUTE_ACTIONS: Action[] = [
  "execute_campaign_status",
  "execute_bids",
  "execute_budget",
  "execute_promotion",
  "execute_negative",
];

export function isExecuteAction(a: Action): boolean {
  return EXECUTE_ACTIONS.includes(a);
}

export function authorize(input: { role: Role; action: Action; context?: RiskContext }): AuthorizationResult {
  const { role, action, context } = input;
  const base = MATRIX[role][action];

  if (base === "DENY") {
    return { decision: "DENY", reason: `Роль «${ROLE_LABEL[role]}» не имеет права: ${action}` };
  }

  // Risk dimension (Role + Action + Resource + Risk = Decision).
  if (role === "media_buyer") {
    if (action === "execute_bids" && context?.bidChangePercent != null) {
      const abs = Math.abs(context.bidChangePercent);
      if (abs > RISK.bidPercentDeny) {
        return {
          decision: "DENY",
          reason: `Изменение ставки ${context.bidChangePercent}% превышает полномочия роли «Медиа-байер» (лимит ±${RISK.bidPercentDeny}%). Обратитесь к администратору.`,
        };
      }
      if (abs > RISK.bidPercentCap) {
        return {
          decision: "LIMITED",
          reason: `Изменение ставки ограничено ±${RISK.bidPercentCap}% для роли «Медиа-байер» — применю ${context.bidChangePercent > 0 ? "+" : ""}${RISK.bidPercentCap}%.`,
          bidPercentCap: context.bidChangePercent > 0 ? RISK.bidPercentCap : -RISK.bidPercentCap,
        };
      }
      return { decision: "ALLOW" };
    }
    const large =
      (context?.costDaily != null && context.costDaily > RISK.costDailyLarge) ||
      (context?.budgetDelta != null && Math.abs(context.budgetDelta) > RISK.budgetDeltaLarge);
    if (large) {
      return {
        decision: "REQUIRE_APPROVAL",
        reason: "Изменение превышает риск-порог роли «Медиа-байер» — требуется явное подтверждение.",
      };
    }
  }

  // Budget-delta risk applies to every role except owner: large deltas always
  // get an explicit approval flag in the preview.
  if (role !== "owner" && context?.budgetDelta != null && Math.abs(context.budgetDelta) > RISK.budgetDeltaLarge) {
    return { decision: "REQUIRE_APPROVAL", reason: `Изменение бюджета ${context.budgetDelta} ₽ превышает порог ${RISK.budgetDeltaLarge} ₽ — требуется явное подтверждение.` };
  }

  return { decision: base };
}
