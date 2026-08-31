"use client";

import { useEffect, useState } from "react";
import { Icon } from "./icons";
import { Card } from "./ui";
import { apiFetch } from "@/lib/api-client";

interface PlatformState {
  platform: "google" | "yandex" | "avito";
  mode: "sandbox" | "production";
  token: boolean;
  configured: boolean;
  /** Разрешает ли тариф подключить ЕЩЁ одну площадку (считает сервер). */
  canConnect?: boolean;
  /** Причина отказа словами сервера — фронтенд её не сочиняет (ТЗ §8.3). */
  blockedReason?: string | null;
}

interface SettingsState {
  dryRun: boolean;
  readOnly: boolean;
  dailyLimit: number;
  weeklyLimit: number;
  monthlyLimit: number;
  platforms?: PlatformState[];
}

const PLATFORM_NAMES: Record<PlatformState["platform"], string> = {
  google: "Google Ads",
  yandex: "Яндекс.Директ",
  avito: "Авито",
};

function Toggle({
  on,
  onChange,
  label,
  desc,
  danger = false,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
  desc: string;
  danger?: boolean;
}) {
  return (
    <button
      onClick={() => onChange(!on)}
      className="flex w-full items-center gap-3 rounded-lg border border-line bg-panel2 px-3.5 py-3 text-left transition-colors hover:border-line2"
    >
      <span
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
          on ? (danger ? "bg-bad" : "bg-accent") : "bg-panel3"
        }`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-snow transition-all ${on ? "left-4.5 translate-x-0.5" : "left-0.5"}`}
          style={{ left: on ? "1.125rem" : "0.125rem" }}
        />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-snow">{label}</span>
        <span className="block text-[11px] leading-snug text-fog">{desc}</span>
      </span>
      <span className={`ml-auto text-[10px] font-bold uppercase ${on ? (danger ? "text-bad" : "text-accent") : "text-fog"}`}>
        {on ? "вкл" : "выкл"}
      </span>
    </button>
  );
}

