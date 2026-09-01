"use client";

import type { AnalyticsEvent, AnalyticsMeta } from "@/lib/analytics-events";

// Fire-and-forget по определению: трекинг никогда не блокирует и не может
// провалить пользовательское действие. sendBeacon переживает немедленный
// переход по ссылке (важно для cta_signup_click — клик по <Link> уводит со
// страницы раньше, чем обычный fetch успел бы уйти); fetch+keepalive — когда
// sendBeacon недоступен (SSR-заглушка, старый браузер).
export function track(event: AnalyticsEvent, meta?: AnalyticsMeta): void {
  if (typeof window === "undefined") return;
  const body = JSON.stringify({ event, meta });
  try {
    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: "application/json" });
      if (navigator.sendBeacon("/api/analytics/event", blob)) return;
    }
  } catch {
    // sendBeacon can throw (payload/queue limits) — fall through to fetch.
  }
  fetch("/api/analytics/event", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(
    () => undefined
  );
}
