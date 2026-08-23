import { db } from "@/db";
import { accounts } from "@/db/schema";
import { Icon } from "@/components/icons";
import { SettingsPanel } from "@/components/settings-panel";
import { Card, PlatformBadge, SectionTitle } from "@/components/ui";
import type { Platform } from "@/lib/agent/types";

export const dynamic = "force-dynamic";

const POLICIES = [
  { icon: "eye", title: "Dry-run по умолчанию", text: "Каждая операция записи сначала выполняется как предпросмотр: виден список изменений и прогноз стоимости." },
  { icon: "shield", title: "Подтверждение бюджета", text: "Любое действие, влияющее на расход, требует явного подтверждения пользователем до применения." },
  { icon: "wallet", title: "Лимиты расходов", text: "Дневной, недельный и месячный лимиты на аккаунт. Прогноз расхода проверяется до выполнения." },
  { icon: "scroll", title: "Полный audit-log", text: "Кто, что, когда, с какими параметрами и каким результатом — включая dry-run и блокировки." },
  { icon: "lock", title: "Секреты вне кода", text: "API-ключи и токены платформ хранятся в переменных окружения / секрет-менеджере, никогда в БД." },
  { icon: "layers", title: "Песочницы платформ", text: "Демо-кабинеты подключены в режиме sandbox — реальные рекламные бюджеты не затрагиваются." },
];

export default async function SafetyPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const accs = await db.select().from(accounts);
  const sp = await searchParams;
  const oauthOk = sp.oauth === "ok" ? String(sp.platform ?? "") : null;
  const oauthErr = sp.oauth === "error" ? String(sp.platform ?? "") : null;

  return (
    <div className="rise-in">
      {oauthOk ? (
        <div className="mb-4 rounded-xl border border-good/40 bg-good/10 px-4 py-3 text-sm text-good">
          ✓ {oauthOk === "avito" ? "Авито" : oauthOk === "google" ? "Google Ads" : "Яндекс.Директ"} подключён: режим production, адаптер работает с реальным API.
        </div>
      ) : null}
      {oauthErr ? (
        <div className="mb-4 rounded-xl border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad">
          ✗ Ошибка подключения {oauthErr === "avito" ? "Авито" : oauthErr === "google" ? "Google Ads" : "Яндекс.Директ"} — проверьте OAuth-ключи в .env и повторите.
        </div>
      ) : null}

      <SectionTitle
        title="Безопасность"
        sub="Единый safety-слой для всех трёх платформ: защищает от случайных трат и даёт полную трассируемость действий"
      />

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="xl:col-span-1">
          <SettingsPanel />
        </div>

        <div className="space-y-4 xl:col-span-2">
          <div className="grid gap-3 sm:grid-cols-2">
            {POLICIES.map((p) => (
              <Card key={p.title} className="p-4">
                <div className="flex items-center gap-2">
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent/15 text-accent">
                    <Icon name={p.icon} className="h-4 w-4" />
                  </span>
                  <h3 className="text-sm font-bold">{p.title}</h3>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-fog">{p.text}</p>
              </Card>
            ))}
          </div>

          <Card className="p-4">
            <h3 className="font-display text-sm font-bold tracking-tight">Подключённые аккаунты</h3>
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              {accs.map((a) => (
                <div key={a.id} className="rounded-lg border border-line bg-panel2 p-3">
                  <PlatformBadge p={a.platform as Platform} small />
                  <div className="mt-2 truncate text-xs font-semibold text-snow">{a.name}</div>
                  <div className="truncate text-[11px] text-fog">{a.login}</div>
                  <div className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-line bg-panel px-2 py-0.5 text-[10px] uppercase tracking-wide text-fog">
                    <span className="h-1 w-1 rounded-full bg-good" /> {a.mode}
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card className="p-4 text-xs leading-relaxed text-fog">
            <h3 className="mb-1 font-display text-sm font-bold tracking-tight text-snow">Как агент применяет политики</h3>
            Операции записи (пауза кампаний, ставки, бюджеты, продвижение, создание кампаний) всегда проходят цепочку:{" "}
            <span className="text-mist">режим доступа → лимиты расхода → dry-run предпросмотр → подтверждение → запись в audit-log</span>.
            Попробуйте отключить «Режим только чтение» и попросить агента поднять ставки — или уменьшить дневной лимит до 5 000 ₽ и
            запросить создание кампании, чтобы увидеть блокировку политикой.
          </Card>
        </div>
      </div>
    </div>
  );
}
