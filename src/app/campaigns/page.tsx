import { gte } from "drizzle-orm";
import { db } from "@/db";
import { campaigns, metricsDaily } from "@/db/schema";
import { CampaignsTable, type CampaignUiRow } from "@/components/campaigns-table";
import { SectionTitle } from "@/components/ui";
import type { Platform } from "@/lib/agent/types";
import { dateNDaysAgo } from "@/lib/format";
import { headers } from "next/headers";
import { withTenantHeaders } from "@/lib/tenant/request";

export const dynamic = "force-dynamic";

export default async function CampaignsPage() {
  const __h = await headers();
  return withTenantHeaders(__h, async () => {
  const from = dateNDaysAgo(6);
  const [camps, metrics] = await Promise.all([
    db.select().from(campaigns),
    db.select().from(metricsDaily).where(gte(metricsDaily.date, from)),
  ]);

  const agg = new Map<number, { spend: number; impressions: number; clicks: number; conversions: number }>();
  for (const m of metrics) {
    const a = agg.get(m.campaignId) ?? { spend: 0, impressions: 0, clicks: 0, conversions: 0 };
    a.spend += m.spend;
    a.impressions += m.impressions;
    a.clicks += m.clicks;
    a.conversions += m.conversions;
    agg.set(m.campaignId, a);
  }

  const rows: CampaignUiRow[] = camps.map((c) => {
    const m = agg.get(c.id) ?? { spend: 0, impressions: 0, clicks: 0, conversions: 0 };
    return {
      id: c.id,
      platform: c.platform as Platform,
      kind: c.kind,
      name: c.name,
      status: c.status,
      budgetDaily: c.budgetDaily,
      strategy: c.strategy,
      promotion: c.promotion,
      price: c.price,
      spend: Math.round(m.spend),
      impressions: m.impressions,
      clicks: m.clicks,
      conversions: m.conversions,
      ctr: m.impressions > 0 ? (m.clicks / m.impressions) * 100 : 0,
      cpa: m.conversions > 0 ? m.spend / m.conversions : null,
    };
  });

  const active = rows.filter((r) => r.status === "active").length;

  return (
    <div className="rise-in">
      <SectionTitle
        title="Кампании и объявления"
        sub={`Единый реестр по трём платформам: ${rows.length} объектов, ${active} активны. Кнопки действий проходят через тот же safety-слой, что и команды агента.`}
      />
      <CampaignsTable rows={rows} />
    </div>
  );
  });
}
