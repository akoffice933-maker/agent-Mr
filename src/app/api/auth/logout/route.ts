import { NextResponse } from "next/server";
import { readSessionCookie, clearSessionCookie } from "@/lib/auth/cookies";
import { revokeSession } from "@/lib/auth/sessions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/auth/logout — revoke the session and clear the cookie.
export async function POST(req: Request) {
  const sid = readSessionCookie(req);
  if (sid) await revokeSession(sid).catch(() => undefined);
  const res = NextResponse.json({ ok: true });
  res.headers.set("set-cookie", clearSessionCookie());
  return res;
}
