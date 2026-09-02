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
/**
 * Показывать ли плашку вместо данных.
 *
 * Вынесено из страниц в одну функцию не ради красоты: условие живёт в двух
 * местах (/campaigns и /analytics), и когда оно было записано в каждом файле
 * отдельно, там осталось `connected === 0` без проверки данных. Итог —
 * организация с sandbox-кампаниями (агент создаёт их без oauth-токена, см.
 * run.ts applyLocal) видела на /campaigns подзаголовок «1 объектов, 1 активны»
 * и прямо под ним плашку «площадок не подключено», а реальный расход на
 * /analytics был скрыт целиком.
 *
 * Инвариант: приглашение подключить кабинет уместно, только когда показывать
 * действительно нечего.
 */
export function showEmptyState({ connected, hasData }: { connected: number; hasData: boolean }): boolean {
  return connected === 0 && !hasData;
}

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
