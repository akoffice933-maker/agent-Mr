import { NextResponse } from "next/server";
import { runAgent } from "@/lib/agent/run";
import { withTenantRequest } from "@/lib/tenant/request";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    return await withTenantRequest(req, async (ctx) => {
      const body = (await req.json()) as { message?: string };
      const message = (body.message ?? "").trim();
      if (!message) return NextResponse.json({ error: "empty" }, { status: 400 });
      if (message.length > 500) return NextResponse.json({ error: "too long" }, { status: 400 });
      const { user, agent } = await runAgent(message, "chat", ctx);
      return NextResponse.json({ user, agent });
    });
  } catch (e) {
    log.error("agent chat failed", {}, e);
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
