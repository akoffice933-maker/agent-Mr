import Link from "next/link";
import { gte } from "drizzle-orm";
import { db } from "@/db";
import { campaigns, metricsDaily } from "@/db/schema";
import { Card, HBar, PlatformBadge, SectionTitle, StackedBars } from "@/components/ui";
import type { Platform } from "@/lib/agent/types";
import { PLATFORM_LABEL } from "@/lib/agent/types";
import { dateNDaysAgo, fmtDate, fmtMoney, fmtNum, fmtPct } from "@/lib/format";
import { withTenantPage } from "@/lib/auth/dal";

export const dynamic = "force-dynamic";

const HEX: Record<Platform, string> = { google: "#6aa6f5", yandex: "#fb5a3c", avito: "#47d185" };
const PLATFORMS: Platform[] = ["google", "yandex", "avito"];

export default async function AnalyticsPage(props: {
  searchParams: Promise<{ period?: string }>;
}) {
  return withTenantPage(async () => {
  const sp = await props.searchParams;
  const days = [7, 14, 30].includes(Number(sp.period)) ? Number(sp.period) : 7;
  const from = dateNDaysAgo(days - 1);

  const [camps, metrics] = await Promise.all([
    db.select().from(campaigns),
    db.select().from(metricsDaily).where(gte(metricsDaily.date, from)),
  ]);
  const campById = new Map(camps.map((c) => [c.id, c]));

  const perPlatform = PLATFORMS.map((p) => {
    const list = camps.filter((c) => c.platform === p);
    const ids = new Set(list.map((c) => c.id));
    const agg = metrics
      .filter((m) => ids.has(m.campaignId))
      .reduce(
        (a, m) => ({
          spend: a.spend + m.spend,
          impressions: a.impressions + m.impressions,
          clicks: a.clicks + m.clicks,
          conversions: a.conversions + m.conversions,
        }),
        { spend: 0, impressions: 0, clicks: 0, conversions: 0 }
      );
    return {
      platform: p,
      campaigns: list.length,
      spend: agg.spend,
      impressions: agg.impressions,
      clicks: agg.clicks,
      conversions: agg.conversions,
      ctr: agg.impressions > 0 ? (agg.clicks / agg.impressions) * 100 : 0,
      cpa: agg.conversions > 0 ? agg.spend / agg.conversions : null,
    };
  });

  const totalSpend = perPlatform.reduce((a, r) => a + r.spend, 0);

  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = dateNDaysAgo(i);
    series.push({
      label: fmtDate(date),
      values: PLATFORMS.map((p) =>
        metrics
          .filter((m) => m.date === date && campById.get(m.campaignId)?.platform === p)
          .reduce((a, m) => a + m.spend, 0)
      ),
    });
  }

  const topCampaigns = camps
    .map((c) => {
      const ms = metrics.filter((m) => m.campaignId === c.id);
      const spend = ms.reduce((a, m) => a + m.spend, 0);
      const clicks = ms.reduce((a, m) => a + m.clicks, 0);
      const impressions = ms.reduce((a, m) => a + m.impressions, 0);
      const conversions = ms.reduce((a, m) => a + m.conversions, 0);
      return {
        id: c.id,
        name: c.name,
        platform: c.platform as Platform,
        status: c.status,
        spend,
        ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
        cpa: conversions > 0 ? spend / conversions : null,
      };
    })
    .filter((c) => c.spend > 0);

  const top = [...topCampaigns].sort((a, b) => b.spend - a.spend).slice(0, 8);
  const worst = [...topCampaigns]
    .filter((c) => c.status === "active")
    .sort((a, b) => a.ctr - b.ctr)
    .slice(0, 5);

  const cpaRows = perPlatform.filter((r) => r.cpa !== null).sort((a, b) => (a.cpa ?? 0) - (b.cpa ?? 0));
  const bestCpa = cpaRows[0];
  const maxCpa = Math.max(...cpaRows.map((r) => r.cpa ?? 0), 1);

  return (
    <div className="rise-in">
      <SectionTitle
        title="Сквозная аналитика"
        sub={`Единые метрики по трём рекламным платформам за последние ${days} дней`}
        right={
          <div className="flex gap-1.5">
            {[7, 14, 30].map((d) => (
              <Link
                key={d}
                href={`/analytics?period=${d}`}
                className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${
                  days === d ? "border-accent/50 bg-accent/15 text-accent" : "border-line bg-panel2 text-fog hover:text-mist"
                }`}
              >
                {d} дн
              </Link>
            ))}
          </div>
        }
      />

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="p-5 xl:col-span-2">
          <h2 className="mb-4 font-display text-sm font-bold tracking-tight">Динамика расхода по платформам</h2>
          <StackedBars days={series} height={200} />
        </Card>

        <Card className="p-5">
          <h2 className="mb-1 font-display text-sm font-bold tracking-tight">Сравнение CPA</h2>
          <p className="mb-4 text-[11px] text-fog">Чем ниже — тем эффективнее канал</p>
          <div className="space-y-2.5">
            {cpaRows.map((r) => (
              <HBar
                key={r.platform}
                label={<PlatformBadge p={r.platform} small />}
                value={r.cpa ?? 0}
                max={maxCpa}
                color={bestCpa && r.platform === bestCpa.platform ? "#4ecb8d" : HEX[r.platform]}
                suffix={fmtMoney(r.cpa)}
              />
            ))}
          </div>
          {bestCpa ? (
            <div className="mt-4 rounded-lg border border-good/30 bg-good/10 px-3 py-2 text-[11px] text-mist">
              Лучший канал: <b className="text-good">{PLATFORM_LABEL[bestCpa.platform]}</b> · {fmtMoney(bestCpa.cpa)} за конверсию
            </div>
          ) : null}
        </Card>
      </div>

      <Card className="mt-4 overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wide text-fog">
              <th className="border-b border-line px-4 py-2.5">Платформа</th>
              <th className="border-b border-line px-4 py-2.5 text-right">Объектов</th>
              <th className="border-b border-line px-4 py-2.5 text-right">Расход</th>
              <th className="border-b border-line px-4 py-2.5 text-right">Доля бюджета</th>
              <th className="border-b border-line px-4 py-2.5 text-right">Показы</th>
              <th className="border-b border-line px-4 py-2.5 text-right">Клики</th>
              <th className="border-b border-line px-4 py-2.5 text-right">CTR</th>
              <th className="border-b border-line px-4 py-2.5 text-right">Конверсии</th>
              <th className="border-b border-line px-4 py-2.5 text-right">CPA</th>
            </tr>
          </thead>
          <tbody>
            {perPlatform.map((r) => (
              <tr key={r.platform}>
                <td className="border-b border-line/50 px-4 py-2.5"><PlatformBadge p={r.platform} /></td>
                <td className="num border-b border-line/50 px-4 py-2.5 text-right text-xs">{r.campaigns}</td>
                <td className="num border-b border-line/50 px-4 py-2.5 text-right text-xs font-bold">{fmtMoney(r.spend)}</td>
                <td className="num border-b border-line/50 px-4 py-2.5 text-right text-xs text-fog">
                  {totalSpend > 0 ? fmtPct((r.spend / totalSpend) * 100, 1) : "—"}
                </td>
                <td className="num border-b border-line/50 px-4 py-2.5 text-right text-xs">{fmtNum(r.impressions)}</td>
                <td className="num border-b border-line/50 px-4 py-2.5 text-right text-xs">{fmtNum(r.clicks)}</td>
                <td className="num border-b border-line/50 px-4 py-2.5 text-right text-xs">{fmtPct(r.ctr, 2)}</td>
                <td className="num border-b border-line/50 px-4 py-2.5 text-right text-xs">{fmtNum(r.conversions)}</td>
                <td className="num border-b border-line/50 px-4 py-2.5 text-right text-xs font-semibold">{r.cpa ? fmtMoney(r.cpa) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card className="overflow-x-auto">
          <h2 className="px-4 pt-4 font-display text-sm font-bold tracking-tight">Топ кампаний по расходу</h2>
          <table className="mt-2 w-full">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-fog">
                <th className="border-b border-line px-4 py-2">Кампания</th>
                <th className="border-b border-line px-4 py-2 text-right">Расход</th>
                <th className="border-b border-line px-4 py-2 text-right">CTR</th>
                <th className="border-b border-line px-4 py-2 text-right">CPA</th>
              </tr>
            </thead>
            <tbody>
              {top.map((c) => (
                <tr key={c.id}>
                  <td className="max-w-52 truncate border-b border-line/50 px-4 py-2 text-xs font-medium">{c.name}</td>
                  <td className="num border-b border-line/50 px-4 py-2 text-right text-xs">{fmtMoney(c.spend)}</td>
                  <td className="num border-b border-line/50 px-4 py-2 text-right text-xs">{fmtPct(c.ctr, 2)}</td>
                  <td className="num border-b border-line/50 px-4 py-2 text-right text-xs">{c.cpa ? fmtMoney(c.cpa) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card>
          <h2 className="px-4 pt-4 font-display text-sm font-bold tracking-tight">Аутсайдеры по CTR</h2>
          <p className="px-4 text-[11px] text-fog">Кандидаты на паузу — агент может остановить их одной командой</p>
          <div className="space-y-2 p-4">
            {worst.map((c) => (
              <div key={c.id} className="flex items-center gap-2 rounded-lg border border-line bg-panel2 px-3 py-2">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: HEX[c.platform] }} />
                <span className="min-w-0 flex-1 truncate text-xs text-mist">{c.name}</span>
                <span className="num text-xs font-bold text-bad">{fmtPct(c.ctr, 2)}</span>
              </div>
            ))}
            <Link
              href="/agent"
              className="mt-1 inline-flex items-center gap-1.5 text-xs font-semibold text-accent hover:underline"
            >
              «Поставь на паузу кампании с CTR ниже 1%» →
            </Link>
          </div>
        </Card>
      </div>
    </div>
  );
  });
}
