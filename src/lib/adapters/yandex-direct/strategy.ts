// Deterministic mapping: agent strategy → Yandex Direct bidding strategy
// (review P0: "strategy mapping без hardcode" — the AI preview and the real
// campaign must never diverge; the adapter must not silently force
// WB_MAXIMUM_CLICKS for any request).
//
// Both the agent preview (tools.ts) and the execution (campaign-builder.ts)
// resolve the strategy through this module, so what the user approves is
// what gets created.

import { dailyRublesToWeeklyMicros, rublesToMicros } from "@/lib/money";

export type StrategyKey =
  | "maximum_clicks"
  | "maximum_conversions"
  | "manual_cpc"
  | "target_cpa";

export interface StrategyDef {
  key: StrategyKey;
  /** human label (ru) — used in previews and audit */
  label: string;
  /** LLM-facing description for the tool schema */
  hint: string;
  /** direct API BiddingStrategyType (Search placements) */
  directType: string;
}

export const STRATEGIES: Record<StrategyKey, StrategyDef> = {
  maximum_clicks: {
    key: "maximum_clicks",
    label: "Максимум кликов",
    hint: "Автостратегия: максимум кликов в рамках недельного бюджета",
    directType: "WB_MAXIMUM_CLICKS",
  },
  maximum_conversions: {
    key: "maximum_conversions",
    label: "Максимум конверсий",
    hint: "Автостратегия: максимум конверсий (нужны цели конверсий в кампаний)",
    directType: "WB_MAXIMUM_CONVERSIONS",
  },
  manual_cpc: {
    key: "manual_cpc",
    label: "Ручное управление ставками (CPC)",
    hint: "Ставы задаются на ключевых фразах вручную; максимальная ставка по запросу",
    directType: "MANUAL_CPC",
  },
  target_cpa: {
    key: "target_cpa",
    label: "Целевая стоимость конверсии (CPA)",
    hint: "Целевая цена конверсии, ₽",
    directType: "TARGET_CPA",
  },
};

export const STRATEGY_KEYS = Object.keys(STRATEGIES) as StrategyKey[];

// Legacy values the agent/DB already carry (pre-mapping era) → canonical key.
const LEGACY_ALIASES: Record<string, StrategyKey> = {
  "максимум кликов": "maximum_clicks",
  "максимум кликов (автостратегия)": "maximum_clicks",
  "максимум конверсий": "maximum_conversions",
  "ручное управление ставками (cpc)": "manual_cpc",
  "ручное управление ставками": "manual_cpc",
  "целевая стоимость конверсии (cpa)": "target_cpa",
  "целевая стоимость конверсии": "target_cpa",
  "wb_maximum_clicks": "maximum_clicks",
  "wb_maximum_conversions": "maximum_conversions",
  manual_cpc: "manual_cpc",
  target_cpa: "target_cpa",
  maximum_clicks: "maximum_clicks",
  maximum_conversions: "maximum_conversions",
};

/**
 * Resolve any strategy input (canonical key, legacy ru label, direct type,
 * garbage) to a canonical key. Unknown/empty → default (maximum_clicks) but
 * the caller is expected to surface the resolved label so the preview shows
 * the truth; garbage never maps to a MORE aggressive strategy.
 */
export function resolveStrategy(input: string | null | undefined): StrategyKey {
  const norm = (input ?? "").trim().toLowerCase();
  if (!norm) return "maximum_clicks";
  if ((STRATEGY_KEYS as string[]).includes(norm)) return norm as StrategyKey;
  const aliased = LEGACY_ALIASES[norm];
  if (aliased) return aliased;
  // Direct type round-trip (WB_MAXIMUM_CLICKS etc.)
  const byDirect = STRATEGY_KEYS.find((k) => STRATEGIES[k].directType.toLowerCase() === norm);
  if (byDirect) return byDirect;
  return "maximum_clicks";
}

export function strategyLabel(input: string | null | undefined): string {
  return STRATEGIES[resolveStrategy(input)].label;
}

/**
 * Build the Direct BiddingStrategy payload for Search (campaign create).
 * @param strategy canonical key
 * @param weeklyBudgetMicros weekly spend limit (integer micros)
 * @param maxCpcRubles max bid for manual_cpc (₽)
 * @param maxCpaRubles target CPA (₽)
 */
