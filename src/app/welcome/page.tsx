// Публичный лендинг (ТЗ §5.1).
//
// Инварианты, которые здесь важнее вёрстки:
//
//  1. НЕТ withTenantPage() и вообще никакого обращения к tenant-данным — это
//     единственная страница продукта, которую видит аноним (ТЗ §8.2: новые
//     серверные страницы либо идут через DAL, либо не читают данные вовсе).
//  2. ISR вместо force-dynamic: анонимный трафик с рекламы не должен создавать
//     нагрузку на БД (ТЗ §5.1, последний абзац).
//  3. Цены, лимиты и список возможностей импортируются из кода, а не набраны
//     руками (ТЗ §8.4, критерий приёмки №4): PLANS из lib/billing/plans.ts,
//     uiToolCatalog() из lib/agent/tool-meta.ts. Изменили тариф или добавили
//     инструмент агента — лендинг обновится сам.
//  4. Дизайн-система — существующая (ТЗ §7): токены Tailwind из globals.css
//     (ink/panel/line/fog/mist/snow/accent) и Card из components/ui.tsx.

import type { Metadata } from "next";
import Link from "next/link";
import { Card } from "@/components/ui";
import { Icon } from "@/components/icons";
import { TrackedLink } from "@/components/tracked-link";
import { LandingViewTracker } from "@/components/landing-view-tracker";
import { DemoAgent } from "@/components/demo-agent";
import { NumberTicker } from "@/components/number-ticker";
import { MarqueePlatforms } from "@/components/marquee-platforms";
import { PLANS } from "@/lib/billing/plans";
import { uiToolCatalog, type CatalogEntry } from "@/lib/agent/tool-meta";
import { fmtMoney, fmtNum } from "@/lib/format";

// Статика с перегенерацией раз в час: контент меняется только вместе с
// деплоем (цены и инструменты — константы кода), но revalidate оставляет
// возможность поменять их без полного ребилда.
export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Unified AI Ads Agent — реклама в Google Ads, Яндекс.Директе и Авито из одного чата",
  description:
    "AI-агент управляет рекламой на трёх площадках по-русски: показывает предпросмотр изменения и стоимость, "
    + "и ничего не меняет в кабинете без вашего подтверждения.",
  alternates: { canonical: "/welcome" },
  openGraph: {
    type: "website",
    locale: "ru_RU",
    url: "/welcome",
    siteName: "Unified AI Ads Agent",
    title: "Google Ads, Яндекс.Директ и Авито — из одного чата",
    description: "Предпросмотр изменения и его стоимость до того, как что-то произойдёт. Подтверждение — за вами.",
  },
  twitter: {
    card: "summary",
    title: "Google Ads, Яндекс.Директ и Авито — из одного чата",
    description: "Предпросмотр изменения и его стоимость до того, как что-то произойдёт. Подтверждение — за вами.",
  },
};

const PLATFORM_LABEL: Record<"g" | "y" | "a", string> = {
  g: "Google Ads",
  y: "Яндекс.Директ",
  a: "Авито",
};

const STEPS = [
  {
    icon: "zap" as const,
    title: "Подключили кабинет",
    text: "Google Ads, Яндекс.Директ или Авито — по кнопке, через OAuth. Пароли от кабинетов мы не спрашиваем.",
  },
  {
    icon: "bot" as const,
    title: "Написали агенту",
    text: "Обычной фразой: «покажи расход за неделю» или «останови кампании с CTR ниже 1%».",
  },
  {
    icon: "eye" as const,
    title: "Увидели предпросмотр",
    text: "Агент показывает, что именно изменится и сколько это стоит — до того, как что-то произойдёт.",
  },
  {
    icon: "check" as const,
    title: "Подтвердили",
    text: "Только после вашего нажатия изменение уходит в рекламный кабинет и попадает в журнал действий.",
  },
];

/** Группы для блока «Возможности» — проекция TOOL_META, а не второй список. */
function toolGroups(): { title: string; note: string; tools: CatalogEntry[] }[] {
  const all = uiToolCatalog().filter((t) => t.name !== "help");
  const reads = all.filter((t) => t.kind === "read");
  return [
    {
      title: "Отчёты и аналитика",
      note: "Не тарифицируются ни на одном тарифе",
      tools: reads.filter((t) => t.action === "read"),
    },
    {
      title: "Аудит и рекомендации",
      note: "Агент сам находит, что чинить",
      tools: reads.filter((t) => t.action !== "read"),
    },
    {
      title: "Изменения в кабинетах",
      note: "Каждое — с предпросмотром и подтверждением",
      tools: all.filter((t) => t.kind === "write"),
    },
  ];
}

