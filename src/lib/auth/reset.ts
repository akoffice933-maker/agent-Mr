// Восстановление пароля (ТЗ §9.2).
//
// Три правила, которые определили всю реализацию:
//
//  1. НЕ раскрывать, существует ли аккаунт. `requestPasswordReset` возвращает
//     один и тот же успех для зарегистрированного и незнакомого адреса —
//     иначе форма «забыли пароль» превращается в бесплатный сервис проверки
//     базы клиентов.
//  2. Токен одноразовый, живёт час и хранится ХЕШЕМ. Выпуск нового гасит
//     предыдущие: в почте не должно оставаться несколько рабочих ссылок.
//  3. Смена пароля обрывает ВСЕ сессии пользователя. Сброс пароля — это то,
//     что делают после «кажется, меня взломали»; оставить чужую живую сессию
//     активной значит не решить именно ту проблему, ради которой пришли.
//
// Identity-plane (users, sessions, password_resets) — вне RLS, поэтому всё
// идёт через identityPool, как и остальной код аутентификации.

import { randomBytes } from "crypto";
import { identityPool } from "@/lib/tenant/pool";
import { hashPassword } from "@/lib/auth/password";
import { hashToken, normalizeEmail, validatePassword } from "@/lib/auth/signup";
import { appBaseUrl, isSmtpConfigured, passwordResetEmail, sendMail } from "@/lib/mail";
import { log } from "@/lib/log";

/** Час: достаточно, чтобы дойти до почты, мало для перехваченного письма. */
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

export interface ResetRequestResult {
  /** Всегда true: ответ не зависит от того, нашёлся ли аккаунт. */
  ok: true;
  /**
   * Токен возвращается ТОЛЬКО когда SMTP не настроен (локальная разработка,
   * sandbox) — ровно как это уже сделано для подтверждения email при
   * регистрации. В продакшене с настроенной почтой здесь всегда null.
   */
  manualToken: string | null;
}

export async function requestPasswordReset(email: string, ip?: string): Promise<ResetRequestResult> {
  const addr = normalizeEmail(email ?? "");
  if (!addr) return { ok: true, manualToken: null };

  const found = await identityPool.query<{ id: number; email: string }>(
    "SELECT id, email FROM users WHERE email = $1 LIMIT 1",
    [addr]
  );
  const user = found.rows[0];
  if (!user) {
    // Тайминг тоже не должен отличаться заметно, но главное — ответ и текст.
    log.info("auth.reset_requested_unknown", { email: addr });
    return { ok: true, manualToken: null };
  }

  const token = randomBytes(32).toString("hex");
  const client = await identityPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "UPDATE password_resets SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL",
      [user.id]
    );
    await client.query(
      `INSERT INTO password_resets (user_id, token_hash, expires_at, sent_to, requested_ip)
       VALUES ($1, $2, $3, $4, $5)`,
      [user.id, hashToken(token), new Date(Date.now() + PASSWORD_RESET_TTL_MS), user.email, ip ?? null]
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  const link = `${appBaseUrl()}/reset?token=${token}`;
  const smtp = isSmtpConfigured();
  if (smtp) {
    const msg = passwordResetEmail(link);
    const res = await sendMail({ to: user.email, ...msg });
    if (!res.ok) log.error("auth.reset_mail_failed", { userId: user.id });
  }

  log.info("auth.reset_requested", { userId: user.id, mailed: smtp });
  return { ok: true, manualToken: smtp ? null : token };
}

export type ResetOutcome =
  | { ok: true; userId: number }
  | { ok: false; code: "invalid" | "expired" | "weak"; error: string };

export async function resetPassword(token: string, password: string): Promise<ResetOutcome> {
  const raw = (token ?? "").trim();
  if (!raw) return { ok: false, code: "invalid", error: "Ссылка недействительна или уже использована." };

  // Пароль проверяем ДО обращения к базе: незачем гасить валидный токен из-за
  // того, что человек ввёл шесть символов.
  const pw = validatePassword(password ?? "");
  if (!pw.ok) return { ok: false, code: "weak", error: pw.error ?? "Пароль не подходит." };

  const tokenHash = hashToken(raw);
  const client = await identityPool.connect();
  try {
    await client.query("BEGIN");
    const res = await client.query<{ id: number; user_id: number; expires_at: Date; consumed_at: Date | null }>(
      "SELECT id, user_id, expires_at, consumed_at FROM password_resets WHERE token_hash = $1 LIMIT 1 FOR UPDATE",
      [tokenHash]
    );
    const row = res.rows[0];
    // Одинаковый текст для «не существовал» и «уже использован»: перебирающий
    // токены не должен различать эти случаи.
    if (!row || row.consumed_at) {
      await client.query("ROLLBACK");
      return { ok: false, code: "invalid", error: "Ссылка недействительна или уже использована." };
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      await client.query("ROLLBACK");
      return { ok: false, code: "expired", error: "Срок действия ссылки истёк. Запросите новую." };
    }

    await client.query("UPDATE password_resets SET consumed_at = now() WHERE id = $1", [row.id]);
    await client.query("UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2", [
      hashPassword(password),
      row.user_id,
    ]);
    // Все активные сессии — под нож, включая ту, из которой пришёл злоумышленник.
    await client.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [
      row.user_id,
    ]);
    // Остальные невостребованные токены сброса тоже гасим: их выпускали до
    // смены пароля, и после неё они не должны работать.
    await client.query(
      "UPDATE password_resets SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL",
      [row.user_id]
    );
    await client.query("COMMIT");
    log.info("auth.password_reset", { userId: row.user_id });
    return { ok: true, userId: row.user_id };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
