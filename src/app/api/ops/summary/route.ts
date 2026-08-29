import { NextResponse } from "next/server";
import { sql, count } from "drizzle-orm";
import { db, currentTenant } from "@/db";
import { accounts, campaigns, pendingActions, auditLog } from "@/db/schema";
import { withTenantRequest } from "@/lib/tenant/request";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return withTenantRequest(req, async () => {
    const [campaignsCount, accountsCount, pendingCount, auditCount] = await Promise.all([
      db.select({ n: count() }).from(campaigns),
      db.select({ n: count() }).from(accounts),
      db.select({ n: count() }).from(pendingActions).where(sql`${pendingActions.status} = 'pending'`),
      db.select({ n: count() }).from(auditLog),
    ]);
    return NextResponse.json({
      organizationId: currentTenant()?.orgId,
      campaigns: Number(campaignsCount[0]?.n ?? 0),
      accounts: Number(accountsCount[0]?.n ?? 0),
      pendingActions: Number(pendingCount[0]?.n ?? 0),
      auditEntries: Number(auditCount[0]?.n ?? 0),
      generatedAt: new Date().toISOString(),
    });
  });
}