export function buildBiddingStrategy(
  strategy: StrategyKey,
  weeklyBudgetMicros: number,
  maxCpcRubles?: number,
  maxCpaRubles?: number
): Record<string, unknown> {
  const base = {
    Search: {
      PlacementTypes: { SearchResults: "YES", DynamicPlaces: "YES" },
    },
    Network: { BiddingStrategyType: "SERVING_OFF" },
  };
  switch (strategy) {
    case "maximum_conversions":
      return {
        ...base,
        Search: { ...base.Search, BiddingStrategyType: "WB_MAXIMUM_CONVERSIONS", WbMaximumConversions: { WeeklySpendLimit: weeklyBudgetMicros } },
      };
    case "manual_cpc":
      return {
        ...base,
        Search: {
          ...base.Search,
          BiddingStrategyType: "MANUAL_CPC",
          ManualCpc: { MaxCpc: rublesToMicros(maxCpcRubles ?? 10), MinCpc: rublesToMicros(1) },
        },
      };
    case "target_cpa":
      return {
        ...base,
        Search: {
          ...base.Search,
          BiddingStrategyType: "TARGET_CPA",
          TargetCpa: { DefaultMaxCpa: rublesToMicros(maxCpaRubles ?? 500) },
        },
      };
    case "maximum_clicks":
    default:
      return {
        ...base,
        Search: { ...base.Search, BiddingStrategyType: "WB_MAXIMUM_CLICKS", WbMaximumClicks: { WeeklySpendLimit: weeklyBudgetMicros } },
      };
  }
}

// ─── Unified performance campaigns (RESPONSIVE_AD path) ─────────────────────
//
// UnifiedCampaign uses a DIFFERENT strategy vocabulary than TextCampaign
// (no WB_MAXIMUM_CONVERSIONS / MANUAL_CPC / TARGET_CPA):
//   maximum_clicks     → WB_MAXIMUM_CLICKS          (weekly budget)
//   manual_cpc         → AVERAGE_CPC                (avg. click price)
//   maximum_conversions→ WB_MAXIMUM_CONVERSION_RATE (requires a goal)
//   target_cpa         → AVERAGE_CPA                (requires a goal)
// Conversion strategies need a Metrika goal (GoalId). The builder looks one up
// (clients.getGoals, best effort); without a goal we fall back to
// WB_MAXIMUM_CLICKS and return a VISIBLE note — never a silent divergence
// between the approved preview and what the provider creates.

export interface UnifiedStrategyResult {
  /** UnifiedCampaign.BiddingStrategy payload ({ Search, Network }). */
  payload: { Search: Record<string, unknown>; Network: Record<string, unknown> };
  /** Unified BiddingStrategyType actually used on Search. */
  used: string;
  /** human note when the strategy was adapted (e.g. no goal → fallback). */
  note?: string;
}

export function buildUnifiedBiddingStrategy(
  strategy: StrategyKey,
  weeklyBudgetMicros: number,
  maxCpcRubles?: number,
  maxCpaRubles?: number,
  goalId?: number | null
): UnifiedStrategyResult {
  const searchBase = { PlacementTypes: { SearchResults: "YES" } };
  const network = { BiddingStrategyType: "SERVING_OFF" };
  const fallback = (reason: string): UnifiedStrategyResult => ({
    used: "WB_MAXIMUM_CLICKS",
    note: `${reason} — применено «Максимум кликов» (еженедельный бюджет)`,
    payload: {
      Network: network,
      Search: { ...searchBase, BiddingStrategyType: "WB_MAXIMUM_CLICKS", WbMaximumClicks: { WeeklySpendLimit: weeklyBudgetMicros } },
    },
  });

  switch (strategy) {
    case "manual_cpc":
      return {
        used: "AVERAGE_CPC",
        payload: {
          Network: network,
          Search: {
            ...searchBase,
            BiddingStrategyType: "AVERAGE_CPC",
            AverageCpc: { AverageCpc: rublesToMicros(maxCpcRubles ?? 10), WeeklySpendLimit: weeklyBudgetMicros },
          },
        },
      };
    case "maximum_conversions":
      if (goalId) {
        return {
          used: "WB_MAXIMUM_CONVERSION_RATE",
          payload: {
            Network: network,
            Search: {
              ...searchBase,
              BiddingStrategyType: "WB_MAXIMUM_CONVERSION_RATE",
              WbMaximumConversionRate: { WeeklySpendLimit: weeklyBudgetMicros, GoalId: goalId },
            },
          },
        };
      }
      return fallback("цель конверсии в аккаунте не найдена");
    case "target_cpa":
      if (goalId) {
        return {
          used: "AVERAGE_CPA",
          payload: {
            Network: network,
            Search: {
              ...searchBase,
              BiddingStrategyType: "AVERAGE_CPA",
              AverageCpa: { AverageCpa: rublesToMicros(maxCpaRubles ?? 500), GoalId: goalId, WeeklySpendLimit: weeklyBudgetMicros },
            },
          },
        };
      }
      return fallback("цель конверсии в аккаунте не найдена");
    case "maximum_clicks":
    default:
      return {
        used: "WB_MAXIMUM_CLICKS",
        payload: {
          Network: network,
          Search: { ...searchBase, BiddingStrategyType: "WB_MAXIMUM_CLICKS", WbMaximumClicks: { WeeklySpendLimit: weeklyBudgetMicros } },
        },
      };
  }
}

// re-export for convenience in previews (weekly budget math in one place)
export { dailyRublesToWeeklyMicros };
