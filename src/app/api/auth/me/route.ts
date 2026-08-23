import { NextResponse } from "next/server";
import { readSessionCookie } from "@/lib/auth/cookies";
import { getUserById, validateSession } from "@/lib/auth/sessions";
import { isAuthRequired } from "@/lib/auth-policy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/auth/me — {authMode, user?} or 401 (used by the UI auth guard).
export async function GET(req: Request) {
  if (!isAuthRequired()) {
    return NextResponse.json({ authMode: "off" });
  }
  const sid = readSessionCookie(req);
  const session = await validateSession(sid);
  if (!session) return NextResponse.json({ authMode: "on", error: "unauthorized" }, { status: 401 });
  const user = await getUserById(session.userId);
  if (!user) return NextResponse.json({ authMode: "on", error: "unauthorized" }, { status: 401 });
  return NextResponse.json({
    authMode: "on",
    user: { id: user.id, email: user.email, name: user.name ?? undefined, role: user.role },
  });
}
