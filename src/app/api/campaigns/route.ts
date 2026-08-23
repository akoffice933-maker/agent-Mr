import { NextResponse } from "next/server";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import { campaigns, metricsDaily } from "@/db/schema";
import { dateNDaysAgo, todayISO } from "@/lib/format";
import { withTenantRequest } from "@/lib/tenant/request";

export const dynamic = "force-dynamic";

// GET /api/campaigns?days=7&status=all — list campaigns/listings with period metrics.
// Used by the UI, MCP server and Telegram bot (ТЗ 7: external clients of the REST API).
// RLS scopes the result to the caller's organization.
export async function GET(req: Request) {
  try {
    return await withTenantRequest(req, async () => {
      const url = new URL(req.url);
      const days = Math.min(90, Math.max(1, parseInt(url.searchParams.get("days") ?? "7", 10) || 7));
      const status = url.searchParams.get("status") ?? "all";
      const from = dateNDaysAgo(days - 1);
      const to = todayISO();

      const rows = await db
        .select({
          id: campaigns.id,
          platform: campaigns.platform,
          kind: campaigns.kind,
          name: campaigns.name,
          status: campaigns.status,
          budgetDaily: campaigns.budgetDaily,
          price: campaigns.price,
          spend: sql<number>`coalesce(sum(${metricsDaily.spend}), 0)`,
          impressions: sql<number>`coalesce(sum(${metricsDaily.impressions}), 0)`,
          clicks: sql<number>`coalesce(sum(${metricsDaily.clicks}), 0)`,
          conversions: sql<number>`coalesce(sum(${metricsDaily.conversions}), 0)`,
        })
        .from(campaigns)
        .leftJoin(metricsDaily, and(eq(metricsDaily.campaignId, campaigns.id), gte(metricsDaily.date, from), sql`${metricsDaily.date} <= ${to}`))
        .groupBy(campaigns.id, campaigns.platform, campaigns.kind, campaigns.name, campaigns.status, campaigns.budgetDaily, campaigns.price)
        .orderBy(desc(sql`coalesce(sum(${metricsDaily.spend}), 0)`));

      const filtered =
        status === "all" ? rows : rows.filter((r) => r.status === status);

      return NextResponse.json({
        days,
        rows: filtered.map((r) => {
          const spend = Number(r.spend);
          const impressions = Number(r.impressions);
          const clicks = Number(r.clicks);
          const conversions = Number(r.conversions);
          return {
            id: r.id,
            platform: r.platform,
            kind: r.kind,
            name: r.name,
            status: r.status,
            budgetDaily: r.budgetDaily,
            price: r.price,
            spend: Math.round(spend),
            impressions,
            clicks,
            conversions,
            ctr: impressions > 0 ? +((clicks / impressions) * 100).toFixed(2) : 0,
            cpa: conversions > 0 ? Math.round(spend / conversions) : null,
          };
        }),
      });
    });
  } catch (e) {
    console.error("campaigns error", e);
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
