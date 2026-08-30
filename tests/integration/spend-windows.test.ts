// Review P3: checkBudgetHeadroom() ran three sequential aggregates over
// metrics_daily (today / 7d / 30d). They are now one conditional-aggregation
// query. This is the spend guard that stands between the agent and real money,
// so the rewrite is pinned against the old per-window implementation: the
// combined query must return exactly what three separate spendSince() calls do.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { db, withTenant } from "@/db";
import { campaigns, metricsDaily, organizations } from "@/db/schema";
import { spendSince, spendWindows } from "@/lib/agent/safety";
import { dateNDaysAgo } from "@/lib/format";

const ORG = 1;
const ctx = { orgId: ORG, userId: null, role: "admin" };

let campaignId = 0;
let otherOrgId = 0;
let otherCampaignId = 0;
const metricIds: number[] = [];
let baseline = { today: 0, week: 0, month: 0 };

async function addMetric(cid: number, daysAgo: number, spend: number, org = ORG) {
  const row = await withTenant({ orgId: org, userId: null, role: "admin" }, async () =>
    (
      await db
        .insert(metricsDaily)
        .values({ campaignId: cid, date: dateNDaysAgo(daysAgo), spend, impressions: 0, clicks: 0, conversions: 0 })
        .returning()
    )[0]
  );
  metricIds.push(row.id);
}

beforeAll(async () => {
  campaignId = (
    await withTenant(ctx, () =>
      db
        .insert(campaigns)
        .values({ organizationId: ORG, name: "SpendWindows Fixture", platform: "yandex", status: "active", budgetDaily: 100 })
        .returning()
    )
  )[0].id;

  otherOrgId = (await db.insert(organizations).values({ name: "SpendWindows Other" }).returning())[0].id;
  otherCampaignId = (
    await withTenant({ orgId: otherOrgId, userId: null, role: "admin" }, () =>
      db
        .insert(campaigns)
        .values({ organizationId: otherOrgId, name: "Other Org Campaign", platform: "yandex", status: "active", budgetDaily: 100 })
        .returning()
    )
  )[0].id;

  // Whatever the database already holds for org 1 before this test adds anything.
  baseline = await withTenant(ctx, () => spendWindows());

  // Spend spread across the three windows.
  await addMetric(campaignId, 0, 100); // today  -> today, week, month
  await addMetric(campaignId, 3, 200); //         -> week, month
  await addMetric(campaignId, 10, 400); //        -> month only
  await addMetric(campaignId, 60, 800); //        -> outside every window
  // Another organization's spend must never be counted.
  await addMetric(otherCampaignId, 0, 5000, otherOrgId);
});

afterAll(async () => {
  // Cleanup MUST run inside a tenant context: metrics_daily and campaigns are
  // RLS-protected, so a bare delete matches zero rows and silently leaks
  // fixtures into the next run (which is exactly how this test first went
  // flaky — leftover spend inflated the "today" window).
  await withTenant(ctx, async () => {
    if (metricIds.length) await db.delete(metricsDaily).where(inArray(metricsDaily.id, metricIds));
    await db.delete(campaigns).where(inArray(campaigns.id, [campaignId]));
  });
  await withTenant({ orgId: otherOrgId, userId: null, role: "admin" }, async () => {
    // The other org's metric row is invisible (and therefore undeletable) from
    // org 1's context, so it must be removed here — before its campaign, or the
    // FK from metrics_daily blocks the delete.
    await db.delete(metricsDaily).where(inArray(metricsDaily.campaignId, [otherCampaignId]));
    await db.delete(campaigns).where(inArray(campaigns.id, [otherCampaignId]));
  });
  if (otherOrgId) await db.delete(organizations).where(inArray(organizations.id, [otherOrgId]));
});

describe("spendWindows: one query instead of three (review P3)", () => {
  it("returns the same numbers as three separate spendSince() calls", async () => {
    const [combined, today, week, month] = await withTenant(ctx, async () => [
      await spendWindows(),
      await spendSince(1),
      await spendSince(7),
      await spendSince(30),
    ]);

    expect(combined.today).toBeCloseTo(today, 6);
    expect(combined.week).toBeCloseTo(week, 6);
    expect(combined.month).toBeCloseTo(month, 6);
  });

  it("assigns spend to the correct windows", async () => {
    // Asserted as a DELTA against the baseline captured before the fixtures
    // were inserted: the shared dev database already carries seeded metrics,
    // and absolute totals would make this test depend on whatever else lives
    // in the table.
    const w = await withTenant(ctx, () => spendWindows());
    expect(w.today - baseline.today).toBeCloseTo(100, 6); // only the row dated today
    expect(w.week - baseline.week).toBeCloseTo(300, 6); // today + 3 days ago
    expect(w.month - baseline.month).toBeCloseTo(700, 6); // + 10 days ago, excluding the 60-day-old row
  });

  it("never counts another organization's spend", async () => {
    // The other org booked 5000 today; if RLS or the rewrite leaked, that
    // amount would show up in org 1's delta.
    const w = await withTenant(ctx, () => spendWindows());
    expect(w.today - baseline.today).toBeLessThan(5000);
    expect(w.month - baseline.month).toBeLessThan(5000);
  });
});