export function SettingsPanel() {
  const [s, setS] = useState<SettingsState | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiFetch("/api/settings")
      .then((r) => r.json())
      .then(setS)
      .catch(() => undefined);
  }, []);

  const patch = (p: Partial<SettingsState>) => setS((prev) => (prev ? { ...prev, ...p } : prev));

  const saveLimits = async () => {
    if (!s) return;
    setBusy(true);
    await apiFetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dailyLimit: s.dailyLimit, weeklyLimit: s.weeklyLimit, monthlyLimit: s.monthlyLimit }),
    });
    setBusy(false);
    setSaved("Лимиты сохранены — изменения сразу учитываются агентом.");
    setTimeout(() => setSaved(null), 3500);
  };

  if (!s) {
    return (
      <Card className="p-6 text-sm text-fog">
        <Icon name="refresh" className="mr-2 inline h-4 w-4 animate-spin" /> Загрузка настроек безопасности…
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card className="space-y-2.5 p-4">
        <Toggle
          on={s.dryRun}
          onChange={(v) => {
            patch({ dryRun: v });
            apiFetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dryRun: v }) });
          }}
          label="Dry-run по умолчанию"
          desc="Все операции записи выполняются как предпросмотр: изменения применяются только после явного подтверждения."
        />
        <div className="rounded-lg border border-line p-4">
          <div className="text-sm font-medium text-fg">Подтверждение действий, влияющих на бюджет</div>
          <p className="mt-1 text-xs text-muted">
            Все операции записи (ставки, бюджеты, продвижение, пауза/запуск) всегда требуют явного подтверждения
            человеком — независимо от роли и настроек (требование ТЗ, разд. 10).
          </p>
        </div>
        <Toggle
          on={s.readOnly}
          onChange={(v) => {
            // Disabling read-only = enabling real control over ad accounts — confirm explicitly.
            if (!v && !window.confirm("Включить управление? Агент сможет выполнять действия (паузы, ставки, бюджеты) после их подтверждения. По умолчанию агент работает в режиме «только чтение».")) return;
            patch({ readOnly: v });
            apiFetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ readOnly: v }) });
          }}
          label={s.readOnly ? "Режим «только чтение» (по умолчанию)" : "⚠ Управление включено"}
          desc={s.readOnly
            ? "Агент анализирует и отвечает, но не управляет аккаунтами. Чтобы разрешить действия — выключите этот режим."
            : "Агент может выполнять действия (паузы, ставки, бюджеты) — каждый раз с вашим подтверждением."}
          danger={!s.readOnly}
        />
      </Card>

      <Card className="p-4">
        <h3 className="font-display text-sm font-bold tracking-tight">Лимиты расхода</h3>
        <p className="mt-1 text-[11px] text-fog">
          Агент проверяет каждое действие, добавляющее расход: если прогноз превышает лимит — действие блокируется с объяснением.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          {(
            [
              ["dailyLimit", "Дневной, ₽"],
              ["weeklyLimit", "Недельный, ₽"],
              ["monthlyLimit", "Месячный, ₽"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="block">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-fog">{label}</span>
              <input
                type="number"
                value={s[key]}
                min={0}
                step={1000}
                onChange={(e) => patch({ [key]: Number(e.target.value) } as Partial<SettingsState>)}
                className="num mt-1 w-full rounded-lg border border-line bg-panel2 px-3 py-2 text-sm text-snow focus:border-accent/50 focus:outline-none"
              />
            </label>
          ))}
        </div>
        <button
          onClick={saveLimits}
          disabled={busy}
          className="mt-3 rounded-lg bg-accent px-4 py-2 text-sm font-bold text-accent-ink transition-transform hover:-translate-y-px disabled:opacity-50"
        >
          {busy ? "Сохранение…" : "Сохранить лимиты"}
        </button>
        {saved ? <div className="mt-2 text-xs text-good">{saved}</div> : null}
      </Card>

      {s.platforms?.length ? (
        <Card className="p-4">
          <h3 className="font-display text-sm font-bold tracking-tight">Площадки и режимы работы</h3>
          <p className="mt-1 text-[11px] text-fog">
            sandbox — демо-данные из локального зеркала (без реальных кабинетов); production — реальный API через OAuth-токен.
          </p>
          <div className="mt-3 space-y-2">
            {s.platforms.map((p) => (
              <div key={p.platform} className="flex items-center gap-3 rounded-lg border border-line bg-panel2 px-3.5 py-2.5">
                <span className="text-sm font-semibold text-snow">{PLATFORM_NAMES[p.platform]}</span>
                <span
                  className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                    p.mode === "production" ? "border-accent/40 bg-accent/15 text-accent" : "border-line text-fog"
                  }`}
                >
                  {p.mode === "production" ? "production" : "sandbox"}
                </span>
                <span className="ml-auto text-[11px] text-fog">
                  {p.mode === "production" && p.token
                    ? "токен сохранён"
                    : p.configured
                      ? "OAuth настроен"
                      : "ключи в .env не заданы"}
                </span>
                {p.mode === "sandbox" && p.configured && p.canConnect !== false ? (
                  // Было `/api/oauth/{platform}/start` — такого маршрута нет,
                  // кнопка вела в 404. Флоу стартует через ?start=1.
                  <a
                    href={`/api/oauth/${p.platform}?start=1`}
                    className="rounded-lg bg-accent px-3 py-1.5 text-xs font-bold text-accent-ink transition-transform hover:-translate-y-px"
                  >
                    Подключить
                  </a>
                ) : null}
                {p.mode === "sandbox" && p.configured && p.canConnect === false ? (
                  <a
                    href="/billing"
                    title={p.blockedReason ?? undefined}
                    className="rounded-lg border border-line2 px-3 py-1.5 text-xs font-bold text-mist transition-colors hover:border-accent/50 hover:text-accent"
                  >
                    Тариф исчерпан →
                  </a>
                ) : null}
                {p.mode === "production" ? (
                  <button
                    onClick={() =>
                      apiFetch("/api/settings", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ platform: p.platform, mode: "sandbox" }),
                      }).then(() => location.reload())
                    }
                    className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-fog transition-colors hover:text-snow"
                  >
                    В sandbox
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
