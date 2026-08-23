"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api-client";
import { Icon } from "./icons";

interface Props {
  platform: "google" | "yandex" | "avito";
  platformName: string;
  campaignsCount: number;
  activeCount: number;
  spend7d: number;
  openRecs: number;
  readOnly: boolean;
}

function fmt(n: number): string {
  return new Intl.NumberFormat("ru-RU").format(Math.round(n)) + " ₽";
}

// Onboarding after OAuth (14-day plan, Day 10): "Here's what I found + 3 recommendations".
export function OnboardBanner({ platform, platformName, campaignsCount, activeCount, spend7d, openRecs, readOnly }: Props) {
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false);

  const runAudit = async () => {
    setBusy(true);
    try {
      await apiFetch("/api/agent/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: `Сделай аудит ${platformName === "Яндекс.Директ" ? "кабинета Директа" : platformName} и покажи рекомендации` }),
      });
      window.location.reload();
    } finally {
      setBusy(false);
    }
  };

  const showRecs = async () => {
    setBusy(true);
    try {
      await apiFetch("/api/agent/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Покажи рекомендации" }),
      });
      window.location.reload();
    } finally {
      setBusy(false);
    }
  };

  if (hidden) return null;

  return (
    <div className="rise-in mb-4 rounded-xl border border-accent/30 bg-accent/[0.06] p-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/15 text-accent">
          <Icon name="check" className="h-4.5 w-4.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold text-snow">
            {platformName} подключён — работаю с реальными данными
          </div>
          <div className="mt-0.5 text-xs text-fog">
            Нашёл: <span className="text-mist">{campaignsCount} кампаний</span> ({activeCount} активных) · расход за 7 дней{" "}
            <span className="text-mist">{fmt(spend7d)}</span> · открытых рекомендаций: <span className="text-mist">{openRecs}</span>
          </div>
          {readOnly ? (
            <div className="mt-1 text-[11px] text-warn">
              По умолчанию я в режиме «только чтение» — анализ и отчёты свободно, управление — после явного включения на странице «Безопасность».
            </div>
          ) : null}
        </div>
        <div className="flex gap-2">
          <button
            onClick={runAudit}
            disabled={busy}
            className="rounded-lg bg-accent px-3.5 py-2 text-xs font-bold text-accent-ink transition-transform hover:-translate-y-px disabled:opacity-50"
          >
            {busy ? "Работаю…" : "Запустить полный аудит"}
          </button>
          <button
            onClick={showRecs}
            disabled={busy}
            className="rounded-lg border border-line2 bg-panel2 px-3.5 py-2 text-xs font-semibold text-mist transition-colors hover:text-snow disabled:opacity-50"
          >
            Показать рекомендации
          </button>
        </div>
        <button onClick={() => setHidden(true)} className="text-fog transition-colors hover:text-snow" title="Скрыть">
          ✕
        </button>
      </div>
    </div>
  );
}
