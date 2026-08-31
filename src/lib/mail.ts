// Outbound email.
//
// Transports:
//   * SMTP    — when SMTP_HOST is configured (real delivery, nodemailer);
//   * console — otherwise: the message is logged and the call SUCCEEDS.
//
// The console transport is deliberate, not a stub left by accident. Signup
// must not break because a deployment has no mail server yet: the account is
// created either way and the operator can read the verification link from the
// logs. What must never happen is the inverse — a user created, the mail
// silently lost, and no way to finish the flow.
//
// Anything derived from a token is redacted by the logger (src/lib/log.ts).

import { log } from "@/lib/log";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export type MailResult = { ok: true; transport: "smtp" | "console" } | { ok: false; error: string };

export function isSmtpConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_HOST.trim());
}

function mailFrom(): string {
  return process.env.MAIL_FROM?.trim() || "Agent Mr <no-reply@localhost>";
}

/**
 * Public base URL used to build links inside emails.
 *
 * Never derived from a request header: Host/X-Forwarded-Host are attacker
 * controlled, and a poisoned value would send verification links pointing at
 * someone else's domain — a classic account-takeover primitive.
 */
export function appBaseUrl(): string {
  const raw = process.env.APP_BASE_URL?.trim();
  if (!raw) return "http://localhost:3000";
  return raw.replace(/\/+$/, "");
}

export async function sendMail(msg: MailMessage): Promise<MailResult> {
  if (!isSmtpConfigured()) {
    // No SMTP: log the full body so the link is recoverable, and say so loudly
    // enough that an operator notices mail is not actually being delivered.
    log.warn("mail.console_transport", {
      to: msg.to,
      subject: msg.subject,
      hint: "SMTP_HOST is not set — email was NOT delivered. Body follows in mail.body.",
    });
    log.info("mail.body", { to: msg.to, text: msg.text });
    return { ok: true, transport: "console" };
  }

  try {
    // Imported lazily so deployments without SMTP never pay for the dependency.
    const nodemailer = (await import("nodemailer")).default;
    const port = Number(process.env.SMTP_PORT ?? 587);
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      // Implicit TLS on 465; STARTTLS upgrade on 587/25.
      secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === "true" : port === 465,
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD ?? "" }
        : undefined,
    });

    await transport.sendMail({
      from: mailFrom(),
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    });
    log.info("mail.sent", { to: msg.to, subject: msg.subject });
    return { ok: true, transport: "smtp" };
  } catch (e) {
    // Caller decides what to do. Signup treats a failed send as non-fatal:
    // the account exists and verification can be re-requested.
    log.error("mail.send_failed", { to: msg.to, subject: msg.subject }, e);
    return { ok: false, error: e instanceof Error ? e.message : "send failed" };
  }
}

export function passwordResetEmail(link: string): { subject: string; text: string; html: string } {
  return {
    subject: "Сброс пароля — Agent Mr",
    text: [
      "Здравствуйте!",
      "",
      "Вы запросили сброс пароля в Agent Mr. Задайте новый пароль по ссылке:",
      link,
      "",
      "Ссылка действует 1 час и сработает один раз.",
      "После смены пароля все активные сессии будут завершены.",
      "Если вы не запрашивали сброс — просто проигнорируйте это письмо, пароль останется прежним.",
    ].join("\n"),
    html: [
      "<p>Здравствуйте!</p>",
      "<p>Вы запросили сброс пароля в Agent Mr. Задайте новый пароль по ссылке:</p>",
      `<p><a href="${link}">Задать новый пароль</a></p>`,
      `<p style="color:#666;font-size:12px">Ссылка действует 1 час и сработает один раз. После смены пароля все активные сессии будут завершены. Если вы не запрашивали сброс — проигнорируйте это письмо.</p>`,
    ].join(""),
  };
}

export function verificationEmail(link: string): { subject: string; text: string; html: string } {
  return {
    subject: "Подтвердите email — Agent Mr",
    text: [
      "Здравствуйте!",
      "",
      "Подтвердите адрес электронной почты, чтобы завершить регистрацию в Agent Mr:",
      link,
      "",
      "Ссылка действует 24 часа.",
      "Если вы не регистрировались, просто проигнорируйте это письмо.",
    ].join("\n"),
    html: [
      "<p>Здравствуйте!</p>",
      "<p>Подтвердите адрес электронной почты, чтобы завершить регистрацию в Agent Mr:</p>",
      `<p><a href="${link}">Подтвердить email</a></p>`,
      `<p style="color:#666;font-size:12px">Ссылка действует 24 часа. Если вы не регистрировались, просто проигнорируйте это письмо.</p>`,
    ].join(""),
  };
}
