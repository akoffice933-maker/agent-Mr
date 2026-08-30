// POST /api/auth/signup — self-serve registration.
//
// Creates user + organization + owner membership + free subscription, sends a
// verification email, and logs the user straight in (a session cookie), so the
// flow ends on a usable product rather than on "now check your inbox".
//
// Rate limiting lives in the proxy (per-IP), same as /api/auth/login.

import { NextResponse } from "next/server";
import { registerAccount, signupMode, normalizeEmail } from "@/lib/auth/signup";
import { createSession } from "@/lib/auth/sessions";
import { sessionCookie } from "@/lib/auth/cookies";
import { appBaseUrl, sendMail, verificationEmail, isSmtpConfigured } from "@/lib/mail";
import { clientIpOf } from "@/lib/net/client-ip";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  // Lets the login page show or hide the "create account" link without
  // hardcoding the deployment's policy in the client bundle.
  return NextResponse.json({ mode: signupMode(), smtp: isSmtpConfigured() });
}

export async function POST(req: Request) {
  if (signupMode() === "off") {
    return NextResponse.json(
      { error: "signup_disabled", reason: "Регистрация закрыта. Обратитесь к администратору." },
      { status: 403 }
    );
  }

  let body: { email?: string; password?: string; name?: string; orgName?: string; inviteCode?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request", reason: "Некорректный запрос." }, { status: 400 });
  }

  const outcome = await registerAccount({
    email: body.email ?? "",
    password: body.password ?? "",
    name: body.name,
    orgName: body.orgName,
    inviteCode: body.inviteCode,
  });

  if (!outcome.ok) {
    const status =
      outcome.code === "email_taken" ? 409 : outcome.code === "signup_disabled" ? 403 : outcome.code === "bad_code" ? 403 : 400;
    return NextResponse.json({ error: outcome.code, reason: outcome.error }, { status });
  }

  const { userId, orgId, verificationToken } = outcome.value;
  const email = normalizeEmail(body.email ?? "");

  // Delivery failure must not undo a successful registration: the account
  // exists, and the user can request another email. Report it instead.
  const link = `${appBaseUrl()}/verify?token=${verificationToken}`;
  const mail = verificationEmail(link);
  const sent = await sendMail({ to: email, subject: mail.subject, text: mail.text, html: mail.html });
  if (!sent.ok) log.warn("signup.verification_email_failed", { userId });

  const ip = clientIpOf(req);
  const session = await createSession(userId, ip, req.headers.get("user-agent") ?? undefined);

  const res = NextResponse.json(
    {
      ok: true,
      user: { id: userId, email, role: "owner" },
      orgId,
      emailSent: sent.ok,
      // Without SMTP the token would be unreachable for a self-hoster, so it is
      // surfaced in that case only — never once real mail is configured.
      verificationToken: !isSmtpConfigured() ? verificationToken : undefined,
    },
    { status: 201 }
  );
  res.headers.set("set-cookie", sessionCookie(session.id));
  return res;
}
