import { NextResponse } from "next/server";
import { resolvePending } from "@/lib/agent/run";
import { withTenantRequest } from "@/lib/tenant/request";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    return await withTenantRequest(req, async (ctx) => {
      const body = (await req.json()) as { id?: number; decision?: string; actor?: string };
      if (!body.id || (body.decision !== "approve" && body.decision !== "reject")) {
        return NextResponse.json({ error: "bad request" }, { status: 400 });
      }
      // Tenant check: the pending action must belong to the caller's org
      // (resolvePending returns null for cross-tenant / closed actions).
      const agent = await resolvePending(body.id, body.decision, body.actor === "ui" ? "ui" : "chat", ctx);
      if (!agent) return NextResponse.json({ error: "not found" }, { status: 404 });
      return NextResponse.json({ agent });
    });
  } catch (e) {
    console.error("action error", e);
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
