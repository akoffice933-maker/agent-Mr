// POST /api/auth/reset  { token, password }
//
// Успех НЕ логинит пользователя автоматически: после смены пароля все сессии
// завершены, и осознанный вход новым паролем — это ещё и проверка, что он
// действительно запомнился.

import { NextResponse } from "next/server";
import { resetPassword } from "@/lib/auth/reset";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: { token?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request", reason: "Некорректный запрос." }, { status: 400 });
  }

  try {
    const r = await resetPassword(body.token ?? "", body.password ?? "");
    if (!r.ok) {
      const status = r.code === "expired" ? 410 : 400;
      return NextResponse.json({ error: r.code, reason: r.error }, { status });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    log.error("auth.reset_failed", {}, e);
    return NextResponse.json({ error: "internal", reason: "Не удалось сменить пароль. Попробуйте ещё раз." }, { status: 500 });
  }
}
