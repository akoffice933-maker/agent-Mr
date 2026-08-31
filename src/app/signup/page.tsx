"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiFetch } from "@/lib/api-client";
import { Icon } from "@/components/icons";

interface SignupConfig {
  mode: "open" | "code" | "off";
  smtp: boolean;
}

function SignupForm() {
  const router = useRouter();
  // Тариф, выбранный на лендинге (/signup?plan=pro, ТЗ §5.1 п.6). Проверять
  // право на план здесь нечего: оплата и лимиты живут на сервере (quota.ts),
  // параметр лишь решает, куда отправить человека после регистрации.
  const params = useSearchParams();
  const wantsPro = params.get("plan") === "pro";
  const [cfg, setCfg] = useState<SignupConfig | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [orgName, setOrgName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Shown only when the server has no SMTP configured and therefore returned
  // the verification token instead of emailing it.
  const [manualToken, setManualToken] = useState<string | null>(null);

  useEffect(() => {
    apiFetch("/api/auth/signup")
      .then((r) => r.json())
      .then(setCfg)
      .catch(() => setCfg({ mode: "open", smtp: false }));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, orgName: orgName || undefined, inviteCode: inviteCode || undefined }),
      });
      const d = (await res.json().catch(() => ({}))) as {
        reason?: string;
        verificationToken?: string;
      };
      if (!res.ok) {
        setError(d.reason ?? `Ошибка ${res.status}`);
        return;
      }
      // Signup logs the user in, so go straight to the product.
      if (d.verificationToken) {
        setManualToken(d.verificationToken);
        return;
      }
      router.replace(wantsPro ? "/billing?plan=pro" : "/agent");
      router.refresh();
    } catch {
      setError("Сетевая ошибка — попробуйте ещё раз");
    } finally {
      setBusy(false);
    }
  };

  if (cfg?.mode === "off") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-ink px-4">
        <div className="w-full max-w-sm rounded-xl border border-line bg-panel p-5 text-center">
          <div className="text-sm font-bold text-snow">Регистрация закрыта</div>
          <p className="mt-2 text-xs text-fog">
            На этом сервере самостоятельная регистрация отключена. Запросите приглашение у администратора.
          </p>
          <a href="/login" className="mt-4 inline-block text-xs font-semibold text-accent">
            Вернуться ко входу
          </a>
        </div>
      </div>
    );
  }

  if (manualToken) {
    const link = `/verify?token=${manualToken}`;
    return (
      <div className="flex min-h-screen items-center justify-center bg-ink px-4">
        <div className="w-full max-w-md rounded-xl border border-line bg-panel p-5">
          <div className="text-sm font-bold text-snow">Аккаунт создан</div>
          <p className="mt-2 text-xs leading-relaxed text-fog">
            Почтовый сервер не настроен на этом сервере, поэтому письмо не отправлено. Подтвердите адрес по ссылке
            ниже — она одноразовая и действует 24 часа.
          </p>
          <a
            href={link}
            className="mt-3 block break-all rounded-lg border border-line bg-panel2 px-3 py-2 text-[11px] text-accent"
          >
            {link}
          </a>
          <button
            onClick={() => router.replace(wantsPro ? "/billing?plan=pro" : "/agent")}
            className="mt-4 w-full rounded-lg bg-accent py-2.5 text-sm font-bold text-accent-ink"
          >
            Продолжить в систему
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-ink px-4">
      <div className="rise-in w-full max-w-sm">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent text-accent-ink">
            <Icon name="zap" className="h-5 w-5" />
          </div>
          <div>
            <div className="font-display text-base font-bold tracking-tight text-snow">Unified Ads Agent</div>
            <div className="text-[11px] text-fog">Создание аккаунта</div>
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
              minLength={10}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              className="mt-1 w-full rounded-lg border border-line bg-panel2 px-3 py-2.5 text-sm text-snow focus:border-accent/50 focus:outline-none"
            />
            <span className="mt-1 block text-[10px] text-fog">Минимум 10 символов.</span>
          </label>

          <label className="mt-3 block">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-fog">
              Название организации <span className="text-fog/60">— необязательно</span>
            </span>
            <input
              type="text"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              placeholder="Подставим из email"
              className="mt-1 w-full rounded-lg border border-line bg-panel2 px-3 py-2.5 text-sm text-snow placeholder:text-fog/50 focus:border-accent/50 focus:outline-none"
            />
          </label>

          {cfg?.mode === "code" && (
            <label className="mt-3 block">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-fog">Код приглашения</span>
              <input
                type="text"
                required
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                className="mt-1 w-full rounded-lg border border-line bg-panel2 px-3 py-2.5 text-sm text-snow focus:border-accent/50 focus:outline-none"
              />
            </label>
          )}

          {error ? <div className="mt-3 text-xs text-bad">{error}</div> : null}

          <button
            type="submit"
            disabled={busy}
            className="mt-4 w-full rounded-lg bg-accent py-2.5 text-sm font-bold text-accent-ink transition-transform hover:-translate-y-px disabled:opacity-50"
          >
            {busy ? "Создаём аккаунт…" : "Создать аккаунт"}
          </button>

          <p className="mt-3 text-center text-[11px] text-fog">
            Уже есть аккаунт?{" "}
            <a href="/login" className="font-semibold text-accent">
              Войти
            </a>
          </p>
        </form>

        <p className="mt-4 text-center text-[11px] leading-relaxed text-fog">
          Вы станете владельцем новой организации. Агент работает в режиме «только чтение», пока вы не разрешите
          изменения.
        </p>
      </div>
    </div>
  );
}

export default function SignupPage() {
  return (
    <Suspense>
      <SignupForm />
    </Suspense>
  );
}
