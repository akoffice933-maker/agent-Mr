"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api-client";
import { Icon } from "@/components/icons";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") ?? "/";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Whether to offer registration at all: a deployment with SIGNUP_MODE=off
  // must not show a link that only leads to a refusal.
  const [signupOpen, setSignupOpen] = useState(false);

  useEffect(() => {
    apiFetch("/api/auth/signup")
      .then((r) => r.json())
      .then((d: { mode?: string }) => setSignupOpen(d.mode !== "off"))
      .catch(() => setSignupOpen(false));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        router.replace(next);
        router.refresh();
        return;
      }
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      setError(d.error === "invalid credentials" ? "Неверный email или пароль" : (d.error ?? `Ошибка ${res.status}`));
    } catch {
      setError("Сетевая ошибка — попробуйте ещё раз");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-ink px-4">
      <div className="rise-in w-full max-w-sm">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent text-accent-ink">
            <Icon name="zap" className="h-5 w-5" />
          </div>
          <div>
            <div className="font-display text-base font-bold tracking-tight text-snow">Unified Ads Agent</div>
            <div className="text-[11px] text-fog">Вход в систему</div>
          </div>
        </div>

        <form onSubmit={submit} className="rounded-xl border border-line bg-panel p-5">
          <label className="block">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-fog">Email</span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              className="mt-1 w-full rounded-lg border border-line bg-panel2 px-3 py-2.5 text-sm text-snow focus:border-accent/50 focus:outline-none"
            />
          </label>
          <label className="mt-3 block">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-fog">Пароль</span>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              className="mt-1 w-full rounded-lg border border-line bg-panel2 px-3 py-2.5 text-sm text-snow focus:border-accent/50 focus:outline-none"
            />
          </label>
          {error ? <div className="mt-3 text-xs text-bad">{error}</div> : null}
          <button
            type="submit"
            disabled={busy}
            className="mt-4 w-full rounded-lg bg-accent py-2.5 text-sm font-bold text-accent-ink transition-transform hover:-translate-y-px disabled:opacity-50"
          >
            {busy ? "Входим…" : "Войти"}
          </button>

          <p className="mt-3 text-center text-[11px]">
            <a href="/forgot" className="font-semibold text-fog hover:text-snow">
              Забыли пароль?
            </a>
          </p>

          {signupOpen && (
            <p className="mt-3 text-center text-[11px] text-fog">
              Нет аккаунта?{" "}
              <a href="/signup" className="font-semibold text-accent">
                Зарегистрироваться
              </a>
            </p>
          )}
        </form>

        <p className="mt-4 text-center text-[11px] leading-relaxed text-fog">
          Сессия — server-side, cookie HttpOnly/SameSite=Strict. Ключи и пароли не хранятся в браузере.
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
