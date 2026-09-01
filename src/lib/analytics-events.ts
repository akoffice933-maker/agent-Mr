// Product-analytics для self-serve воронки (не путать с рекламной
// аналитикой самого продукта — это метрики продукта О продукте).
//
// Событие — фиксированный allowlist, а не свободная строка от анонимного
// вызывающего: /api/analytics/event открыт без авторизации (landing_view
// и cta_signup_click происходят ДО логина), поэтому нельзя доверять телу
// запроса ничего, кроме выбора из заранее known значений.
import { identityPool } from "@/lib/tenant/pool";

export const ANALYTICS_EVENTS = [
  "landing_view",
  "cta_signup_click",
  "signup_complete",
  "oauth_started",
  "oauth_done",
  "first_agent_message",
  "first_approve",
] as const;

export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[number];

export function isAnalyticsEvent(value: unknown): value is AnalyticsEvent {
  return typeof value === "string" && (ANALYTICS_EVENTS as readonly string[]).includes(value);
}

// meta — только примитивы верхнего уровня, никаких вложенных объектов и без
// PII (ТЗ §1.6 ревью): platform ("google"/"yandex"/"avito") и подобные
// короткие ярлыки, не текст пользователя.
export type AnalyticsMeta = Record<string, string | number | boolean>;

function sanitizeMeta(meta: unknown): AnalyticsMeta | null {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const out: AnalyticsMeta = {};
  let count = 0;
  for (const [k, v] of Object.entries(meta as Record<string, unknown>)) {
    if (count >= 8) break; // маленький, фиксированный потолок — не лог произвольных объектов
    if (typeof k !== "string" || k.length > 40) continue;
    if (typeof v === "string" && v.length <= 200) out[k] = v;
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "boolean") out[k] = v;
    else continue;
    count++;
  }
  return count > 0 ? out : null;
}

/** identity-plane запись — как reset.ts/dal.ts, напрямую через identityPool, без RLS. */
export async function recordAnalyticsEvent(event: string, orgId: number | null, meta?: unknown): Promise<boolean> {
  if (!isAnalyticsEvent(event)) return false;
  const clean = sanitizeMeta(meta);
  await identityPool.query("INSERT INTO analytics_events (event, org_id, meta) VALUES ($1, $2, $3)", [
    event,
    orgId,
    clean ? JSON.stringify(clean) : null,
  ]);
  return true;
}
