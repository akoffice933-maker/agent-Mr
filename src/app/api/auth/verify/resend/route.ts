// POST /api/auth/verify/resend — reissue the verification email.
//
// Requires a logged-in session: an unauthenticated resend endpoint taking an
// arbitrary address is a free mail cannon pointed at anyone.

import { NextResponse } from "next/server";
import { identityPool } from "@/lib/tenant/pool";
import { readSessionCookie } from "@/lib/auth/cookies";
import { validateSession } from "@/lib/auth/sessions";
import { issueVerificationToken } from "@/lib/auth/signup";
import { appBaseUrl, sendMail, verificationEmail, isSmtpConfigured } from "@/lib/mail";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const session = await validateSession(readSessionCookie(req));
  if (!session) {
    return NextResponse.json({ error: "unauthorized", reason: "Требуется вход." }, { status: 401 });
  }

  const res = (await identityPool.query("SELECT email, email_verified_at FROM users WHERE id = $1 LIMIT 1", [
    session.userId,
  ])) as { rows: { email: string; email_verified_at: Date | null }[] };
  const user = res.rows[0];
  if (!user) return NextResponse.json({ error: "not_found" }, { status: 404 });

  if (user.email_verified_at) {
    return NextResponse.json({ ok: true, alreadyVerified: true });
  }

  const token = await issueVerificationToken(session.userId, user.email);
  const link = `${appBaseUrl()}/verify?token=${token}`;
  const mail = verificationEmail(link);
  const sent = await sendMail({ to: user.email, subject: mail.subject, text: mail.text, html: mail.html });

  return NextResponse.json({
    ok: sent.ok,
    emailSent: sent.ok,
    verificationToken: !isSmtpConfigured() ? token : undefined,
  });
}
