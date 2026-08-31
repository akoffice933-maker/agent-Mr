// POST /api/auth/forgot  { email } → всегда 200
//
// Ответ намеренно одинаков для существующего и несуществующего адреса
// (см. lib/auth/reset.ts). Ограничение частоты — в прокси, по IP.

import { NextResponse } from "next/server";
import { requestPasswordReset } from "@/lib/auth/reset";
import { clientIpOf } from "@/lib/net/client-ip";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: { email?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request", reason: "Некорректный запрос." }, { status: 400 });
  }

  try {
    const ip = clientIpOf(req);
    const r = await requestPasswordReset(body.email ?? "", ip);
    return NextResponse.json({ ok: true, manualToken: r.manualToken });
  } catch (e) {
    log.error("auth.forgot_failed", {}, e);
    // Даже при сбое не сообщаем, нашёлся ли аккаунт.
    return NextResponse.json({ ok: true, manualToken: null });
  }
}
