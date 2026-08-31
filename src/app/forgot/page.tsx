"use client";

// Запрос ссылки на сброс пароля (ТЗ §9.2).
//
// Экран сознательно отвечает одинаково для любого адреса: «если аккаунт
// существует — письмо отправлено». Сказать «такого пользователя нет» значит
// отдать любому желающему инструмент проверки базы клиентов.

import { useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api-client";
import { Icon } from "@/components/icons";

export default function ForgotPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [manualToken, setManualToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/auth/forgot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const d = (await res.json().catch(() => ({}))) as { manualToken?: string | null; reason?: string };
      if (res.status === 429) {
        setError(d.reason ?? "Слишком много запросов. Попробуйте через минуту.");
        return;
      }
      setManualToken(d.manualToken ?? null);
      setSent(true);
    } catch {
      setError("Сетевая ошибка — попробуйте ещё раз.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-ink px-4">
      <div className="w-full max-w-sm rounded-xl border border-line bg-panel p-5">
        {sent ? (
          <>
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/15 text-accent">
                <Icon name="check" className="h-4 w-4" />
              </span>
              <div className="text-sm font-bold text-snow">Проверьте почту</div>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-fog">
              Если аккаунт с адресом <span className="text-mist">{email}</span> существует, мы отправили на него
              ссылку для смены пароля. Она действует час и сработает один раз.
            </p>
            {manualToken ? (
              <>
                <p className="mt-3 text-xs leading-relaxed text-fog">
                  Почтовый сервер на этом стенде не настроен, поэтому письмо не отправлено — вот ссылка:
                </p>
                <a
                  href={`/reset?token=${manualToken}`}
                  className="mt-2 block break-all rounded-lg border border-line bg-panel2 px-3 py-2 text-[11px] text-accent"
                >
                  /reset?token={manualToken}
                </a>
              </>
            ) : null}
            <Link href="/login" className="mt-4 inline-block text-xs font-semibold text-accent">
              Вернуться ко входу
            </Link>
          </>
        ) : (
          <>
            <div className="text-sm font-bold text-snow">Восстановление пароля</div>
            <p className="mt-2 text-xs leading-relaxed text-fog">
              Укажите email, с которым вы регистрировались. Пришлём ссылку для смены пароля — она действует час.
            </p>
            <form onSubmit={submit} className="mt-4 space-y-3">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.ru"
                required
                autoFocus
                className="w-full rounded-lg border border-line bg-panel2 px-3 py-2.5 text-sm text-snow placeholder:text-fog/60 focus:border-accent/50 focus:outline-none"
              />
              {error ? <div className="text-xs text-bad">{error}</div> : null}
              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-lg bg-accent py-2.5 text-sm font-bold text-accent-ink transition-transform hover:-translate-y-px disabled:opacity-50"
              >
                {busy ? "Отправляем…" : "Прислать ссылку"}
              </button>
            </form>
            <div className="mt-4 flex justify-between text-xs">
              <Link href="/login" className="font-semibold text-fog hover:text-snow">
                Вспомнил пароль
              </Link>
              <Link href="/signup" className="font-semibold text-accent">
                Регистрация
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
