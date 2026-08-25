// Money / budget conversion — single source of truth for financial math.
//
// Direct API uses "micro" units (1 ₽ = 1 000 000 micros). All conversions
// live here so no floating-point arithmetic touches money anywhere else in
// the codebase (review P1: no ad-hoc Math.round(budget * 7 * 1e6) in adapters).

export const MICROS_PER_RUBLE = 1_000_000;

/** ₽ (number, may carry float noise from UI/LLM) → integer micros. Throws on nonsense. */
export function rublesToMicros(rubles: number): number {
  if (!Number.isFinite(rubles) || rubles < 0) {
    throw new Error(`Money: invalid ruble amount ${rubles}`);
  }
  return Math.round(rubles * MICROS_PER_RUBLE);
}

/** Integer micros → ₽ (number). For display/preview only. */
export function microsToRubles(micros: number): number {
  if (!Number.isInteger(micros) || micros < 0) {
    throw new Error(`Money: invalid micro amount ${micros}`);
  }
  return micros / MICROS_PER_RUBLE;
}

/** Daily budget (₽) → weekly spend limit in integer micros (Direct WbMaximumClicks.WeeklySpendLimit). */
export function dailyRublesToWeeklyMicros(dailyRubles: number): number {
  return rublesToMicros(dailyRubles) * 7;
}
