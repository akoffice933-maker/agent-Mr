import Link from "next/link";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { accounts, campaigns, metricsDaily, recommendations } from "@/db/schema";
import { dateNDaysAgo, fmtMoney, fmtNum, fmtPct, todayISO } from "@/lib/format";
import { Card, PlatformBadge, SectionTitle } from "@/components/ui";
import { Icon } from "@/components/icons";
import { PLATFORM_LABEL, type Platform, type PlatformStat } from "@/lib/agent/types";
import { headers } from "next/headers";
import { withTenantHeaders } from "@/lib/tenant/request";

export const dynamic = "force-dynamic";

const PERIODS = [7, 14, 30];

interface RowData extends PlatformStat {
  campaigns: number;
}

export default async function ReportPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const __h = await headers();
  return withTenantHeaders(__h, async () => {
  const sp = await searchParams;
  const days = Math.min(30, Math.max(1, parseInt(String(sp.days ?? "7"), 10) || 7));
  const from = dateNDaysAgo(days - 1);
  const to = todayISO();

  const prodPlatforms = (await db.select().from(accounts)).filter((a) => a.mode === "production").map((a) => a.platform as Platform);

  const rows: RowData[] = (["google", "yandex", "avito"] as Platform[]).map((p) => ({
    platform: p, campaigns: 0, spend: 0, impressions: 0, clicks: 0, conversions: 0, ctr: 0, cpa: null,
  }));

  // aggregate per platform
  for (const p of ["google", "yandex", "avito"] as Platform[]) {
    const r = (
      await db
        .select({
          spend: sql<number>`coalesce(sum(${metricsDaily.spend}), 0)`,
          impressions: sql<number>`coalesce(sum(${metricsDaily.impressions}), 0)`,
          clicks: sql<number>`coalesce(sum(${metricsDaily.clicks}), 0)`,
          conversions: sql<number>`coalesce(sum(${metricsDaily.conversions}), 0)`,
          count: sql<number>`count(${sql`distinct ${campaigns.id}`})`,
        })
        .from(metricsDaily)
        .innerJoin(campaigns, eq(metricsDaily.campaignId, campaigns.id))
        .where(and(eq(campaigns.platform, p), gte(metricsDaily.date, from), sql`${metricsDaily.date} <= ${to}`))
    )[0];
    const spend = Number(r?.spend ?? 0);
    const impressions = Number(r?.impressions ?? 0);
    const clicks = Number(r?.clicks ?? 0);
    const conversions = Number(r?.conversions ?? 0);
    rows[(["google", "yandex", "avito"] as Platform[]).indexOf(p)] = {
      platform: p,
      campaigns: Number(r?.count ?? 0),
      spend,
      impressions,
      clicks,
      conversions,
      ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
      cpa: conversions > 0 ? spend / conversions : null,
    };
  }

  const totalSpend = rows.reduce((a, r) => a + r.spend, 0);
  const withCpa = rows.filter((r) => r.cpa !== null && r.spend > 0).sort((a, b) => (a.cpa ?? 0) - (b.cpa ?? 0));
  const best = withCpa[0];
  const worst = withCpa[withCpa.length - 1];
  const cpaDiff = best && worst && best.cpa ? Math.round(((worst.cpa! - best.cpa!) / best.cpa!) * 100) : null;

  const advisor =
    best && worst && best.cpa && cpaDiff !== null && cpaDiff >= 25 && best.platform !== worst.platform
      ? {
          from: worst.platform,
          to: best.platform,
          insight: `CPA в ${PLATFORM_LABEL[worst.platform]} на ${cpaDiff}% выше, чем в ${PLATFORM_LABEL[best.platform]} (${fmtMoney(worst.cpa)} против ${fmtMoney(best.cpa)}). Рекомендация: перенести 15% бюджета с ${PLATFORM_LABEL[worst.platform]} на ${PLATFORM_LABEL[best.platform]} — через «Покажи рекомендации» и подтверждение.`,
        }
      : null;

  const openRecs = await db.select().from(recommendations).where(eq(recommendations.status, "open")).orderBy(desc(recommendations.id)).limit(5);

  return (
    <div className="rise-in">
      <SectionTitle title="Кросс-платформенный отчёт" sub={`Сводная эффективность ${prodPlatforms.length ? `(${prodPlatforms.length} площадок в production + sandbox)` : "по трём площадкам"} за ${days} дней`} />

      {/* period selector */}
      <div className="mb-4 flex gap-2">
        {PERIODS.map((d) => (
          <Link
            key={d}
            href={`/report?days=${d}`}
            className={`rounded-full border px-4 py-1.5 text-xs font-bold transition-colors ${
              d === days ? "border-accent/50 bg-accent/15 text-accent" : "border-line bg-panel2 text-fog hover:text-mist"
            }`}
          >
            {d} дн
          </Link>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        <div className="space-y-4">
          {/* platform table */}
          <Card className="overflow-x-auto p-0">
            <table className="w-full min-w-[560px]">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wide text-fog">
                  <th className="px-4 py-3">Платформа</th>
                  <th className="px-4 py-3 text-right">Кампаний</th>
                  <th className="px-4 py-3 text-right">Расход</th>
                  <th className="px-4 py-3 text-right">Показы</th>
                  <th className="px-4 py-3 text-right">Клики</th>
                  <th className="px-4 py-3 text-right">Конверсии</th>
                  <th className="px-4 py-3 text-right">CTR</th>
                  <th className="px-4 py-3 text-right">CPA</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.platform} className="border-t border-line/60">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <PlatformBadge p={r.platform} small />
                        {prodPlatforms.includes(r.platform) ? (
                          <span className="rounded-full border border-good/40 bg-good/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-good">production</span>
                        ) : (
                          <span className="rounded-full border border-line px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-fog">sandbox</span>
                        )}
                      </div>
                    </td>
                    <td className="num px-4 py-3 text-right text-xs text-mist">{r.campaigns}</td>
                    <td className="num px-4 py-3 text-right text-xs font-bold text-snow">{fmtMoney(r.spend)}</td>
                    <td className="num px-4 py-3 text-right text-xs text-mist">{fmtNum(r.impressions)}</td>
                    <td className="num px-4 py-3 text-right text-xs text-mist">{fmtNum(r.clicks)}</td>
                    <td className="num px-4 py-3 text-right text-xs text-mist">{fmtNum(r.conversions)}</td>
                    <td className="num px-4 py-3 text-right text-xs text-mist">{r.ctr ? fmtPct(r.ctr, 2) : "—"}</td>
                    <td className={`num px-4 py-3 text-right text-xs ${best && r.platform === best.platform ? "font-bold text-good" : "text-mist"}`}>{r.cpa ? fmtMoney(r.cpa) : "—"}</td>
                  </tr>
                ))}
                <tr className="border-t border-line bg-panel2/50">
                  <td className="px-4 py-3 text-xs font-bold text-snow">Итого</td>
                  <td className="num px-4 py-3 text-right text-xs text-fog">{rows.reduce((a, r) => a + r.campaigns, 0)}</td>
                  <td className="num px-4 py-3 text-right text-xs font-bold text-snow">{fmtMoney(totalSpend)}</td>
                  <td className="num px-4 py-3 text-right text-xs text-fog" colSpan={5}></td>
                </tr>
              </tbody>
            </table>
          </Card>

          {/* CPA comparison */}
          <Card className="p-4">
            <div className="flex items-center gap-2">
              <Icon name="target" className="h-4 w-4 text-accent" />
              <h3 className="font-display text-sm font-bold tracking-tight">Сравнение CPA</h3>
            </div>
            {withCpa.length >= 2 && best && worst ? (
              <div className="mt-3 space-y-2">
                {withCpa.map((r, i) => (
                  <div key={r.platform} className="flex items-center gap-3">
                    <PlatformBadge p={r.platform} small />
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-panel3">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${Math.max(8, 100 - (i * 100) / Math.max(1, withCpa.length - 1))}%`,
                          background: i === 0 ? "var(--color-good)" : i === withCpa.length - 1 ? "var(--color-bad)" : "var(--color-warn)",
                        }}
                      />
                    </div>
                    <span className={`w-20 text-right text-xs font-bold ${i === 0 ? "text-good" : i === withCpa.length - 1 ? "text-bad" : "text-warn"}`}>{fmtMoney(r.cpa)}</span>
                  </div>
                ))}
                <p className="pt-1 text-xs text-fog">
                  {best && worst && cpaDiff !== null ? (
                    <>
                      <span className="font-semibold text-good">{PLATFORM_LABEL[best.platform]}</span> — лучший канал: конверсия на <span className="font-bold text-snow">{cpaDiff}%</span> дешевле, чем у{" "}
                      {PLATFORM_LABEL[worst.platform]}.
                    </>
                  ) : (
                    "Недостаточно данных для сравнения."
                  )}
                </p>
              </div>
            ) : (
              <p className="mt-2 text-xs text-fog">Нужны конверсии хотя бы на двух площадках (для Директа — подключите Метрики, см. docs/YANDEX_SETUP.md).</p>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          {/* advisor */}
          <Card className={`p-4 ${advisor ? "border-accent/40 bg-accent/[0.05]" : ""}`}>
            <div className="flex items-center gap-2">
              <Icon name="zap" className="h-4 w-4 text-accent" />
              <h3 className="font-display text-sm font-bold tracking-tight">Cross-Platform Advisor</h3>
            </div>
            {advisor ? (
              <>
                <p className="mt-2 text-xs leading-relaxed text-mist">{advisor.insight}</p>
                <Link
                  href="/agent"
                  className="mt-3 inline-block rounded-lg bg-accent px-3.5 py-2 text-xs font-bold text-accent-ink transition-transform hover:-translate-y-px"
                >
                  Обсудить с агентом →
                </Link>
              </>
            ) : (
              <p className="mt-2 text-xs text-fog">
                Разрыв CPA между площадками меньше 25% — перераспределение не рекомендуется. Советник сработает, когда разрыв станет значимым.
              </p>
            )}
          </Card>

          {/* open recommendations */}
          <Card className="p-4">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-sm font-bold tracking-tight">Открытые рекомендации</h3>
              <Link href="/audit" className="text-[11px] font-semibold text-accent hover:underline">все →</Link>
            </div>
            {openRecs.length ? (
              <div className="mt-2 space-y-2">
                {openRecs.map((r) => (
                  <div key={r.id} className="rounded-lg border border-line bg-panel2 p-2.5">
                    <div className="flex items-center gap-2">
                      <PlatformBadge p={r.platform as Platform} small />
                      <span className="text-[10px] text-fog">#{r.id}</span>
                    </div>
                    <div className="mt-1 text-[11px] leading-snug text-mist">{r.description}</div>
                    {r.impact ? <div className="mt-1 text-[10px] font-semibold text-accent">{r.impact}</div> : null}
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-xs text-fog">Открытых рекомендаций нет — запустите аудит: «Сделай аудит всех кабинетов».</p>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
  });
}
