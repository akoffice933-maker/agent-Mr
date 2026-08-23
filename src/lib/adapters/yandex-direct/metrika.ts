// Yandex.Metrica Web API v2 — conversions for Direct campaigns (ТЗ 8.2, День 5 плана).
// Fetches per-day goal visits (reachedGoal) for a counter and maps them onto
// metrics_daily.conversions so CPA becomes meaningful.
//
// Env: METRIKA_API_KEY (Метрика → Настройки → API-ключи, scope statistic:read),
//      METRIKA_COUNTER_ID, METRIKA_GOAL_ID (default 1).

export interface MetrikaDay {
  date: string; // YYYY-MM-DD
  conversions: number;
}

interface MetrikaRow {
  data?: (string | number)[];
}

export function isMetrikaConfigured(): boolean {
  return Boolean(process.env.METRIKA_API_KEY && process.env.METRIKA_COUNTER_ID);
}

/**
 * Daily conversions (reachedGoal) for the counter+goal over [from, to].
 * Returns [] when Metrica is not configured or the request fails (Direct stats
 * still sync; conversions stay 0 — documented limitation, not fatal).
 */
export async function fetchDailyConversions(from: string, to: string): Promise<MetrikaDay[]> {
  if (!isMetrikaConfigured()) return [];
  const apiKey = process.env.METRIKA_API_KEY!;
  const counterId = Number(process.env.METRIKA_COUNTER_ID);
  const goalId = Number(process.env.METRIKA_GOAL_ID ?? 1);

  const url = `https://metrica.yandex.ru/api/v2/statistics/website/visit?counter_id=${counterId}&api_key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      dateFrom: from,
      dateTo: to,
      dimensionFilters: [
        { dimension: "goalId", operator: "EQUALS", value: goalId },
        { dimension: "isBot", operator: "EQUALS", value: 0 },
      ],
      dimensions: ["date"],
      metrics: ["reachedGoal"],
      limit: 5000,
    }),
  });
  if (!res.ok) {
    console.error(`[metrika] API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return [];
  }
  const d = (await res.json()) as { result?: MetrikaRow[] };
  return (d.result ?? []).map((r) => {
    const data = r.data ?? [];
    // row format: [date, reachedGoal] per requested dimensions/metrics order
    const date = String(data[0] ?? "");
    const conv = Number(data[1] ?? 0);
    return date && Number.isFinite(conv) ? { date, conversions: Math.round(conv) } : null;
  }).filter((x): x is MetrikaDay => x !== null);
}
