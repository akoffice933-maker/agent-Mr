// Состояние онбординга для UI (ТЗ §5.2).
//
// Отдельный маршрут, а не расширение /api/settings: чек-лист живёт на
// дашборде и на странице агента, а настройки безопасности — только на
// /safety, и тянуть ради трёх счётчиков всю панель настроек было бы странно.
//
// Прав здесь не проверяем сверх обычного: это агрегированные счётчики
// собственной организации, доступные любому её участнику. Единственная запись
// (скрыть чек-лист) — пользовательская настройка отображения, не действие над
// рекламным кабинетом.

import { NextResponse } from "next/server";
import { withTenantRequest } from "@/lib/tenant/request";
import { onboardingState, setOnboardingDismissed, type DismissState } from "@/lib/onboarding";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    return await withTenantRequest(req, async () => NextResponse.json(await onboardingState()));
  } catch (e) {
    log.error("onboarding.get_failed", {}, e);
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    return await withTenantRequest(req, async () => {
      const body = (await req.json().catch(() => ({}))) as { dismissed?: unknown; snoozeDays?: unknown };
      const snoozeDays = typeof body.snoozeDays === "number" && body.snoozeDays > 0 ? Math.min(body.snoozeDays, 30) : null;
      const value: DismissState = snoozeDays
        ? { until: new Date(Date.now() + snoozeDays * 86_400_000).toISOString() }
        : body.dismissed !== false;
      await setOnboardingDismissed(value);
      return NextResponse.json({ ok: true, dismissed: value });
    });
  } catch (e) {
    log.error("onboarding.post_failed", {}, e);
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
