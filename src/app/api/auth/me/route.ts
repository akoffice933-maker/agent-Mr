import { NextResponse } from "next/server";
import { readSessionCookie } from "@/lib/auth/cookies";
import { getUserById, validateSession } from "@/lib/auth/sessions";
import { isAuthRequired } from "@/lib/auth-policy";
import { identityPool } from "@/lib/tenant/pool";

export const dynamic = "force-dynamic";

// GET /api/auth/me — {authMode, user?, org?} or 401 (used by the UI auth guard).
export async function GET(req: Request) {
  if (!isAuthRequired()) {
    return NextResponse.json({ authMode: "off" });
  }
  const sid = readSessionCookie(req);
  const session = await validateSession(sid);
  if (!session) return NextResponse.json({ authMode: "on", error: "unauthorized" }, { status: 401 });
  const user = await getUserById(session.userId);
  if (!user) return NextResponse.json({ authMode: "on", error: "unauthorized" }, { status: 401 });
  // primary org membership
  const r = await identityPool.query(
    "SELECT org_id, role FROM org_members WHERE user_id = $1 ORDER BY created_at LIMIT 1",
    [user.id]
  );
  const membership = (r as { rows: { org_id: number; role: string }[] }).rows[0];
  return NextResponse.json({
    authMode: "on",
    // role is the EFFECTIVE per-org role (from org_members), never the legacy
    // users.role column (dropped in migration 0008).
    user: { id: user.id, email: user.email, name: user.name ?? undefined, role: membership?.role },
    org: membership ? { id: membership.org_id, role: membership.role } : undefined,
  });
}
