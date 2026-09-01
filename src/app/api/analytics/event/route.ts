import { NextResponse } from "next/server";
import { getTenantContextOrNull } from "@/lib/auth/dal";
import { recordAnalyticsEvent } from "@/lib/analytics-events";

// Публичный, без авторизации (см. proxy.ts: passThrough + per-IP rate limit).
// getTenantContextOrNull() — тот же DAL, что и у страниц: сессия читается из
// HttpOnly-куки и проверяется в БД, а не доверяется телу запроса. org_id
// подставляется, только если сессия реально есть — событие остаётся
// анонимным (org_id = null) для всей до-логиновой части воронки.
export async function POST(req: Request) {
  let body: { event?: unknown; meta?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const ctx = await getTenantContextOrNull();
  await recordAnalyticsEvent(String(body.event ?? ""), ctx?.orgId ?? null, body.meta);
  // Тихо отвечаем 204 даже на неизвестное имя события — фронтенд не должен
  // ронять пользовательский флоу из-за трекинга, и не даём внешнему
  // вызывающему через код ответа угадывать, какие имена событий валидны.
  return new NextResponse(null, { status: 204 });
}
