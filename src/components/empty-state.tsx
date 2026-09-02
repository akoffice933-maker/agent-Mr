import Link from "next/link";
import { Icon } from "@/components/icons";

/**
 * Показывается вместо таблицы/графиков, когда к организации не подключена
 * ни одна рекламная площадка — иначе /campaigns и /analytics молча рисуют
 * пустую таблицу без единого объяснения, почему там ничего нет (ТЗ ревью
 * §1.4: та же 3-шаговая подсказка, не только баннер на /agent).
 *
 * Ведёт на /dashboard, а не дублирует здесь список площадок и кнопки OAuth —
 * тот же расчёт (allowed/configured/reason по каждой площадке) уже делает
 * onboardingState() ровно один раз для чек-листа там.
 */
export function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-line bg-panel2/40 px-6 py-14 text-center">
      <div className="flex h-11 w-11 items-center justify-center rounded-full bg-accent/12 text-accent">
        <Icon name="plug" className="h-5 w-5" />
      </div>
      <p className="font-display text-base font-bold text-snow">{title}</p>
      <p className="max-w-sm text-xs leading-relaxed text-fog">{hint}</p>
      <Link
        href="/dashboard"
        className="mt-1 rounded-lg bg-accent px-4 py-2 text-xs font-bold text-accent-ink transition-transform hover:-translate-y-px"
      >
        Подключить рекламный кабинет
      </Link>
    </div>
  );
}
