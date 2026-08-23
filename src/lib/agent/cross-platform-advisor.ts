// Cross-Platform Advisor (ТЗ 4.3, US-8): after aggregated analytics the agent
// proposes budget shifts between platforms when CPA/CTR gap exceeds a threshold.
// The suggestion is stored as a recommendation (type "budget_shift") and applied
// only through the standard pending-action confirmation flow.

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { recommendations } from "@/db/schema";
import { fmtMoney } from "@/lib/format";
import { PLATFORM_LABEL, type Platform, type PlatformStat } from "./types";

export interface BudgetShiftSuggestion {
  from: Platform; // the inefficient platform (higher CPA)
  to: Platform; // the efficient platform (lower CPA)
  percent: number; // budget to move
  insight: string;
}

/**
 * Pure decision logic: given per-platform stats for the period, return a
 * budget-shift suggestion if the CPA gap justifies it.
 */
export function suggestBudgetShift(rows: PlatformStat[], thresholdPct = 25, shiftPercent = 15): BudgetShiftSuggestion | null {
  const withCpa = rows.filter((r) => r.cpa !== null && r.spend > 0);
  if (withCpa.length < 2) return null;

  const sorted = [...withCpa].sort((a, b) => (a.cpa ?? 0) - (b.cpa ?? 0));
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];
  if (!best.cpa || best.platform === worst.platform) return null;

  const diffPct = ((worst.cpa! - best.cpa!) / best.cpa!) * 100;
  if (diffPct < thresholdPct) return null;

  return {
    from: worst.platform,
    to: best.platform,
    percent: shiftPercent,
    insight: `CPA в ${PLATFORM_LABEL[worst.platform]} на ${Math.round(diffPct)}% выше, чем в ${PLATFORM_LABEL[best.platform]} (${fmtMoney(worst.cpa)} против ${fmtMoney(best.cpa)}). Предлагаю перенести ${shiftPercent}% бюджета с ${PLATFORM_LABEL[worst.platform]} на ${PLATFORM_LABEL[best.platform]}.`,
  };
}

/**
 * Persists the suggestion as an open recommendation (dedup by text) and returns
 * its id, or null if an identical open recommendation already exists.
 */
export async function persistBudgetShift(s: BudgetShiftSuggestion, periodDays: number): Promise<number | null> {
  const description = `${s.insight} Период: ${periodDays} дн.`;
  const existing = (
    await db.select().from(recommendations).where(and(eq(recommendations.status, "open"), eq(recommendations.type, "budget_shift")))
  )[0];
  if (existing && existing.description === description) return null;
  const row = (
    await db
      .insert(recommendations)
      .values({
        platform: s.from,
        type: "budget_shift",
        description,
        impact: `Перераспределение ${s.percent}% бюджета: ${PLATFORM_LABEL[s.from]} → ${PLATFORM_LABEL[s.to]}`,
        params: { from: s.from, to: s.to, percent: s.percent },
        status: "open",
      })
      .returning()
  )[0];
  return row.id;
}
