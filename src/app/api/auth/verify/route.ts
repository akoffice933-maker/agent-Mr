// Email verification.
//   POST /api/auth/verify        { token }  — confirm an address
//   POST /api/auth/verify/resend            — reissue (see ./resend/route.ts)

import { NextResponse } from "next/server";
import { verifyEmailToken } from "@/lib/auth/signup";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: { token?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request", reason: "Некорректный запрос." }, { status: 400 });
  }

  const result = await verifyEmailToken(body.token ?? "");
  if (!result.ok) {
    return NextResponse.json({ error: result.code, reason: result.error }, { status: result.code === "expired" ? 410 : 400 });
  }
  return NextResponse.json({ ok: true, alreadyVerified: result.alreadyVerified });
}
