// `emailSent` не должен утверждать, что письмо отправлено, когда SMTP нет.
//
// Без SMTP_HOST sendMail() намеренно работает через console-транспорт: пишет
// письмо в лог и возвращает { ok: true, transport: "console" }. Это удобно
// для self-host — ссылка остаётся достижимой. Но роуты регистрации и
// повторной отправки возвращали клиенту `emailSent: sent.ok`, то есть
// `true`, хотя наружу ничего не ушло.
//
// Цена ошибки: интерфейс говорит «письмо отправлено, проверьте почту»,
// человек ждёт его и не получает никогда. При включённом
// SIGNUP_REQUIRE_VERIFIED_EMAIL он ещё и не сможет войти.
//
// Правильный признак доставки — транспорт, а не факт отсутствия исключения.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sendMail, isSmtpConfigured } from "@/lib/mail";

const SMTP_KEYS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "SMTP_SECURE"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of SMTP_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of SMTP_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("честность признака доставки письма", () => {
  it("без SMTP письмо НЕ доставлено, транспорт console", async () => {
    expect(isSmtpConfigured()).toBe(false);

    const res = await sendMail({ to: "nobody@example.com", subject: "тест", text: "тело" });

    // ok:true здесь означает «вызов не упал», а не «письмо ушло».
    expect(res.ok).toBe(true);
    expect(res.ok && res.transport).toBe("console");
  });

  it("признак доставки берётся из транспорта, а не из ok", async () => {
    const res = await sendMail({ to: "nobody@example.com", subject: "тест", text: "тело" });

    // Ровно это выражение и должно уходить в ответ API.
    const delivered = res.ok && res.transport === "smtp";
    expect(delivered).toBe(false);

    // А наивная версия дала бы ложное «отправлено» — фиксируем разницу,
    // чтобы никто не «упростил» роут обратно до sent.ok.
    expect(res.ok).toBe(true);
    expect(res.ok).not.toBe(delivered);
  });

  it("оба роута сообщают о доставке по транспорту, а не по ok", async () => {
    // Защита от возврата к `emailSent: sent.ok` при рефакторинге.
    const { readFileSync } = await import("node:fs");
    for (const route of [
      "src/app/api/auth/signup/route.ts",
      "src/app/api/auth/verify/resend/route.ts",
    ]) {
      const src = readFileSync(route, "utf8");
      expect(src, `${route}: emailSent должен зависеть от транспорта`).toMatch(
        /emailSent:\s*sent\.ok\s*&&\s*sent\.transport\s*===\s*"smtp"/
      );
    }
  });

  it("isSmtpConfigured реагирует на SMTP_HOST", async () => {
    expect(isSmtpConfigured()).toBe(false);
    process.env.SMTP_HOST = "smtp.example.com";
    expect(isSmtpConfigured()).toBe(true);
  });
});
