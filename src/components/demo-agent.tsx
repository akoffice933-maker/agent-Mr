"use client";

// Интерактивное демо агента в hero лендинга.
//
// Заменяет статичную картинку диалога: посетитель за 10–20 секунд проходит
// весь механизм продукта — запрос обычными словами → предпросмотр с ценой →
// подтверждение → результат и запись в журнал.
//
// Три ограничения, заданные местом, где это живёт:
//
//  1. Никакой сети. Данные из lib/demo-script.ts, потому что /welcome — ISR
//     для анонимного трафика (ТЗ §5.1). Демо не создаёт ни запроса к БД, ни
//     вызова LLM.
//  2. Честность. Под блоком — подпись, что это демонстрация на условных
//     данных. Read-only сценарий не показывает кнопку подтверждения: у
//     чтения её нет и в самом продукте.
//  3. prefers-reduced-motion. Печать по буквам и задержки отключаются —
//     пользователь сразу видит финальное состояние.
//  4. Работает без JS. Стартовое состояние — уже готовый предпросмотр первого
//     сценария, а не пустой экран с приглашением нажать: /welcome отдаётся
//     статикой, и её читают поисковые роботы и люди с отключённым JS. Клик по
//     сценарию лишь перезапускает то же самое с анимацией.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Card } from "@/components/ui";
import { Icon } from "@/components/icons";
import { track } from "@/lib/analytics";
import { DEMO_SCENARIOS, isReadOnly, type DemoScenario } from "@/lib/demo-script";

const PLATFORM_LABEL: Record<DemoRowPlatform, string> = { g: "Google Ads", y: "Яндекс.Директ", a: "Авито" };
type DemoRowPlatform = "g" | "y" | "a";

type Phase = "typing" | "thinking" | "preview" | "applying" | "done";

// Через useSyncExternalStore, а не useState+useEffect: matchMedia — внешний
// источник состояния, и подписка на него без промежуточного setState в эффекте
// избавляет от лишнего рендера и от рассинхрона при SSR (на сервере считаем,
// что анимация разрешена, — и это же значение отдаёт гидратация).
const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void): () => void {
  const mq = window.matchMedia(REDUCED_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCED_QUERY).matches,
    () => false
  );
}

