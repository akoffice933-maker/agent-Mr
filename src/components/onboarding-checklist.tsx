"use client";

// Пошаговый мастер первого дня (ТЗ §5.2, пп. 8–9).
//
// Показывается, пока не пройдены два обязательных шага: подключить кабинет и
// задать агенту первый вопрос. Третий шаг (позвать коллегу) необязательный —
// он не держит чек-лист на экране, иначе одиночный пользователь видел бы его
// вечно.
//
// Причина, по которой площадку нельзя подключить, НЕ вычисляется здесь: она
// приходит с сервера из quota.ts (ТЗ §8.3 — фронтенд не дублирует логику
// лимитов, а показывает то, что вернул сервер).

import { useEffect, useState } from "react";
import Link from "next/link";
import { Icon } from "./icons";
import { apiFetch } from "@/lib/api-client";

interface PlatformSlot {
  platform: "google" | "yandex" | "avito";
  title: string;
  connected: boolean;
  configured: boolean;
  allowed: boolean;
  reason: string | null;
}

interface OnboardingState {
  dismissed: boolean;
  planTitle: string;
  platforms: PlatformSlot[];
  steps: { connected: boolean; asked: boolean; invited: boolean };
  counts: { platforms: number; userMessages: number; members: number };
  complete: boolean;
}

function StepRow({
  n,
  done,
  title,
  desc,
  children,
}: {
  n: number;
  done: boolean;
  title: string;
  desc: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex gap-3 py-3">
      <span
        className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
          done ? "bg-accent text-accent-ink" : "border border-line2 text-fog"
        }`}
      >
        {done ? <Icon name="check" className="h-3.5 w-3.5" /> : n}
      </span>
      <div className="min-w-0 flex-1">
        <div className={`text-sm font-bold ${done ? "text-fog line-through" : "text-snow"}`}>{title}</div>
        <p className="mt-0.5 text-xs text-fog">{desc}</p>
        {done ? null : children}
      </div>
    </div>
  );
}

export function OnboardingChecklist() {
  const [s, setS] = useState<OnboardingState | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    apiFetch("/api/onboarding")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setS(d))
      .catch(() => setS(null));
  }, []);

  if (!s || s.dismissed || s.complete || hidden) return null;

  const done = [s.steps.connected, s.steps.asked, s.steps.invited].filter(Boolean).length;

  const dismiss = () => {
    setHidden(true);
    // Настройка отображения, не действие над кабинетом: ошибка сети не должна
    // возвращать чек-лист на экран прямо сейчас, поэтому скрываем оптимистично.
    apiFetch("/api/onboarding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dismissed: true }),
    }).catch(() => {});
  };

  return (
    <div className="rise-in mb-4 rounded-xl border border-accent/30 bg-accent/[0.05] p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/15 text-accent">
          <Icon name="sparkle" className="h-4.5 w-4.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold text-snow">Три шага до первого результата</div>
          <div className="mt-0.5 text-xs text-fog">
            Тариф «{s.planTitle}» · выполнено {done} из 3
          </div>
        </div>
        <button onClick={dismiss} className="text-xs font-semibold text-fog transition-colors hover:text-snow">
          Скрыть
        </button>
      </div>

      <div className="mt-3 h-1 overflow-hidden rounded-full bg-line">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-500"
          style={{ width: `${(done / 3) * 100}%` }}
        />
      </div>

      <div className="mt-1 divide-y divide-line/60">
        <StepRow
          n={1}
          done={s.steps.connected}
          title="Подключите рекламный кабинет"
          desc="Google Ads, Яндекс.Директ или Авито — через OAuth, пароли от кабинетов не нужны."
        >
          <div className="mt-2.5 flex flex-wrap gap-2">
            {s.platforms.map((p) => {
              if (p.connected) {
                return (
                  <span
                    key={p.platform}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-accent/35 bg-accent/10 px-3 py-1.5 text-xs font-semibold text-accent"
                  >
                    <Icon name="check" className="h-3.5 w-3.5" /> {p.title}
                  </span>
                );
              }
              if (!p.allowed) {
                // ТЗ §5.2 п.9: не прятать кнопку молча, а объяснить причину
                // словами сервера и дать ссылку на тариф.
                return (
                  <span
                    key={p.platform}
                    className="inline-flex max-w-full flex-col gap-1 rounded-lg border border-line bg-panel2 px-3 py-2 text-xs text-fog"
                  >
                    <span className="flex items-center gap-1.5 font-semibold text-mist">
                      <Icon name="lock" className="h-3.5 w-3.5" /> {p.title}
                    </span>
                    <span className="max-w-[46ch] leading-relaxed">{p.reason}</span>
                    <Link href="/billing" className="font-semibold text-accent hover:underline">
                      Посмотреть тарифы →
                    </Link>
                  </span>
                );
              }
              if (!p.configured) {
                return (
                  <span
                    key={p.platform}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-panel2 px-3 py-1.5 text-xs text-fog"
                    title="OAuth-ключи площадки не заданы в .env"
                  >
                    {p.title} · ключи не настроены
                  </span>
                );
              }
              return (
                <a
                  key={p.platform}
                  href={`/api/oauth/${p.platform}?start=1`}
                  className="rounded-lg bg-accent px-3 py-1.5 text-xs font-bold text-accent-ink transition-transform hover:-translate-y-px"
                >
                  Подключить {p.title}
                </a>
              );
            })}
          </div>
        </StepRow>

        <StepRow
          n={2}
          done={s.steps.asked}
          title="Спросите агента о расходах"
          desc="Например: «покажи расход за последние 7 дней». Чтение не тарифицируется ни на одном тарифе."
        >
          <Link
            href="/agent?ask=%D0%9F%D0%BE%D0%BA%D0%B0%D0%B6%D0%B8%20%D1%80%D0%B0%D1%81%D1%85%D0%BE%D0%B4%D1%8B%20%D0%B7%D0%B0%20%D0%BF%D0%BE%D1%81%D0%BB%D0%B5%D0%B4%D0%BD%D0%B8%D0%B5%207%20%D0%B4%D0%BD%D0%B5%D0%B9"
            className="mt-2.5 inline-flex rounded-lg border border-line2 px-3 py-1.5 text-xs font-bold text-snow transition-colors hover:border-accent/50"
          >
            Открыть чат с агентом
          </Link>
        </StepRow>

        <StepRow
          n={3}
          done={s.steps.invited}
          title="Позовите коллегу (необязательно)"
          desc="Аналитик увидит отчёты, медиабайер сможет вести кампании — с ограничением на величину изменения ставки."
        >
          <Link
            href="/members"
            className="mt-2.5 inline-flex rounded-lg border border-line2 px-3 py-1.5 text-xs font-bold text-snow transition-colors hover:border-accent/50"
          >
            Пригласить участника
          </Link>
        </StepRow>
      </div>
    </div>
  );
}
