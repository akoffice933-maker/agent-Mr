import { NextResponse } from "next/server";
import { getUserByEmail } from "@/lib/auth/sessions";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { sessionCookie } from "@/lib/auth/cookies";
import { identityPool } from "@/lib/tenant/pool";
import { clientIpOf } from "@/lib/net/client-ip";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/auth/login — {email, password} → session cookie.
// Brute-force guard lives in the proxy (per-IP rate limit) + in-memory lockout
// (5 fails / 15 min). Timing: password verify always runs when the user exists;
// a dummy scrypt check equalizes timing when it does not.
export async function POST(req: Request) {
  // Review P1.3: this used to read X-Forwarded-For[0] directly, so an attacker
  // could rotate the header on every request and never trip the lockout. Use
  // the same trusted-proxy logic as the rest of the app.
  const ip = clientIpOf(req);
  let body: { email?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";
  if (!email || !password) return NextResponse.json({ error: "email and password required" }, { status: 400 });

  // Lazy import to keep the lockout helpers tree-shakeable and avoid cycles.
  const { loginLockout, recordLoginFailure, recordLoginSuccess, createSession } = await import("@/lib/auth/sessions");
  if (await loginLockout(ip)) {
    return NextResponse.json({ error: "too many failed attempts — try again in 15 minutes" }, { status: 429 });
  }

  const user = await getUserByEmail(email);
  const ok = user ? verifyPassword(password, user.passwordHash) : (verifyPassword(password, DUMMY_HASH), false);
  if (!ok) {
    await recordLoginFailure(ip);
    return NextResponse.json({ error: "invalid credentials" }, { status: 401 });
  }
  await recordLoginSuccess(ip);

  const session = await createSession(user.id, ip, req.headers.get("user-agent") ?? undefined);
  // role is the EFFECTIVE per-org role (from org_members), never the legacy
  // users.role column (dropped in migration 0008).
  const membership = (
    await identityPool.query("SELECT role FROM org_members WHERE user_id = $1 ORDER BY created_at LIMIT 1", [user.id])
  ) as { rows: { role: string }[] };
  const res = NextResponse.json({ ok: true, user: { id: user.id, email: user.email, name: user.name ?? undefined, role: membership.rows[0]?.role } });
  res.headers.set("set-cookie", sessionCookie(session.id));
  return res;
}

// Precomputed hash so the no-user path costs the same as a real verify.
const DUMMY_HASH = hashPassword("agent-mr-timing-equalizer");