export function DemoAgent() {
  const [scenario, setScenario] = useState<DemoScenario>(DEMO_SCENARIOS[0]);
  const [phase, setPhase] = useState<Phase>("preview");
  const [typed, setTyped] = useState(DEMO_SCENARIOS[0].prompt);
  const reduced = useReducedMotion();
  // Все отложенные шаги — через один список, чтобы смена сценария на середине
  // анимации не досылала реплики от предыдущего.
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearTimers = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  }, []);

  const later = useCallback((fn: () => void, ms: number) => {
    timers.current.push(setTimeout(fn, ms));
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const run = useCallback(
    (s: DemoScenario) => {
      clearTimers();
      setScenario(s);
      track("demo_run", { scenario: s.id });

      if (reduced) {
        setTyped(s.prompt);
        setPhase("preview");
        return;
      }

      setTyped("");
      setPhase("typing");
      const step = 22;
      for (let i = 1; i <= s.prompt.length; i++) {
        later(() => setTyped(s.prompt.slice(0, i)), i * step);
      }
      const typingDone = s.prompt.length * step;
      later(() => setPhase("thinking"), typingDone + 120);
      later(() => setPhase("preview"), typingDone + 900);
    },
    [clearTimers, later, reduced]
  );

  const confirm = useCallback(() => {
    clearTimers();
    track("demo_confirm", { scenario: scenario.id });
    if (reduced) {
      setPhase("done");
      return;
    }
    setPhase("applying");
    later(() => setPhase("done"), 850);
  }, [clearTimers, later, reduced, scenario.id]);

  // «Отклонить» возвращает к предпросмотру того же сценария, а не к пустому
  // экрану: отказ от изменения не должен стирать сам вопрос.
  const reset = useCallback(() => {
    clearTimers();
    setTyped(scenario.prompt);
    setPhase("preview");
  }, [clearTimers, scenario.prompt]);

  const readOnly = isReadOnly(scenario);
  const showPreview = phase === "preview" || phase === "applying" || phase === "done";

  return (
    <div>
      {/* .beam — бегущая по периметру подсветка (globals.css). Чисто
          декоративная и гаснет при prefers-reduced-motion. */}
      <Card className="beam p-4">
        <div className="flex items-center gap-2 border-b border-line pb-3">
          <Icon name="bot" className="h-4 w-4 text-accent" />
          <span className="text-xs font-semibold text-mist">AI-агент</span>
          <span className="ml-auto rounded-full border border-line2 px-2 py-0.5 text-[10px] text-fog">
            {phase === "done" ? "выполнено" : readOnly && showPreview ? "чтение" : "предпросмотр"}
          </span>
        </div>

        {/* Высота фиксирована, чтобы страница не прыгала по мере появления
            реплик — на мобильном это особенно заметно. */}
        <div className="min-h-[326px] space-y-3 pt-3">
          {/* Реплика пользователя */}
          <div className="ml-auto w-fit max-w-[85%] rounded-xl bg-accent/12 px-3 py-2 text-xs text-snow">
            {typed}
            {phase === "typing" ? <span className="ml-0.5 inline-block h-3 w-[2px] animate-pulse bg-accent align-middle" /> : null}
          </div>

          {phase === "thinking" ? (
            <div className="flex w-fit items-center gap-1.5 rounded-xl border border-line bg-panel2 px-3 py-2.5">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="h-1.5 w-1.5 animate-bounce rounded-full bg-fog"
                  style={{ animationDelay: `${i * 120}ms` }}
                />
              ))}
            </div>
          ) : null}

          {showPreview ? (
            <>
              <div className="w-fit max-w-[92%] rounded-xl border border-line bg-panel2 px-3 py-2 text-xs text-mist">
                {scenario.intro}
                <div className="mt-2 space-y-1 font-mono text-[11px]">
                  {scenario.rows.map((r) => (
                    <div key={r.name} className="flex flex-wrap justify-between gap-x-3 gap-y-0.5">
                      <span className="text-fog">
                        <span className="mr-1.5 text-[9px] uppercase tracking-wide text-fog/70">
                          {PLATFORM_LABEL[r.platform]}
                        </span>
                        {r.name}
                      </span>
                      <span className="text-mist">
                        {r.metric} <span className="text-fog">·</span> {r.action}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {readOnly ? (
                <div className="rounded-xl border border-line bg-panel2 px-3 py-2.5">
                  <div className="text-[11px] font-bold text-mist">{scenario.impact}</div>
                  <div className="mt-1 text-[11px] text-fog">{scenario.budgetNote}</div>
                </div>
              ) : phase === "done" ? (
                <div className="rounded-xl border border-accent/35 bg-accent/[0.07] px-3 py-2.5">
                  <div className="flex items-center gap-1.5 text-[11px] font-bold text-accent">
                    <Icon name="check" className="h-3.5 w-3.5" />
                    Изменение применено
                  </div>
                  <div className="mt-1 text-[11px] leading-relaxed text-mist">{scenario.applied}</div>
                  <div className="mt-2 font-mono text-[10px] text-fog">Журнал: {scenario.audit}</div>
                </div>
              ) : (
                <div className="rounded-xl border border-warn/35 bg-warn/[0.07] px-3 py-2.5">
                  <div className="text-[11px] font-bold text-warn">Требуется подтверждение</div>
                  <div className="mt-1 text-[11px] text-mist">
                    {scenario.impact}. {scenario.budgetNote}.
                  </div>
                  <div className="mt-2.5 flex gap-2">
                    <button
                      onClick={confirm}
                      disabled={phase === "applying"}
                      className="rounded-lg bg-accent px-3 py-1.5 text-[11px] font-bold text-accent-ink transition-transform hover:-translate-y-px disabled:opacity-60"
                    >
                      {phase === "applying" ? "Применяю…" : "Подтвердить"}
                    </button>
                    <button
                      onClick={reset}
                      className="rounded-lg border border-line2 px-3 py-1.5 text-[11px] font-semibold text-fog transition-colors hover:text-snow"
                    >
                      Отклонить
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : null}
        </div>

        {/* Выбор сценария */}
        <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
          {DEMO_SCENARIOS.map((s) => (
            <button
              key={s.id}
              onClick={() => run(s)}
              className={`rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold transition-colors ${
                scenario.id === s.id
                  ? "border-accent/50 bg-accent/10 text-accent"
                  : "border-line text-fog hover:border-accent/40 hover:text-snow"
              }`}
            >
              {s.chip}
            </button>
          ))}
        </div>
      </Card>

      <p className="mt-2 text-center text-[10px] leading-relaxed text-fog">
        Демонстрация на условных данных: цифры вымышлены, рекламные кабинеты не затрагиваются.
        В продукте шаги те же — предпросмотр, стоимость, подтверждение, запись в журнал.
      </p>
    </div>
  );
}
