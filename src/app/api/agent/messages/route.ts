import { NextResponse } from "next/server";
import { getChatHistory, getPendingStates, sweepExpiredPending } from "@/lib/agent/run";
import { withTenantRequest } from "@/lib/tenant/request";
import { tenantOrgId } from "@/lib/tenant/pool";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    return await withTenantRequest(req, async () => {
      // Expire stale actions first, so a reload after >48h shows them as
      // expired instead of offering buttons that can no longer work.
      await sweepExpiredPending(tenantOrgId());
      const [rows, pendingStates] = await Promise.all([getChatHistory(), getPendingStates()]);
      // `pendingStates` lets the client restore which previews are already
      // resolved; without it a reload re-armed the confirm buttons.
      return NextResponse.json({ messages: rows, pendingStates });
    });
  } catch (e) {
    log.error("agent messages fetch failed", {}, e);
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
