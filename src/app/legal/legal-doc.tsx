// Каркас юридического документа (ТЗ §5.1 п.7: футер лендинга ссылается на
// /legal/privacy и /legal/terms, обе страницы обязаны открываться анониму).
//
// Это серверный компонент без обращения к данным — как и лендинг, он не
// использует withTenantPage() и не касается БД, поэтому страницы рендерятся
// статически и не создают нагрузку.

import Link from "next/link";
import { Icon } from "@/components/icons";

export type LegalSection = { title: string; paragraphs: string[]; bullets?: string[] };

export function LegalDoc({
  title,
  updated,
  intro,
  sections,
}: {
  title: string;
  updated: string;
  intro: string;
  sections: LegalSection[];
}) {
  return (
    <div className="min-h-screen bg-ink text-mist">
      <header className="sticky top-0 z-20 border-b border-line bg-ink/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-[820px] items-center justify-between px-4 py-3 sm:px-6">
          <Link href="/welcome" className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-accent-ink">
              <Icon name="zap" className="h-4 w-4" />
            </span>
            <span className="font-display text-sm font-bold text-snow">Unified AI Ads Agent</span>
          </Link>
          <Link href="/login" className="text-xs font-semibold text-fog hover:text-snow">
            Вход
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[820px] px-4 py-10 sm:px-6 sm:py-14">
        <h1 className="font-display text-2xl font-bold text-snow sm:text-3xl">{title}</h1>
        <div className="mt-2 text-xs text-fog">Редакция от {updated} · ООО «ИТА»</div>
        <p className="mt-5 text-sm leading-relaxed text-mist">{intro}</p>

        <ol className="mt-8 space-y-7">
          {sections.map((s, i) => (
            <li key={s.title}>
              <h2 className="font-display text-base font-bold text-snow">
                <span className="mr-2 text-accent">{i + 1}.</span>
                {s.title}
              </h2>
              {s.paragraphs.map((p) => (
                <p key={p} className="mt-2 text-sm leading-relaxed text-mist">
                  {p}
                </p>
              ))}
              {s.bullets ? (
                <ul className="mt-3 space-y-1.5">
                  {s.bullets.map((b) => (
                    <li key={b} className="flex gap-2 text-sm leading-relaxed text-mist">
                      <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-accent" />
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ol>

        <div className="mt-10 flex flex-wrap gap-x-5 gap-y-2 border-t border-line pt-6 text-xs text-fog">
          <Link href="/welcome" className="hover:text-snow">
            ← На главную
          </Link>
          <Link href="/legal/privacy" className="hover:text-snow">
            Политика конфиденциальности
          </Link>
          <Link href="/legal/terms" className="hover:text-snow">
            Условия использования
          </Link>
          <a href="mailto:support@ita.example" className="hover:text-snow">
            support@ita.example
          </a>
        </div>
      </main>
    </div>
  );
}
