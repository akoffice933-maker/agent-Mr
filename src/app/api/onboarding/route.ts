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
import { onboardingState, setOnboardingDismissed } from "@/lib/onboarding";
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
      const body = (await req.json().catch(() => ({}))) as { dismissed?: unknown };
      const dismissed = body.dismissed !== false;
      await setOnboardingDismissed(dismissed);
      return NextResponse.json({ ok: true, dismissed });
    });
  } catch (e) {
    log.error("onboarding.post_failed", {}, e);
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
