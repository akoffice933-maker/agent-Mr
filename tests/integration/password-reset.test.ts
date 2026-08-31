// Восстановление пароля (ТЗ §9.2).
//
// Проверяем не «форма работает», а четыре свойства, ломать которые больнее
// всего и заметить сложнее всего глазами:
//
//   1. Ответ на запрос сброса одинаков для существующего и несуществующего
//      адреса — форма не должна работать сервисом проверки базы клиентов.
//   2. Токен одноразовый: второй вызов с тем же токеном не меняет пароль.
//   3. Просроченный токен не срабатывает (и отличается кодом от битого).
//   4. Смена пароля обрывает ВСЕ сессии пользователя — ровно то, ради чего
//      сброс обычно и делают.

import { afterAll, describe, expect, it } from "vitest";
import { identityPool } from "@/lib/tenant/pool";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { requestPasswordReset, resetPassword, PASSWORD_RESET_TTL_MS } from "@/lib/auth/reset";
import { hashToken } from "@/lib/auth/signup";

const dbUrl = process.env.DATABASE_TEST_URL ?? process.env.DATABASE_URL;
const d = dbUrl ? describe : describe.skip;

const MARKER = "reset-test";
const NEW_PASSWORD = "NewPassw0rd!42";
const userIds: number[] = [];

async function freshUser(): Promise<{ id: number; email: string }> {
  const email = `${MARKER}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const r = await identityPool.query<{ id: number }>(
    "INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id",
    [email, hashPassword("OldPassw0rd!"), MARKER]
  );
  const id = r.rows[0].id;
  userIds.push(id);
  return { id, email };
}

async function passwordHashOf(id: number): Promise<string> {
  const r = await identityPool.query<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = $1", [id]);
  return r.rows[0].password_hash;
}

d("password reset", () => {
  afterAll(async () => {
    if (!dbUrl) return;
    for (const id of userIds) {
      await identityPool.query("DELETE FROM password_resets WHERE user_id = $1", [id]);
      await identityPool.query("DELETE FROM sessions WHERE user_id = $1", [id]);
      await identityPool.query("DELETE FROM org_members WHERE user_id = $1", [id]);
      await identityPool.query("DELETE FROM users WHERE id = $1", [id]);
    }
  });

  it("не выдаёт, существует ли аккаунт", async () => {
    const user = await freshUser();
    const known = await requestPasswordReset(user.email);
    const unknown = await requestPasswordReset(`nobody-${Date.now()}@example.test`);

    // Одинаковая форма ответа. manualToken отличается по необходимости (для
    // несуществующего адреса токена просто нет), но наружу его отдаёт только
    // стенд без SMTP — в проде оба null.
    expect(known.ok).toBe(true);
    expect(unknown.ok).toBe(true);
    expect(unknown.manualToken).toBeNull();
    // Токен несуществующему адресу не выпущен.
    const rows = await identityPool.query("SELECT id FROM password_resets WHERE sent_to LIKE 'nobody-%'");
    expect(rows.rows.length).toBe(0);
  });

  it("хранит только хеш токена и меняет пароль по ссылке", async () => {
    const user = await freshUser();
    const before = await passwordHashOf(user.id);
    const req = await requestPasswordReset(user.email, "203.0.113.7");
    const token = req.manualToken;
    expect(token).toBeTruthy();

    // В базе — хеш, не сам токен: дамп таблицы не даёт рабочей ссылки.
    const stored = await identityPool.query<{ token_hash: string; requested_ip: string | null }>(
      "SELECT token_hash, requested_ip FROM password_resets WHERE user_id = $1",
      [user.id]
    );
    expect(stored.rows[0].token_hash).toBe(hashToken(token!));
    expect(stored.rows[0].token_hash).not.toBe(token);
    expect(stored.rows[0].requested_ip).toBe("203.0.113.7");

    const res = await resetPassword(token!, NEW_PASSWORD);
    expect(res.ok).toBe(true);

    const after = await passwordHashOf(user.id);
    expect(after).not.toBe(before);
    expect(verifyPassword(NEW_PASSWORD, after)).toBe(true);
  });

  it("токен одноразовый", async () => {
    const user = await freshUser();
    const token = (await requestPasswordReset(user.email)).manualToken!;
    expect((await resetPassword(token, NEW_PASSWORD)).ok).toBe(true);

    const second = await resetPassword(token, "SecondTry!12345");
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("invalid");
    // Пароль остался тем, что поставили первым вызовом.
    expect(verifyPassword(NEW_PASSWORD, await passwordHashOf(user.id))).toBe(true);
  });

  it("выпуск нового токена гасит предыдущий", async () => {
    const user = await freshUser();
    const first = (await requestPasswordReset(user.email)).manualToken!;
    const second = (await requestPasswordReset(user.email)).manualToken!;
    expect(first).not.toBe(second);

    const old = await resetPassword(first, NEW_PASSWORD);
    expect(old.ok).toBe(false);
    expect((await resetPassword(second, NEW_PASSWORD)).ok).toBe(true);
  });

  it("просроченный токен не срабатывает", async () => {
    const user = await freshUser();
    const token = (await requestPasswordReset(user.email)).manualToken!;
    await identityPool.query("UPDATE password_resets SET expires_at = now() - interval '1 minute' WHERE user_id = $1", [
      user.id,
    ]);

    const res = await resetPassword(token, NEW_PASSWORD);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("expired");
    expect(PASSWORD_RESET_TTL_MS).toBe(60 * 60 * 1000);
  });

  it("слабый пароль отклоняется и НЕ гасит токен", async () => {
    const user = await freshUser();
    const token = (await requestPasswordReset(user.email)).manualToken!;

    const weak = await resetPassword(token, "123");
    expect(weak.ok).toBe(false);
    if (!weak.ok) expect(weak.code).toBe("weak");

    // Человек ошибся с паролем — ссылка обязана остаться рабочей.
    expect((await resetPassword(token, NEW_PASSWORD)).ok).toBe(true);
  });

  it("смена пароля обрывает все сессии пользователя", async () => {
    const user = await freshUser();
    for (const s of ["sess-a", "sess-b"]) {
      await identityPool.query(
        "INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')",
        [`${MARKER}-${user.id}-${s}`, user.id]
      );
    }
    const live = async () =>
      (
        await identityPool.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL",
          [user.id]
        )
      ).rows[0].n;
    expect(await live()).toBe("2");

    const token = (await requestPasswordReset(user.email)).manualToken!;
    expect((await resetPassword(token, NEW_PASSWORD)).ok).toBe(true);
    expect(await live()).toBe("0");
  });
});
