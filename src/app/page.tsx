import Link from "next/link";
import { desc, eq, gte } from "drizzle-orm";
import { db } from "@/db";
import { accounts, auditLog, campaigns, metricsDaily, recommendations } from "@/db/schema";
import { Icon } from "@/components/icons";
import { AuditStatusBadge, Card, Delta, SectionTitle, Sparkline, StackedBars, platformDot } from "@/components/ui";
import type { Platform } from "@/lib/agent/types";
import { PLATFORM_LABEL } from "@/lib/agent/types";
import { dateNDaysAgo, fmtDateTime, fmtMoney, fmtNum, fmtPct } from "@/lib/format";
import { headers } from "next/headers";
import { withTenantHeaders } from "@/lib/tenant/request";

export const dynamic = "force-dynamic";

const HEX: Record<Platform, string> = { google: "#6aa6f5", yandex: "#fb5a3c", avito: "#47d185" };

export default async function DashboardPage() {
  const __h = await headers();
  return withTenantHeaders(__h, async () => {
  const today = dateNDaysAgo(0);
  const from14 = dateNDaysAgo(13);
  const from7 = dateNDaysAgo(6);
  const prevFrom = dateNDaysAgo(13);
  const prevTo = dateNDaysAgo(7);

  const [accs, camps, metrics, recentAudit, openRecs] = await Promise.all([
    db.select().from(accounts),
    db.select().from(campaigns),
    db.select().from(metricsDaily).where(gte(metricsDaily.date, from14)),
    db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(6),
    db.select().from(recommendations).where(eq(recommendations.status, "open")),
  ]);

  const campById = new Map(camps.map((c) => [c.id, c]));

  const sumBetween = (from: string, to: string) =>
    metrics
      .filter((m) => m.date >= from && m.date <= to)
      .reduce(
        (a, m) => ({
          spend: a.spend + m.spend,
          impressions: a.impressions + m.impressions,
          clicks: a.clicks + m.clicks,
          conversions: a.conversions + m.conversions,
        }),
        { spend: 0, impressions: 0, clicks: 0, conversions: 0 }
      );

  const last7 = sumBetween(from7, today);
  const prev7 = sumBetween(prevFrom, prevTo);
  const delta = (a: number, b: number) => (b > 0 ? ((a - b) / b) * 100 : 0);

  // stacked daily series
  const days: { label: string; values: number[] }[] = [];
  for (let i = 13; i >= 0; i--) {
    const date = dateNDaysAgo(i);
    const d = new Date(date + "T12:00:00");
    const label = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" }).format(d);
    const values: number[] = (["google", "yandex", "avito"] as Platform[]).map((p) =>
      metrics
        .filter((m) => m.date === date && campById.get(m.campaignId)?.platform === p)
        .reduce((a, m) => a + m.spend, 0)
    );
    days.push({ label, values });
  }

  const platformCards = accs.map((acc) => {
    const p = acc.platform as Platform;
    const pCamps = camps.filter((c) => c.platform === p);
    const pMetrics = metrics.filter((m) => m.date >= from7 && campById.get(m.campaignId)?.platform === p);
    const agg = pMetrics.reduce(
      (a, m) => ({
        spend: a.spend + m.spend,
        impressions: a.impressions + m.impressions,
        clicks: a.clicks + m.clicks,
        conversions: a.conversions + m.conversions,
      }),
      { spend: 0, impressions: 0, clicks: 0, conversions: 0 }
    );
    const spark: number[] = [];
    for (let i = 13; i >= 0; i--) {
      const date = dateNDaysAgo(i);
      spark.push(
        metrics
          .filter((m) => m.date === date && campById.get(m.campaignId)?.platform === p)
          .reduce((a, m) => a + m.spend, 0)
      );
    }
    return {
      acc,
      p,
      spend: agg.spend,
      ctr: agg.impressions > 0 ? (agg.clicks / agg.impressions) * 100 : 0,
      cpa: agg.conversions > 0 ? agg.spend / agg.conversions : null,
      active: pCamps.filter((c) => c.status === "active").length,
      total: pCamps.length,
      spark,
    };
  });

  const kpis = [
    {
      label: "Расход · 7 дней",
      value: fmtMoney(last7.spend),
      d: delta(last7.spend, prev7.spend),
      invert: true,
    },
    {
      label: "Клики и контакты",
      value: fmtNum(last7.clicks),
      d: delta(last7.clicks, prev7.clicks),
      invert: false,
    },
    {
      label: "Конверсии",
      value: fmtNum(last7.conversions),
      d: delta(last7.conversions, prev7.conversions),
      invert: false,
    },
    {
      label: "Средний CPA",
      value: last7.conversions > 0 ? fmtMoney(last7.spend / last7.conversions) : "—",
      d:
        prev7.conversions > 0 && last7.conversions > 0
          ? delta(last7.spend / last7.conversions, prev7.spend / prev7.conversions)
          : 0,
      invert: true,
    },
    {
      label: "Средний CTR",
      value: last7.impressions > 0 ? fmtPct((last7.clicks / last7.impressions) * 100, 2) : "—",
      d:
        prev7.impressions > 0
          ? delta((last7.clicks / last7.impressions) * 100, (prev7.clicks / prev7.impressions) * 100)
          : 0,
      invert: false,
    },
  ];

  return (
    <div className="rise-in">
      <SectionTitle
        title="Обзор"
        sub="Сводная картина по трём рекламным платформам · данные за последние 7 дней"
        right={
          <Link
            href="/agent"
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-bold text-accent-ink transition-transform hover:-translate-y-px"
          >
            <Icon name="bot" className="h-4 w-4" />
            Спросить агента
          </Link>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {kpis.map((k) => (
          <Card key={k.label} className="p-4">
            <div className="text-xs font-medium uppercase tracking-wide text-fog">{k.label}</div>
            <div className="num mt-2 font-display text-2xl font-bold tracking-tight">{k.value}</div>
            <div className="mt-1.5 text-xs text-fog">
              <Delta value={k.d} invert={k.invert} /> <span className="ml-1">к прошлой неделе</span>
            </div>
          </Card>
        ))}
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card className="p-5 xl:col-span-2">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-display text-sm font-bold tracking-tight">Расход по платформам · 14 дней</h2>
            <Link href="/analytics" className="flex items-center gap-1 text-xs font-semibold text-accent hover:underline">
              Аналитика <Icon name="arrow" className="h-3 w-3" />
            </Link>
          </div>
          <StackedBars days={days} />
        </Card>

        <Card className="p-5">
          <h2 className="font-display text-sm font-bold tracking-tight">Подключённые кабинеты</h2>
          <div className="mt-4 space-y-4">
            {platformCards.map((pc) => (
              <div key={pc.acc.id} className="rounded-lg border border-line bg-panel2 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className={`h-2 w-2 rounded-full ${platformDot(pc.p)}`} />
                    <span className="text-sm font-semibold">{PLATFORM_LABEL[pc.p]}</span>
                  </div>
                  <span className="rounded-full border border-line bg-panel px-2 py-0.5 text-[10px] uppercase tracking-wide text-fog">
                    sandbox
                  </span>
                </div>
                <div className="mt-1 truncate text-xs text-fog">{pc.acc.name}</div>
                <div className="mt-3 flex items-end justify-between gap-2">
                  <div>
                    <div className="num font-display text-lg font-bold">{fmtMoney(pc.spend)}</div>
                    <div className="text-[11px] text-fog">
                      CTR {fmtPct(pc.ctr, 2)} · CPA {pc.cpa ? fmtMoney(pc.cpa) : "—"} · {pc.active}/{pc.total} активны
                    </div>
                  </div>
                  <Sparkline values={pc.spark} color={HEX[pc.p]} width={92} height={30} />
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card className="p-5 xl:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-display text-sm font-bold tracking-tight">Последние действия агента</h2>
            <Link href="/audit" className="flex items-center gap-1 text-xs font-semibold text-accent hover:underline">
              Весь журнал <Icon name="arrow" className="h-3 w-3" />
            </Link>
          </div>
          <div className="divide-y divide-line">
            {recentAudit.map((a) => (
              <div key={a.id} className="flex items-center gap-3 py-2.5">
                <span className="w-28 shrink-0 text-[11px] text-fog">{fmtDateTime(a.ts)}</span>
                <code className="shrink-0 rounded bg-panel3 px-1.5 py-0.5 text-[11px] text-mist">{a.tool}</code>
                <span className="min-w-0 flex-1 truncate text-xs text-mist">{a.summary}</span>
                <AuditStatusBadge status={a.status} />
              </div>
            ))}
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="font-display text-sm font-bold tracking-tight">Рекомендации</h2>
          <div className="num mt-3 font-display text-3xl font-bold text-accent">{openRecs.length}</div>
          <p className="mt-1 text-xs text-fog">открытых оптимизаций по итогам аудита кабинетов</p>
          <div className="mt-4 space-y-2">
            {openRecs.slice(0, 3).map((r) => (
              <div key={r.id} className="rounded-lg border border-line bg-panel2 p-2.5 text-xs text-mist">
                <span className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full ${platformDot(r.platform as Platform)}`} />
                {r.description}
              </div>
            ))}
          </div>
          <Link
            href="/agent"
            className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-sm font-semibold text-accent transition-colors hover:bg-accent/15"
          >
            <Icon name="sparkle" className="h-4 w-4" />
            «Примени все рекомендации»
          </Link>
        </Card>
      </div>
    </div>
  );
  });
}
