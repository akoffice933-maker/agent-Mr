// Plans and entitlements.
//
// The application asks "may this org do X?" and never "is this org paying?".
// Keeping entitlements in one table means adding a plan does not require
// hunting for `plan === "pro"` checks scattered across the codebase.

export type PlanId = "free" | "pro";

export interface PlanLimits {
  id: PlanId;
  title: string;
  /** Monthly price in minor units (kopecks/cents). 0 = free. */
  priceMinor: number;
  currency: "RUB" | "USD";
  /**
   * Connected ad platforms (Google Ads / Яндекс.Директ / Авито).
   *
   * A "connection" is a row in oauth_tokens, which is unique per
   * (org, platform) — so the ceiling is 3 by construction. Free gets one
   * platform, which is the natural trial: the product's whole pitch is running
   * several platforms from one place, and that is exactly what you pay for.
   */
  maxPlatforms: number;
  /**
   * Write actions (pause / bids / create) per calendar month.
   *
   * Reads stay unlimited on every plan: throttling "показать расход" would
   * make the free tier useless as an evaluation and teaches nothing about the
   * paid one. Only actions that change a live ad account are metered.
   */
  maxWriteActionsPerMonth: number;
  /** Team members, including the owner. */
  maxMembers: number;
}

export const PLANS: Record<PlanId, PlanLimits> = {
  free: {
    id: "free",
    title: "Free",
    priceMinor: 0,
    currency: "RUB",
    maxPlatforms: 1,
    maxWriteActionsPerMonth: 50,
    maxMembers: 2,
  },
  pro: {
    id: "pro",
    title: "Pro",
    priceMinor: 490000, // 4 900 ₽
    currency: "RUB",
    // All three platforms — the reason to upgrade.
    maxPlatforms: 3,
    maxWriteActionsPerMonth: 5000,
    maxMembers: 15,
  },
};

export function isPlanId(v: string): v is PlanId {
  return v === "free" || v === "pro";
}

/**
 * Limits for a stored plan value.
 *
 * An unknown plan (a provider sent something unexpected, a manual DB edit)
 * falls back to FREE, never to pro: a broken row must not silently grant paid
 * capacity.
 */
export function planLimits(plan: string | null | undefined): PlanLimits {
  return isPlanId(plan ?? "") ? PLANS[plan as PlanId] : PLANS.free;
}

/** Statuses that still entitle an org to its paid plan. */
export function statusGrantsAccess(status: string | null | undefined): boolean {
  // past_due keeps access on purpose: dunning should nag, not instantly cut
  // off an advertiser mid-campaign over a failed card.
  return status === "active" || status === "trialing" || status === "past_due";
}
