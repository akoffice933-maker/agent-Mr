import { NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { db } from "@/db";
import { pendingActions } from "@/db/schema";
import { withTenantRequest } from "@/lib/tenant/request";
import { tenantOrgId } from "@/lib/tenant/pool";
import { sweepExpiredPending } from "@/lib/agent/run";

export const dynamic = "force-dynamic";

// GET /api/agent/pending — actions awaiting confirmation (MCP/Telegram clients).
// RLS scopes the result to the caller's organization.
export async function GET(req: Request) {
  try {
    return await withTenantRequest(req, async () => {
      // 0.5: sweep stale actions so the queue never lists expired items.
      await sweepExpiredPending(tenantOrgId());
      const rows = await db.select().from(pendingActions).orderBy(desc(pendingActions.id)).limit(20);
      const items = rows
        .filter((r) => r.status === "pending")
        .map((r) => ({
          id: r.id,
          tool: r.tool,
          status: r.status,
          createdAt: r.createdAt.toISOString(),
          costDaily: r.costDaily,
          preview: r.preview,
        }));
      return NextResponse.json({ items });
    });
  } catch (e) {
    console.error("pending error", e);
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
