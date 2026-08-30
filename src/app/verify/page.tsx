"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiFetch } from "@/lib/api-client";
import { Icon } from "@/components/icons";

type State = { kind: "working" } | { kind: "ok"; already: boolean } | { kind: "error"; message: string };

function VerifyInner() {
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  // A missing token is a property of the URL, not an effect: derive it during
  // initialisation instead of setting state from inside useEffect.
  const [state, setState] = useState<State>(() =>
    token ? { kind: "working" } : { kind: "error", message: "Ссылка неполная: отсутствует токен." }
  );
  // React 18 StrictMode mounts effects twice in dev; without this guard the
  // single-use token would be consumed by the first call and reported invalid
  // by the second.
  const sent = useRef(false);

  useEffect(() => {
    if (!token) return;
    if (sent.current) return;
    sent.current = true;

    apiFetch("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then(async (r) => {
        const d = (await r.json().catch(() => ({}))) as { reason?: string; alreadyVerified?: boolean };
        if (r.ok) setState({ kind: "ok", already: Boolean(d.alreadyVerified) });
        else setState({ kind: "error", message: d.reason ?? `Ошибка ${r.status}` });
      })
      .catch(() => setState({ kind: "error", message: "Сетевая ошибка — попробуйте ещё раз." }));
  }, [token]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-ink px-4">
      <div className="rise-in w-full max-w-sm rounded-xl border border-line bg-panel p-6 text-center">
        {state.kind === "working" && (
          <>
            <Icon name="refresh" className="mx-auto h-6 w-6 animate-spin text-accent" />
            <div className="mt-3 text-sm text-fog">Подтверждаем адрес…</div>
          </>
        )}

        {state.kind === "ok" && (
          <>
            <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-good/15">
              <Icon name="check" className="h-5 w-5 text-good" />
            </div>
            <div className="mt-3 text-sm font-bold text-snow">
              {state.already ? "Адрес уже подтверждён" : "Email подтверждён"}
            </div>
            <a
              href="/agent"
              className="mt-4 inline-block w-full rounded-lg bg-accent py-2.5 text-sm font-bold text-accent-ink"
            >
              Перейти в систему
            </a>
          </>
        )}

        {state.kind === "error" && (
          <>
            <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-bad/15">
              <Icon name="alert" className="h-5 w-5 text-bad" />
            </div>
            <div className="mt-3 text-sm font-bold text-snow">Не удалось подтвердить</div>
            <p className="mt-2 text-xs leading-relaxed text-fog">{state.message}</p>
            <a href="/agent" className="mt-4 inline-block text-xs font-semibold text-accent">
              Продолжить в систему
            </a>
          </>
        )}
      </div>
    </div>
  );
}

export default function VerifyPage() {
  return (
    <Suspense>
      <VerifyInner />
    </Suspense>
  );
}
