"use client";

import Link from "next/link";
import type { ComponentProps } from "react";
import { track } from "@/lib/analytics";
import type { AnalyticsEvent, AnalyticsMeta } from "@/lib/analytics-events";

// welcome/page.tsx — серверный компонент (ISR); функция-обработчик не может
// пересечь границу RSC как проп для обычного <Link>. Эта тонкая клиентская
// обёртка — единственный кусок /welcome, требующий гидратации.
export function TrackedLink({
  event,
  meta,
  ...props
}: ComponentProps<typeof Link> & { event: AnalyticsEvent; meta?: AnalyticsMeta }) {
  return <Link {...props} onClick={() => track(event, meta)} />;
}
