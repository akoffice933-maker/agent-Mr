import { NextResponse } from "next/server";
import { getChatHistory } from "@/lib/agent/run";
import { withTenantRequest } from "@/lib/tenant/request";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    return await withTenantRequest(req, async () => {
      const rows = await getChatHistory();
      return NextResponse.json({ messages: rows });
    });
  } catch (e) {
    log.error("agent messages fetch failed", {}, e);
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
