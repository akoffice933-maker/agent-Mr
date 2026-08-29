import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { campaigns } from "@/db/schema";
import { getSettings, writeAudit } from "@/lib/agent/safety";
import { withTenantRequest } from "@/lib/tenant/request";
import { requireAction } from "@/lib/tenant/route-authz";
import type { Action } from "@/lib/agent/rbac";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    return await withTenantRequest(req, async () => {
      const body = (await req.json()) as { campaignId?: number; action?: "pause" | "resume" | "promote" };
    if (!body.campaignId || !body.action) return NextResponse.json({ error: "bad request" }, { status: 400 });

    const required: Action = body.action === "promote" ? "execute_promotion" : "execute_campaign_status";
    const denied = requireAction(req, required);
    if (denied) return denied;

    const settings = await getSettings();
    const camp = (await db.select().from(campaigns).where(eq(campaigns.id, body.campaignId)))[0];
    if (!camp) return NextResponse.json({ error: "not found" }, { status: 404 });

    if (settings.readOnly) {
      await writeAudit({
        actor: "ui",
        tool: `ui_${body.action}`,
        params: { campaignId: camp.id, name: camp.name },
        platforms: [camp.platform],
        dryRun: false,
        status: "blocked",
        summary: `UI: ${body.action} «${camp.name}» заблокировано (режим только чтение)`,
      });
      return NextResponse.json({ error: "read_only" }, { status: 403 });
    }

    if (settings.dryRun) {
      await writeAudit({
        actor: "ui",
        tool: `ui_${body.action}`,
        params: { campaignId: camp.id, name: camp.name },
        platforms: [camp.platform],
        dryRun: true,
        status: "dry_run",
        summary: `UI: ${body.action} «${camp.name}» — dry-run, изменения не применены`,
      });
      return NextResponse.json({ dryRunBlocked: true });
    }

    if (body.action === "pause") await db.update(campaigns).set({ status: "paused" }).where(eq(campaigns.id, camp.id));
    if (body.action === "resume") await db.update(campaigns).set({ status: "active" }).where(eq(campaigns.id, camp.id));
    if (body.action === "promote") await db.update(campaigns).set({ promotion: "boost7" }).where(eq(campaigns.id, camp.id));

    await writeAudit({
      actor: "ui",
      tool: `ui_${body.action}`,
      params: { campaignId: camp.id, name: camp.name },
      platforms: [camp.platform],
      dryRun: false,
      status: "applied",
      summary: `UI: ${body.action} «${camp.name}» выполнено`,
    });

      return NextResponse.json({ ok: true });
    });
  } catch (e) {
    console.error("campaign action error", e);
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
