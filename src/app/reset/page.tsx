"use client";

// Установка нового пароля по ссылке из письма (ТЗ §9.2).
//
// После успеха НЕ логиним автоматически: сброс завершает все сессии, и вход
// новым паролем — заодно проверка, что он действительно запомнился.

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api-client";
import { Icon } from "@/components/icons";

export default function ResetPage() {
  const router = useRouter();
  // Токен читаем из window, а не через useSearchParams(): иначе страница
  // требует Suspense-обёртки ради одного параметра.
  const [token] = useState(() =>
    typeof window === "undefined" ? "" : (new URLSearchParams(window.location.search).get("token") ?? "")
  );
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== repeat) {
      setError("Пароли не совпадают.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/auth/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const d = (await res.json().catch(() => ({}))) as { reason?: string };
      if (!res.ok) {
        setError(d.reason ?? `Ошибка ${res.status}`);
        return;
      }
      setDone(true);
    } catch {
      setError("Сетевая ошибка — попробуйте ещё раз.");
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-ink px-4">
        <div className="w-full max-w-sm rounded-xl border border-line bg-panel p-5 text-center">
          <div className="text-sm font-bold text-snow">Ссылка неполная</div>
          <p className="mt-2 text-xs text-fog">
            Откройте ссылку из письма целиком — в ней есть одноразовый токен. Или запросите новую.
          </p>
          <Link href="/forgot" className="mt-4 inline-block text-xs font-semibold text-accent">
            Запросить ссылку заново
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-ink px-4">
      <div className="w-full max-w-sm rounded-xl border border-line bg-panel p-5">
        {done ? (
          <>
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/15 text-accent">
                <Icon name="check" className="h-4 w-4" />
              </span>
              <div className="text-sm font-bold text-snow">Пароль изменён</div>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-fog">
              Все активные сессии завершены — на других устройствах потребуется войти заново.
            </p>
            <button
              onClick={() => router.replace("/login")}
              className="mt-4 w-full rounded-lg bg-accent py-2.5 text-sm font-bold text-accent-ink transition-transform hover:-translate-y-px"
            >
              Войти с новым паролем
            </button>
          </>
        ) : (
          <>
            <div className="text-sm font-bold text-snow">Новый пароль</div>
            <p className="mt-2 text-xs leading-relaxed text-fog">
              Не короче 10 символов. После смены все активные сессии будут завершены.
            </p>
            <form onSubmit={submit} className="mt-4 space-y-3">
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Новый пароль"
                required
                autoFocus
                minLength={10}
                className="w-full rounded-lg border border-line bg-panel2 px-3 py-2.5 text-sm text-snow placeholder:text-fog/60 focus:border-accent/50 focus:outline-none"
              />
              <input
                type="password"
                value={repeat}
                onChange={(e) => setRepeat(e.target.value)}
                placeholder="Повторите пароль"
                required
                minLength={10}
                className="w-full rounded-lg border border-line bg-panel2 px-3 py-2.5 text-sm text-snow placeholder:text-fog/60 focus:border-accent/50 focus:outline-none"
              />
              {error ? <div className="text-xs text-bad">{error}</div> : null}
              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-lg bg-accent py-2.5 text-sm font-bold text-accent-ink transition-transform hover:-translate-y-px disabled:opacity-50"
              >
                {busy ? "Сохраняем…" : "Сменить пароль"}
              </button>
            </form>
            <Link href="/login" className="mt-4 inline-block text-xs font-semibold text-fog hover:text-snow">
              Вернуться ко входу
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
