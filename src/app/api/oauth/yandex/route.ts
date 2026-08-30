import { NextResponse } from "next/server";
import { yandexAuthUrl, yandexExchangeCode } from "@/lib/adapters/yandex-direct/client";
import { createOauthState, consumeOauthState } from "@/lib/oauth-state";
import { setAccountMode } from "@/lib/adapters/oauth-store";
import { getAdapter } from "@/lib/adapters";
import { withTenant } from "@/lib/tenant/pool";
import { requireActionRole } from "@/lib/tenant/route-authz";
import { canConnectPlatform } from "@/lib/billing/quota";
import { parseRole } from "@/lib/agent/rbac";
import { resolveRequestContext, resolveSessionContext } from "@/lib/tenant/resolve";
import type { TenantContext } from "@/lib/tenant/pool";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

function backUrls(req: Request) {
  const origin = process.env.PUBLIC_URL ?? new URL(req.url).origin;
  return { backTo: `${origin}/agent?onboard=yandex`, errTo: `${origin}/safety` };
}

// GET /api/oauth/yandex?start=1  → tenant-bound redirect to Yandex consent
// GET /api/oauth/yandex?code=&state=  → callback
export async function GET(req: Request) {
  const url = new URL(req.url);
  const { backTo, errTo } = backUrls(req);
  try {
    if (url.searchParams.get("start")) {
      const ctx = await resolveRequestContext(req);
      if (!ctx) return NextResponse.redirect(`${errTo}?oauth=error&platform=yandex`);
      const denied = requireActionRole(parseRole(ctx.role), "credentials");
      if (denied) return denied;
      // Billing: connecting a NEW platform consumes a plan slot. Checked at
      // the START of the flow, before the user is bounced to the provider's
      // consent screen — telling someone their plan is full only after they
      // granted access would be a bait-and-switch. Re-connecting an existing
      // platform stays free (see canConnectPlatform).
      const quota = await withTenant(ctx, () => canConnectPlatform(ctx.orgId, "yandex"));
      if (!quota.allowed) {
        return NextResponse.redirect(`${errTo}?oauth=plan_limit&platform=yandex`);
      }
      const state = await withTenant(ctx, () => createOauthState("yandex", ctx));
      return NextResponse.redirect(yandexAuthUrl(state));
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const session = await resolveSessionContext(req).catch(() => null);
    if (!code || !state || !session) {
      return NextResponse.redirect(`${errTo}?oauth=error&platform=yandex`);
    }
    // Consume inside the completing session's tenant context: RLS makes a
    // state issued for another organization invisible, so the cross-tenant
    // check is enforced by Postgres. The explicit comparison below stays as
    // defense in depth (and catches "same org, different user").
    const entry = await withTenant(session, () => consumeOauthState(state));
    if (!entry || entry.orgId !== session.orgId || (entry.userId !== null && entry.userId !== session.userId)) {
      return NextResponse.redirect(`${errTo}?oauth=error&platform=yandex`);
    }
    const ctx: TenantContext = session;
    return await withTenant(ctx, async () => {
      await yandexExchangeCode(code!);
      await setAccountMode("yandex", "production");
      try {
        await (await getAdapter("yandex")).sync();
      } catch (e) {
        log.warn("post-oauth sync failed", { platform: "yandex" }, e);
      }
      return NextResponse.redirect(backTo);
    });
  } catch (e) {
    log.error("oauth callback failed", { platform: "yandex" }, e);
    return NextResponse.redirect(`${errTo}?oauth=error&platform=yandex`);
  }
}
