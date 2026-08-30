// Subscription state + entitlement checks.
//
// Every org has exactly one subscriptions row (unique index on org_id). A
// missing row is treated as free rather than an error: an org created before
// billing existed must keep working.

import { identityPool } from "@/lib/tenant/pool";
import { planLimits, statusGrantsAccess, type PlanId, type PlanLimits } from "./plans";
import { log } from "@/lib/log";

export interface SubscriptionRow {
  orgId: number;
  plan: string;
  status: string;
  provider: string | null;
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

export async function getSubscription(orgId: number): Promise<SubscriptionRow | null> {
  const res = (await identityPool.query(
    `SELECT org_id, plan, status, provider, provider_customer_id, provider_subscription_id,
            current_period_end, cancel_at_period_end
       FROM subscriptions WHERE org_id = $1 LIMIT 1`,
    [orgId]
  )) as {
    rows: {
      org_id: number;
      plan: string;
      status: string;
      provider: string | null;
      provider_customer_id: string | null;
      provider_subscription_id: string | null;
      current_period_end: Date | null;
      cancel_at_period_end: boolean;
    }[];
  };
  const r = res.rows[0];
  if (!r) return null;
  return {
    orgId: r.org_id,
    plan: r.plan,
    status: r.status,
    provider: r.provider,
    providerCustomerId: r.provider_customer_id,
    providerSubscriptionId: r.provider_subscription_id,
    currentPeriodEnd: r.current_period_end,
    cancelAtPeriodEnd: r.cancel_at_period_end,
  };
}

/**
 * Effective limits for an organization.
 *
 * A paid plan whose status stopped granting access (canceled, unpaid) is
 * downgraded to free limits here, in one place, rather than at each call site.
 * An expired period does the same: if current_period_end is in the past and
 * the provider never renewed, the paid grant is over.
 */
export async function entitlements(orgId: number): Promise<PlanLimits> {
  const sub = await getSubscription(orgId);
  if (!sub) return planLimits("free");
  if (!statusGrantsAccess(sub.status)) return planLimits("free");
  if (sub.currentPeriodEnd && sub.currentPeriodEnd.getTime() < Date.now()) {
    return planLimits("free");
  }
  return planLimits(sub.plan);
}

/** Ensure a row exists (idempotent). */
export async function ensureSubscription(orgId: number): Promise<void> {
  await identityPool.query(
    `INSERT INTO subscriptions (org_id, plan, status) VALUES ($1, 'free', 'active')
     ON CONFLICT (org_id) DO NOTHING`,
    [orgId]
  );
}

export interface PlanUpdate {
  plan: PlanId;
  status: string;
  provider: string;
  providerCustomerId?: string | null;
  providerSubscriptionId?: string | null;
  currentPeriodEnd?: Date | null;
  cancelAtPeriodEnd?: boolean;
}

/** Apply a plan change (called by webhook handlers). Idempotent by nature. */
export async function applyPlanUpdate(orgId: number, u: PlanUpdate): Promise<void> {
  await identityPool.query(
    `INSERT INTO subscriptions (org_id, plan, status, provider, provider_customer_id,
                                provider_subscription_id, current_period_end, cancel_at_period_end, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (org_id) DO UPDATE SET
       plan = EXCLUDED.plan,
       status = EXCLUDED.status,
       provider = EXCLUDED.provider,
       provider_customer_id = COALESCE(EXCLUDED.provider_customer_id, subscriptions.provider_customer_id),
       provider_subscription_id = COALESCE(EXCLUDED.provider_subscription_id, subscriptions.provider_subscription_id),
       current_period_end = EXCLUDED.current_period_end,
       cancel_at_period_end = EXCLUDED.cancel_at_period_end,
       updated_at = now()`,
    [
      orgId,
      u.plan,
      u.status,
      u.provider,
      u.providerCustomerId ?? null,
      u.providerSubscriptionId ?? null,
      u.currentPeriodEnd ?? null,
      u.cancelAtPeriodEnd ?? false,
    ]
  );
  log.info("billing.plan_updated", { orgId, plan: u.plan, status: u.status, provider: u.provider });
}

/**
 * Record a provider event, returning false when it was already processed.
 *
 * Payment providers retry webhooks; without this a retry could upgrade,
 * downgrade or double-count. The unique index on (provider, event_id) makes
 * the check atomic instead of a racy SELECT-then-INSERT.
 */
export async function recordEventOnce(input: {
  provider: string;
  eventId: string;
  eventType: string;
  orgId?: number | null;
  payload?: unknown;
}): Promise<boolean> {
  const res = (await identityPool.query(
    `INSERT INTO payment_events (provider, event_id, event_type, org_id, payload)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (provider, event_id) DO NOTHING
     RETURNING id`,
    [input.provider, input.eventId, input.eventType, input.orgId ?? null, JSON.stringify(input.payload ?? {})]
  )) as { rows: { id: number }[] };
  return res.rows.length > 0;
}

export async function markEventProcessed(provider: string, eventId: string): Promise<void> {
  await identityPool.query(
    `UPDATE payment_events SET processed_at = now() WHERE provider = $1 AND event_id = $2`,
    [provider, eventId]
  );
}
