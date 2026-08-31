import { eq, and, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import { accounts, campaigns, metricsDaily, recommendations, settings } from "@/db/schema";
import { dateNDaysAgo } from "@/lib/format";
import { Chat } from "@/components/chat";
import { Icon } from "@/components/icons";
import { Card, SectionTitle } from "@/components/ui";
import { OnboardBanner } from "@/components/onboard-banner";
import { OnboardingChecklist } from "@/components/onboarding-checklist";
import type { Platform } from "@/lib/agent/types";
import { withTenantPage } from "@/lib/auth/dal";
import { uiToolCatalog } from "@/lib/agent/tool-meta";

export const dynamic = "force-dynamic";

// Projection of TOOL_META — never a second hand-maintained list (see tool-meta.ts).
const UNIFIED_TOOLS = uiToolCatalog();

const PLATFORM_NAMES: Record<Platform, string> = {
  google: "Google Ads",
  yandex: "Яндекс.Директ",
  avito: "Авито",
};

const DOT: Record<string, string> = { g: "bg-google", y: "bg-yandex", a: "bg-avito" };

export default async function AgentPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return withTenantPage(async () => {
  const sp = await searchParams;
  const onboard = typeof sp.onboard === "string" && ["google", "yandex", "avito"].includes(sp.onboard) ? (sp.onboard as Platform) : null;

  let banner: React.ReactNode = null;
  if (onboard) {
    const acc = (await db.select().from(accounts).where(eq(accounts.platform, onboard)))[0];
    const prod = acc?.mode === "production";
    const openRecs = (await db.select().from(recommendations).where(eq(recommendations.status, "open"))).length;
    const readOnlyRow = (await db.select().from(settings).where(eq(settings.key, "read_only")))[0];
    const readOnly = readOnlyRow ? readOnlyRow.value === true : true;
    const from = dateNDaysAgo(6);
    const m = (
      await db
        .select({ spend: sql<number>`coalesce(sum(${metricsDaily.spend}), 0)` })
        .from(metricsDaily)
        .innerJoin(campaigns, eq(metricsDaily.campaignId, campaigns.id))
        .where(and(eq(campaigns.platform, onboard), gte(metricsDaily.date, from)))
    )[0];
    const camps = await db.select({ status: campaigns.status }).from(campaigns).where(eq(campaigns.platform, onboard));
    if (prod) {
      banner = (
        <OnboardBanner
          platform={onboard}
          platformName={PLATFORM_NAMES[onboard]}
          campaignsCount={camps.length}
          activeCount={camps.filter((c) => c.status === "active").length}
          spend7d={Number(m?.spend ?? 0)}
          openRecs={openRecs}
          readOnly={readOnly}
        />
      );
    }
  }

  return (
    <div className="rise-in flex h-[calc(100vh-3rem)] flex-col overflow-y-auto">
      <SectionTitle
        title="AI-агент"
        sub="Единая точка входа: естественный язык → 12 унифицированных команд → адаптеры платформ"
      />
      {banner}
      <OnboardingChecklist />
      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[1fr_300px]">
        <Card className="flex min-h-0 flex-col p-4">
          <Chat />
        </Card>

        <div className="hidden min-h-0 flex-col gap-4 overflow-y-auto lg:flex">
          <Card className="p-4">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-fog">
              <Icon name="zap" className="h-3.5 w-3.5 text-accent" />
              Как это работает
            </div>
            <ol className="mt-2 space-y-1.5 text-[11px] leading-snug text-mist">
              <li>1. AI Core разбирает намерение (в демо — детерминированный роутер, в проде — OpenRouter tool calling)</li>
              <li>2. Unified Tool Layer маршрутизирует команду адаптерам: google-ads-api-agent, yadirect-agent, avito-mcp</li>
              <li>3. Safety-слой: dry-run, лимиты бюджета, подтверждения</li>
              <li>4. Результат агрегируется и пишется в audit-log</li>
            </ol>
          </Card>

          <Card className="flex-1 p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wide text-fog">Unified Tool Layer</span>
              <span className="rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[10px] font-bold text-accent">{UNIFIED_TOOLS.length} tools</span>
            </div>
            <div className="space-y-1">
              {UNIFIED_TOOLS.map((t) => (
                <div key={t.name} className="rounded-lg border border-line bg-panel2 px-2.5 py-1.5">
                  <div className="flex items-center gap-1.5">
                    <code className="text-[10px] font-semibold text-accent">{t.name}</code>
                    {t.kind === "write" && (
                      <span
                        title="Изменяет кабинет — выполняется только после вашего подтверждения"
                        className="rounded border border-warn/40 bg-warn/10 px-1 text-[9px] font-bold uppercase text-warn"
                      >
                        изменяет
                      </span>
                    )}
                    <span className="ml-auto flex gap-1">
                      {t.ui.platforms.map((p) => (
                        <span key={p} className={`h-1.5 w-1.5 rounded-full ${DOT[p]}`} />
                      ))}
                    </span>
                  </div>
                  <div className="text-[10px] text-fog">{t.ui.desc}</div>
                </div>
              ))}
            </div>
          </Card>

          <Card className="p-4 text-[11px] text-fog">
            <div className="flex items-center gap-2 font-semibold text-mist">
              <Icon name="chat" className="h-3.5 w-3.5 text-accent" /> Интерфейсы
            </div>
            <div className="mt-1.5 space-y-1">
              <div>· Веб-чат (этот экран) — активен</div>
              <div>· CLI (typer) — доступен в полной версии</div>
              <div>· MCP-сервер — 12 tools с JSON Schema</div>
              <div>· Telegram-бот (aiogram) — те же подтверждения</div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
  });
}
