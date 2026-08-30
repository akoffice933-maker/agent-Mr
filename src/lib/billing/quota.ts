// Quota enforcement: turns the numbers in plans.ts into actual refusals.
//
// Design rules, learned from the safety layer in this project:
//
//  1. Fail OPEN on internal errors. A bug in metering must not take an
//     advertiser's account hostage — the worst case of a wrong "allow" is one
//     extra action, the worst case of a wrong "deny" is a paying customer who
//     cannot pause a campaign that is burning money.
//  2. Never block reads. Only actions that change a live ad account count.
//  3. Count what already happened, not what was attempted. A rejected or
//     expired approval never touched the provider, so it must not consume
//     quota — otherwise a user who cancels a mistake is punished for it.
//  4. One message format. The user is told the limit, the usage, and the way
//     out, in Russian, everywhere.

import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { oauthTokens, pendingActions } from "@/db/schema";
import { identityPool } from "@/lib/tenant/pool";
import { entitlements } from "./subscription";
import { PLANS, type PlanLimits } from "./plans";
import { log } from "@/lib/log";

export type QuotaKind = "write_actions" | "platforms" | "members";

export interface QuotaDecision {
  allowed: boolean;
  kind: QuotaKind;
  limit: number;
  used: number;
  plan: string;
  /** Russian, user-facing. Present only when `allowed` is false. */
  reason?: string;
}

/** First moment of the current calendar month (server time). */
export function monthStart(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
}

/**
 * Write actions consumed by the organization this calendar month.
 *
 * Counts pending_actions rows that reached a state where the provider was (or
 * is being) contacted: executing / verified / failed.
 *
 * 'failed' counts on purpose — the request DID reach the provider, and a retry
 * resumes the same action rather than creating a new one. 'pending', 'rejected'
 * and 'expired' do not: nothing was ever sent.
 */
export async function writeActionsThisMonth(orgId: number): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(pendingActions)
    .where(
      and(
        eq(pendingActions.organizationId, orgId),
        gte(pendingActions.createdAt, monthStart()),
        inArray(pendingActions.status, ["executing", "verified", "failed"])
      )
    );
  return Number(rows[0]?.n ?? 0);
}

/** Ad platforms currently connected (one oauth_tokens row per platform). */
export async function connectedPlatforms(orgId: number): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(oauthTokens)
    .where(eq(oauthTokens.organizationId, orgId));
  return Number(rows[0]?.n ?? 0);
}

/**
 * Seats in use: accepted members plus invitations still outstanding.
 *
 * Pending invites count so that an org on a 2-seat plan cannot mail out ten
 * invitations and blow past the limit the moment they are accepted.
 */
export async function usedSeats(orgId: number): Promise<number> {
  const res = (await identityPool.query(
    `SELECT (SELECT count(*) FROM org_members WHERE org_id = $1)
          + (SELECT count(*) FROM org_invites
              WHERE org_id = $1 AND accepted_at IS NULL AND expires_at > now()) AS n`,
    [orgId]
  )) as { rows: { n: string | number }[] };
  return Number(res.rows[0]?.n ?? 0);
}

function upgradeHint(plan: string): string {
  return plan === "pro"
    ? "Напишите нам, чтобы увеличить лимиты."
    : "Тариф Pro снимает это ограничение — раздел «Тарифы».";
}

/**
 * Check a quota WITHOUT consuming it.
 *
 * `entitlements()` already downgrades a lapsed or cancelled subscription to
 * free limits, so callers never deal with subscription status themselves.
 */
export async function checkQuota(orgId: number, kind: QuotaKind): Promise<QuotaDecision> {
  let limits: PlanLimits;
  try {
    limits = await entitlements(orgId);
  } catch (e) {
    // Rule 1: metering must never be the reason an account is unusable.
    log.error("quota.entitlements_failed", { orgId, kind }, e);
    return { allowed: true, kind, limit: -1, used: -1, plan: "unknown" };
  }

  try {
    if (kind === "write_actions") {
      const used = await writeActionsThisMonth(orgId);
      const limit = limits.maxWriteActionsPerMonth;
      if (used < limit) return { allowed: true, kind, limit, used, plan: limits.id };
      return {
        allowed: false,
        kind,
        limit,
        used,
        plan: limits.id,
        reason:
          `Исчерпан месячный лимит изменений на тарифе «${limits.title}»: ${used} из ${limit}. ` +
          `Чтение отчётов и аналитика продолжают работать. ${upgradeHint(limits.id)}`,
      };
    }

    if (kind === "platforms") {
      const used = await connectedPlatforms(orgId);
      const limit = limits.maxPlatforms;
      if (used < limit) return { allowed: true, kind, limit, used, plan: limits.id };
      return {
        allowed: false,
        kind,
        limit,
        used,
        plan: limits.id,
        reason:
          `На тарифе «${limits.title}» можно подключить ${limit} ${limit === 1 ? "рекламную площадку" : "рекламные площадки"}, ` +
          `уже подключено ${used}. ${upgradeHint(limits.id)}`,
      };
    }

    const used = await usedSeats(orgId);
    const limit = limits.maxMembers;
    if (used < limit) return { allowed: true, kind, limit, used, plan: limits.id };
    return {
      allowed: false,
      kind,
      limit,
      used,
      plan: limits.id,
      reason:
        `На тарифе «${limits.title}» доступно ${limit} участник(ов), уже занято ${used} ` +
        `(включая неподтверждённые приглашения). ${upgradeHint(limits.id)}`,
    };
  } catch (e) {
    log.error("quota.check_failed", { orgId, kind }, e);
    return { allowed: true, kind, limit: -1, used: -1, plan: limits.id };
  }
}

/**
 * Platform-connect gate.
 *
 * Re-authorising a platform that is ALREADY connected is always allowed: the
 * token row is upserted, the count does not grow, and refusing it would strand
 * an org whose refresh token expired on a plan they already outgrew.
 * Only a genuinely NEW platform consumes the quota.
 */
export async function canConnectPlatform(orgId: number, platform: string): Promise<QuotaDecision> {
  try {
    const existing = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(oauthTokens)
      .where(and(eq(oauthTokens.organizationId, orgId), eq(oauthTokens.platform, platform)));
    if (Number(existing[0]?.n ?? 0) > 0) {
      const limits = await entitlements(orgId);
      return { allowed: true, kind: "platforms", limit: limits.maxPlatforms, used: -1, plan: limits.id };
    }
  } catch (e) {
    log.error("quota.platform_precheck_failed", { orgId, platform }, e);
    return { allowed: true, kind: "platforms", limit: -1, used: -1, plan: "unknown" };
  }
  return checkQuota(orgId, "platforms");
}

export interface UsageSummary {
  plan: string;
  planTitle: string;
  writeActions: { used: number; limit: number };
  platforms: { used: number; limit: number };
  members: { used: number; limit: number };
  periodResetsAt: string;
}

/** Everything the billing page needs, in one call. */
export async function usageSummary(orgId: number): Promise<UsageSummary> {
  const limits = await entitlements(orgId);
  const [writes, platforms, seats] = await Promise.all([
    writeActionsThisMonth(orgId),
    connectedPlatforms(orgId),
    usedSeats(orgId),
  ]);
  const reset = new Date(monthStart());
  reset.setMonth(reset.getMonth() + 1);

  return {
    plan: limits.id,
    planTitle: limits.title,
    writeActions: { used: writes, limit: limits.maxWriteActionsPerMonth },
    platforms: { used: platforms, limit: limits.maxPlatforms },
    members: { used: seats, limit: limits.maxMembers },
    periodResetsAt: reset.toISOString(),
  };
}

export { PLANS };