const FAQ: { q: string; a: string }[] = [
  {
    q: "Можно ли попробовать без банковской карты?",
    a: "Да. Бесплатный тариф не требует карты: один рекламный кабинет и 50 изменений в месяц без ограничения по времени.",
  },
  {
    q: "Что если агент ошибётся?",
    a: "Любое действие, которое влияет на рекламный кабинет — пауза кампании, изменение ставки или бюджета — сначала показывается как превью с точной формулировкой изменения и его стоимостью. Действие уходит в кабинет только после того, как вы нажали «Подтвердить».",
  },
  {
    q: "Кто видит данные моей организации?",
    a: "Только участники вашей команды с назначенной ролью. Данные разных организаций физически изолированы на уровне базы данных (Row-Level Security в PostgreSQL), а не только проверкой внутри кода приложения.",
  },
  {
    q: "Что делает агент без моего участия?",
    a: "Ничего, что стоит денег. Чтение — отчёты, аналитика, список кампаний — агент делает самостоятельно и без ограничений на любом тарифе. Любое изменение, влияющее на бюджет или показ рекламы, требует вашего подтверждения.",
  },
  {
    q: "Как отключить или удалить аккаунт?",
    a: "Рекламный кабинет отключается кнопкой «Отключить» в разделе «Настройки»: сохранённый токен удаляется сразу, синхронизация прекращается, слот тарифа освобождается. История кампаний и журнал изменений при этом остаются у вас — это ваши данные, а не данные площадки. Учётная запись удаляется по запросу в поддержку.",
  },
  {
    q: "Демо на этой странице — настоящие данные?",
    a: "Нет, это демонстрация на условных цифрах: она не обращается к рекламным кабинетам и ничего не меняет. Последовательность шагов в ней ровно та же, что в продукте, — запрос обычными словами, предпросмотр с расчётом стоимости, ваше подтверждение и запись в журнал.",
  },
  {
    q: "Чем это отличается от встроенных «умных» рекомендаций площадок?",
    a: "Встроенные рекомендации работают только с одним кабинетом и часто применяются автоматически без явного подтверждения. Агент видит все три площадки сразу, ничего не применяет без вашего «Подтвердить» и ведёт единый журнал изменений по всем трём.",
  },
];

function PlanCard({ id }: { id: "free" | "pro" }) {
  const p = PLANS[id];
  const pro = id === "pro";
  const price = p.priceMinor === 0 ? "0 ₽" : `${fmtMoney(p.priceMinor / 100)}`;

  const rows = [
    { label: "Рекламные площадки", value: p.maxPlatforms === 3 ? "3 — Google, Яндекс, Авито" : String(p.maxPlatforms) },
    { label: "Изменений в месяц", value: fmtNum(p.maxWriteActionsPerMonth) },
    { label: "Участников команды", value: String(p.maxMembers) },
    { label: "Отчёты и аналитика", value: "без ограничений" },
  ];

  return (
    <div
      className={`relative rounded-2xl border p-6 ${
        pro ? "border-accent/45 bg-accent/[0.04] shadow-[0_0_40px_-24px_var(--color-accent)]" : "border-line bg-panel"
      }`}
    >
      {pro ? (
        <span className="absolute -top-2.5 right-5 rounded-full bg-accent px-2.5 py-1 text-[10px] font-bold tracking-wide text-accent-ink uppercase">
          Рекомендуем
        </span>
      ) : null}
      <div className="text-xs font-semibold tracking-[0.14em] text-fog uppercase">{p.title}</div>
      <div className="font-display mt-2 text-3xl font-bold text-snow">
        {price}
        {p.priceMinor > 0 ? <span className="ml-1 text-sm font-medium text-fog">/ мес</span> : null}
      </div>
      <div className="mt-1 text-xs text-fog">
        {pro ? "Все три площадки, без процента от рекламного расхода" : "Бесплатно навсегда, карта не нужна"}
      </div>

      <dl className="mt-5 divide-y divide-line/70 border-t border-line/70">
        {rows.map((r) => (
          <div key={r.label} className="flex items-baseline justify-between gap-3 py-2.5">
            <dt className="text-xs text-fog">{r.label}</dt>
            <dd className="text-sm font-semibold text-mist">{r.value}</dd>
          </div>
        ))}
      </dl>

      <Link
        href={pro ? "/signup?plan=pro" : "/signup"}
        className={`mt-5 flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-bold transition-transform hover:-translate-y-px ${
          pro ? "bg-accent text-accent-ink" : "border border-line2 text-snow hover:border-accent/50"
        }`}
      >
        {pro ? "Начать с Pro" : "Начать бесплатно"}
      </Link>
    </div>
  );
}

