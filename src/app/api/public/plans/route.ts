// Публичный источник истины по тарифам (ТЗ §8.4).
//
// Лендинг импортирует PLANS напрямую — он рендерится тем же процессом. Этот
// эндпоинт нужен всем остальным потребителям (внешний сайт на другом домене,
// мобильные лендинги, письма), чтобы цены не пришлось дублировать руками.
//
// Тут нет и не может быть tenant-данных: это те же константы, что лежат в
// репозитории, поэтому маршрут открыт в прокси наравне с /api/health.

import { NextResponse } from "next/server";
import { PLANS } from "@/lib/billing/plans";

export const revalidate = 3600;

export async function GET() {
  const plans = Object.values(PLANS).map((p) => ({
    id: p.id,
    title: p.title,
    price: p.priceMinor / 100,
    priceMinor: p.priceMinor,
    currency: p.currency,
    limits: {
      platforms: p.maxPlatforms,
      writeActionsPerMonth: p.maxWriteActionsPerMonth,
      members: p.maxMembers,
      // Явно: чтение не тарифицируется ни на одном тарифе (см. quota.ts).
      reports: "unlimited" as const,
    },
  }));

  return NextResponse.json(
    { plans },
    { headers: { "Cache-Control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400" } }
  );
}
