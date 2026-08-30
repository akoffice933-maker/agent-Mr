import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, tenantOrgId } from "@/db";
import { campaigns } from "@/db/schema";
import { getSettings, writeAudit } from "@/lib/agent/safety";
import { withTenantRequest } from "@/lib/tenant/request";
import { requireAction } from "@/lib/tenant/route-authz";
import { createPendingAction, resolvePending } from "@/lib/agent/run";
import type { Action } from "@/lib/agent/rbac";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

/**
 * UI quick actions (pause / resume / promote) on the campaigns table.
 *
 * Review P1.5 — this route used to mutate ONLY the local mirror:
 *
 *     if (body.action === "pause") await db.update(campaigns).set({ status: "paused" })...
 *
 * with no adapter call, no read-back and no pending action, while writing
 * `status: "applied"` / "выполнено" to the audit log. The campaign kept
 * spending money at the provider and both the UI and the audit trail claimed
 * it was paused — the single most dangerous class of bug for this product.
 *
 * It now goes through the same execution pipeline as the agent:
 *   preview → pending action → policy re-check → provider write → read-back
 *   → verified | failed, and the mirror is only updated after verification.
 *
 * The pending action is created and immediately resolved: the human intent is
 * the button click itself, so no second confirmation is required — but every
 * other guarantee (RBAC, spend limits, provider verification, audit) applies.
 */
export async function POST(req: Request) {
  try {
    return await withTenantRequest(req, async (ctx) => {
      const body = (await req.json()) as { campaignId?: number; action?: "pause" | "resume" | "promote" };
      if (!body.campaignId || !body.action) return NextResponse.json({ error: "bad request" }, { status: 400 });

      const required: Action = body.action === "promote" ? "execute_promotion" : "execute_campaign_status";
      const denied = requireAction(req, required);
      if (denied) return denied;

      const settings = await getSettings();
      const camp = (await db.select().from(campaigns).where(eq(campaigns.id, body.campaignId)))[0];
      if (!camp) return NextResponse.json({ error: "not found" }, { status: 404 });

      const label = body.action === "pause" ? "пауза" : body.action === "resume" ? "запуск" : "продвижение";

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

      // Map the UI action onto the agent's tool vocabulary so it reuses the
      // very same planEffect / executeAdapters / read-back path.
      const { tool, params } =
        body.action === "promote"
          ? { tool: "promote_low_view_listings", params: { ids: [camp.id], service: "boost7" } }
          : {
              tool: "set_campaign_status",
              params: { campaignId: camp.id, status: body.action === "pause" ? "paused" : "active" },
            };

      const created = await createPendingAction({
        org: tenantOrgId(),
        tool,
        params,
        preview: { kind: "text", text: `UI: ${label} «${camp.name}»` },
        costDaily: 0,
        source: "ui",
      });

      // Execute immediately: the button click IS the human confirmation.
      const agent = await resolvePending(created.id, "approve", "ui", ctx);
      if (!agent) {
        return NextResponse.json({ error: "internal", message: "Не удалось выполнить действие." }, { status: 500 });
      }

      // resolvePending writes its own audit entry with the true outcome
      // (verified / failed) — no optimistic "applied" record here.
      const verified = (await db.select({ status: campaigns.status, promotion: campaigns.promotion }).from(campaigns).where(eq(campaigns.id, camp.id)))[0];
      const ok = body.action === "promote" ? verified?.promotion !== "none" : verified?.status === (body.action === "pause" ? "paused" : "active");

      return NextResponse.json({
        ok,
        verified: ok,
        status: verified?.status,
        promotion: verified?.promotion,
        message: agent.content,
      });
    });
  } catch (e) {
    log.error("ui campaign action failed", {}, e);
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
