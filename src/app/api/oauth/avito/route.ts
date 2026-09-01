import { NextResponse } from "next/server";
import { avitoFetchToken } from "@/lib/adapters/avito/client";
import { setAccountMode } from "@/lib/adapters/oauth-store";
import { getAdapter } from "@/lib/adapters";
import { withTenant } from "@/lib/tenant/pool";
import { requireActionRole } from "@/lib/tenant/route-authz";
import { canConnectPlatform } from "@/lib/billing/quota";
import { parseRole } from "@/lib/agent/rbac";
import { resolveRequestContext } from "@/lib/tenant/resolve";
import type { TenantContext } from "@/lib/tenant/pool";
import { log } from "@/lib/log";
import { recordAnalyticsEvent } from "@/lib/analytics-events";

export const dynamic = "force-dynamic";

// Avito Business API uses client_credentials (no consent screen):
// GET /api/oauth/avito?start=1 → fetch token in the caller's tenant context.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const origin = process.env.PUBLIC_URL ?? new URL(req.url).origin;
  const backTo = `${origin}/agent?onboard=avito`;
  const errTo = `${origin}/safety`;
  try {
    if (url.searchParams.get("start")) {
      const ctx = (await resolveRequestContext(req)) as TenantContext | null;
      if (!ctx) return NextResponse.redirect(`${errTo}?oauth=error&platform=avito`);
      const denied = requireActionRole(parseRole(ctx.role), "credentials");
      if (denied) return denied;
      // Billing: connecting a NEW platform consumes a plan slot. Checked at
      // the START of the flow, before the user is bounced to the provider's
      // consent screen — telling someone their plan is full only after they
      // granted access would be a bait-and-switch. Re-connecting an existing
      // platform stays free (see canConnectPlatform).
      const quota = await withTenant(ctx, () => canConnectPlatform(ctx.orgId, "avito"));
      if (!quota.allowed) {
        return NextResponse.redirect(`${errTo}?oauth=plan_limit&platform=avito`);
      }
      return await withTenant(ctx, async () => {
        recordAnalyticsEvent("oauth_started", ctx.orgId, { platform: "avito" }).catch(() => undefined);
        await avitoFetchToken();
        await setAccountMode("avito", "production");
        try {
          await (await getAdapter("avito")).sync();
        } catch (e) {
          log.warn("post-oauth sync failed", { platform: "avito" }, e);
        }
        recordAnalyticsEvent("oauth_done", ctx.orgId, { platform: "avito" }).catch(() => undefined);
        return NextResponse.redirect(backTo);
      });
    }
    return NextResponse.redirect(backTo);
  } catch (e) {
    log.error("oauth callback failed", { platform: "avito" }, e);
    return NextResponse.redirect(`${errTo}?oauth=error&platform=avito`);
  }
}