export default function WelcomePage() {
  const groups = toolGroups();
  const toolCount = uiToolCatalog().length;

  return (
    <div className="min-h-screen">
      {/* ── Хедер ─────────────────────────────────────────────── */}
      <header className="sticky top-0 z-50 border-b border-line bg-ink/85 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-[1100px] items-center gap-4 px-4 sm:px-6">
          {/* min-w-0 обязателен: без него flex-элемент не сжимается ниже
              своего содержимого и распирает строку. На узком экране
              остаётся короткое имя, полное возвращается с 400px. */}
          <Link href="/welcome" className="flex min-w-0 items-center gap-2">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-ink">
              <Icon name="bot" className="h-4 w-4" />
            </span>
            <span className="truncate font-display text-sm font-bold text-snow">
              <span className="min-[400px]:hidden">Agent Mr</span>
              <span className="hidden min-[400px]:inline">Unified AI Ads Agent</span>
            </span>
          </Link>
          <nav className="ml-3 hidden gap-1 sm:flex">
            <a href="#features" className="rounded-lg px-3 py-2 text-xs font-semibold text-fog hover:text-snow">
              Возможности
            </a>
            <a href="#safety" className="rounded-lg px-3 py-2 text-xs font-semibold text-fog hover:text-snow">
              Безопасность
            </a>
            <a href="#pricing" className="rounded-lg px-3 py-2 text-xs font-semibold text-fog hover:text-snow">
              Тарифы
            </a>
            <a href="#faq" className="rounded-lg px-3 py-2 text-xs font-semibold text-fog hover:text-snow">
              Вопросы
            </a>
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Link
              href="/login"
              className="hidden rounded-lg px-3 py-2 text-xs font-semibold text-mist hover:text-snow min-[420px]:block"
            >
              Войти
            </Link>
            <TrackedLink
              href="/signup"
              event="cta_signup_click"
              meta={{ location: "header" }}
              className="whitespace-nowrap rounded-lg bg-accent px-3.5 py-2 text-xs font-bold text-accent-ink transition-transform hover:-translate-y-px"
            >
              <span className="sm:hidden">Начать</span>
              <span className="hidden sm:inline">Начать бесплатно</span>
            </TrackedLink>
          </div>
        </div>
      </header>

      <LandingViewTracker />

      <div className="mx-auto w-full max-w-[1100px] px-4 sm:px-6">
        {/* ── Первый экран ────────────────────────────────────── */}
        <section className="py-14 sm:py-20">
          <div className="grid gap-10 lg:grid-cols-[1.05fr_0.95fr] lg:items-center">
            <div>
              {/* Строка с разделителями «·» не переносится сама: на узком
                  экране она распирала бы бейдж. Разрешаем перенос и не даём
                  точке сжиматься. */}
              <span className="inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-full border border-line2 bg-panel px-3 py-1.5 text-[11px] font-semibold text-mist">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                <span>Google Ads · Яндекс.Директ · Авито</span>
              </span>
              <h1 className="font-display mt-4 text-3xl leading-tight font-bold text-snow sm:text-4xl lg:text-5xl">
                Управляйте Google Ads, Яндекс.Директом и Авито <span className="text-accent">из одного чата</span>
              </h1>
              <p className="mt-4 max-w-xl text-base text-mist">
                Пишете задачу обычными словами — агент показывает предпросмотр изменения и его стоимость.
                В рекламный кабинет ничего не уходит, пока вы не нажали «Подтвердить».
              </p>
              <div className="mt-7 flex flex-wrap gap-3">
                <TrackedLink
                  href="/signup"
                  event="cta_signup_click"
                  meta={{ location: "hero" }}
                  className="rounded-xl bg-accent px-5 py-3 text-sm font-bold text-accent-ink transition-transform hover:-translate-y-px"
                >
                  Начать бесплатно
                </TrackedLink>
                <a
                  href="#how"
                  className="rounded-xl border border-line2 px-5 py-3 text-sm font-bold text-snow hover:border-accent/50"
                >
                  Как это работает
                </a>
              </div>
              <p className="mt-3 text-xs text-fog">Без карты · {toolCount} команд агента · отчёты без лимита на всех тарифах</p>
              <div className="mt-7 -mx-1">
                <MarqueePlatforms />
              </div>
            </div>

            {/* Интерактивное демо: раньше здесь была статическая картинка
                диалога. Посетитель теперь сам прогоняет сценарий и видит
                механизм подтверждения, а не читает о нём. Данные — из
                lib/demo-script.ts, без обращений к БД и LLM. */}
            <DemoAgent />
          </div>
        </section>

        {/* ── Как это работает ────────────────────────────────── */}
        <section id="how" className="border-t border-line py-14">
          <h2 className="font-display text-2xl font-bold text-snow sm:text-3xl">Как это работает</h2>
          <p className="mt-3 max-w-2xl text-sm text-mist">
            Четыре шага от регистрации до первого управляемого изменения. Первые три — бесплатно и без карты.
          </p>
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((s, i) => (
              <Card key={s.title} className="p-5">
                <div className="flex items-center gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent/12 text-accent">
                    <Icon name={s.icon} className="h-4.5 w-4.5" />
                  </span>
                  <span className="font-mono text-xs text-fog">шаг {i + 1}</span>
                </div>
                <div className="mt-3 text-sm font-bold text-snow">{s.title}</div>
                <p className="mt-1.5 text-xs leading-relaxed text-fog">{s.text}</p>
              </Card>
            ))}
          </div>
        </section>

        {/* ── Возможности (из TOOL_META) ──────────────────────── */}
        <section id="features" className="border-t border-line py-14">
          <h2 className="font-display text-2xl font-bold text-snow sm:text-3xl">Что умеет агент</h2>
          <p className="mt-3 max-w-2xl text-sm text-mist">
            <NumberTicker value={toolCount} className="font-semibold text-accent" /> команд на трёх
            площадках. Список берётся из кода агента — что он умеет на самом деле,
            то и написано здесь.
          </p>
          <div className="mt-8 grid gap-4 lg:grid-cols-3">
            {groups.map((g) => (
              <Card key={g.title} className="p-5">
                <div className="text-sm font-bold text-snow">{g.title}</div>
                <div className="mt-1 text-[11px] text-accent">{g.note}</div>
                <ul className="mt-4 space-y-2.5">
                  {g.tools.map((t) => (
                    <li key={t.name} className="flex gap-2.5">
                      <Icon name="check" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
                      <span className="min-w-0">
                        <span className="block text-xs text-mist">{t.ui.desc}</span>
                        <span className="mt-0.5 block text-[10px] text-fog">
                          {t.ui.platforms.map((p) => PLATFORM_LABEL[p]).join(" · ")}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            ))}
          </div>
        </section>

        {/* ── Безопасность ────────────────────────────────────── */}
        <section id="safety" className="border-t border-line py-14">
          <h2 className="font-display text-2xl font-bold text-snow sm:text-3xl">Почему это безопасно</h2>
          <p className="mt-3 max-w-2xl text-sm text-mist">
            Агент предлагает, решает — код. Модель не может ни обойти лимиты, ни выполнить изменение сама.
          </p>
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[
              {
                icon: "check" as const,
                t: "Ничего без подтверждения",
                d: "Любое изменение, влияющее на бюджет, сначала показывается как предпросмотр: что меняется, на сколько и во сколько обойдётся.",
              },
              {
                icon: "shield" as const,
                t: "Режим «только чтение»",
                d: "Новый кабинет подключается в режиме анализа. Управление включается вручную на странице «Безопасность».",
              },
              {
                icon: "wallet" as const,
                t: "Лимиты расхода",
                d: "Дневной, недельный и месячный потолок изменений. Лимиты проверяются дважды: при планировании и перед отправкой в кабинет.",
              },
              {
                icon: "scroll" as const,
                t: "Полный журнал действий",
                d: "Каждое действие агента — кто, что, когда и с каким результатом. Ничего не происходит «втихую».",
              },
              {
                icon: "layers" as const,
                t: "Роли и права",
                d: "Пять ролей: от наблюдателя без доступа к чату до владельца. Медиабайер ограничен по величине изменения ставки.",
              },
              {
                icon: "lock" as const,
                t: "Изоляция данных",
                d: "Данные организаций разделены на уровне СУБД (RLS), а токены рекламных кабинетов хранятся зашифрованными.",
              },
            ].map((c) => (
              <Card key={c.t} className="p-5">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent/12 text-accent">
                  <Icon name={c.icon} className="h-4.5 w-4.5" />
                </span>
                <div className="mt-3 text-sm font-bold text-snow">{c.t}</div>
                <p className="mt-1.5 text-xs leading-relaxed text-fog">{c.d}</p>
              </Card>
            ))}
          </div>
        </section>

        {/* ── Тарифы (из PLANS) ───────────────────────────────── */}
        <section id="pricing" className="border-t border-line py-14">
          <h2 className="font-display text-2xl font-bold text-snow sm:text-3xl">Тарифы</h2>
          <p className="mt-3 max-w-2xl text-sm text-mist">
            Платите только за изменения в рекламных кабинетах. Отчёты, аналитика и аудит не тарифицируются —
            бесплатного тарифа достаточно, чтобы честно оценить продукт.
          </p>
          <div className="mt-8 grid gap-5 sm:grid-cols-2">
            <PlanCard id="free" />
            <PlanCard id="pro" />
          </div>
          <p className="mt-4 text-xs text-fog">
            Оплата картой через ЮKassa или Stripe. Отмена в любой момент, без процента от рекламного расхода.
          </p>
        </section>

        {/* ── FAQ ──────────────────────────────────────────────── */}
        <section id="faq" className="border-t border-line py-14">
          <h2 className="font-display text-2xl font-bold text-snow sm:text-3xl">Частые вопросы</h2>
          <div className="mt-8 divide-y divide-line/70 border-t border-b border-line/70">
            {FAQ.map((f) => (
              <details key={f.q} className="group py-4">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-sm font-bold text-snow">
                  {f.q}
                  <Icon name="chevronDown" className="h-4 w-4 shrink-0 text-fog transition-transform group-open:rotate-180" />
                </summary>
                <p className="mt-3 max-w-2xl text-xs leading-relaxed text-mist">{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        {/* ── Финальный призыв ────────────────────────────────── */}
        <section className="border-t border-line py-14">
          <Card className="p-8 text-center sm:p-10">
            <h2 className="font-display text-2xl font-bold text-snow sm:text-3xl">
              Первый отчёт — через пять минут после регистрации
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-sm text-mist">
              Подключите один кабинет и спросите «покажи расход за последние 7 дней». Управление включите позже,
              когда решите, что агенту можно доверять.
            </p>
            <TrackedLink
              href="/signup"
              event="cta_signup_click"
              meta={{ location: "final" }}
              className="mt-6 inline-flex rounded-xl bg-accent px-6 py-3 text-sm font-bold text-accent-ink transition-transform hover:-translate-y-px"
            >
              Начать бесплатно
            </TrackedLink>
          </Card>
        </section>
      </div>

      {/* ── Футер ─────────────────────────────────────────────── */}
      <footer className="border-t border-line py-10">
        <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-4 px-4 sm:px-6 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="font-display text-sm font-bold text-snow">Unified AI Ads Agent</div>
            <div className="mt-1 text-xs text-fog">ООО «ИТА» · управление рекламой с AI-агентом</div>
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-fog">
            <Link href="/legal/privacy" className="hover:text-snow">
              Политика конфиденциальности
            </Link>
            <Link href="/legal/terms" className="hover:text-snow">
              Условия использования
            </Link>
            <a href="mailto:support@ita.example" className="hover:text-snow">
              support@ita.example
            </a>
            <Link href="/login" className="hover:text-snow">
              Вход для клиентов
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
