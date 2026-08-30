import { NextResponse } from "next/server";
import { googleAuthUrl, googleExchangeCode } from "@/lib/adapters/google-ads/client";
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
  return { backTo: `${origin}/agent?onboard=google`, errTo: `${origin}/safety` };
}

// GET /api/oauth/google?start=1  → tenant-bound redirect to Google consent screen
// GET /api/oauth/google?code=&state=  → callback: verify state vs session, exchange, store, sync
export async function GET(req: Request) {
  const url = new URL(req.url);
  const { backTo, errTo } = backUrls(req);
  try {
    if (url.searchParams.get("start")) {
      const ctx = await resolveRequestContext(req);
      if (!ctx) return NextResponse.redirect(`${errTo}?oauth=error&platform=google`);
      const denied = requireActionRole(parseRole(ctx.role), "credentials");
      if (denied) return denied;
      // Billing: connecting a NEW platform consumes a plan slot. Checked at
      // the START of the flow, before the user is bounced to the provider's
      // consent screen — telling someone their plan is full only after they
      // granted access would be a bait-and-switch. Re-connecting an existing
      // platform stays free (see canConnectPlatform).
      const quota = await withTenant(ctx, () => canConnectPlatform(ctx.orgId, "google"));
      if (!quota.allowed) {
        return NextResponse.redirect(`${errTo}?oauth=plan_limit&platform=google`);
      }
      const state = await withTenant(ctx, () => createOauthState("google", ctx));
      return NextResponse.redirect(googleAuthUrl(state));
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    // Verify the completing session matches the one that initiated the flow.
    const session = await resolveSessionContext(req).catch(() => null);
    if (!code || !state || !session) {
      return NextResponse.redirect(`${errTo}?oauth=error&platform=google`);
    }
    // Consume inside the completing session's tenant context: RLS makes a
    // state issued for another organization invisible, so the cross-tenant
    // check is enforced by Postgres. The explicit comparison below stays as
    // defense in depth (and catches "same org, different user").
    const entry = await withTenant(session, () => consumeOauthState(state));
    if (!entry || entry.orgId !== session.orgId || (entry.userId !== null && entry.userId !== session.userId)) {
      return NextResponse.redirect(`${errTo}?oauth=error&platform=google`);
    }
    const ctx: TenantContext = session;
    return await withTenant(ctx, async () => {
      await googleExchangeCode(code!);
      await setAccountMode("google", "production");
      try {
        await (await getAdapter("google")).sync();
      } catch (e) {
        log.warn("post-oauth sync failed", { platform: "google" }, e);
      }
      return NextResponse.redirect(backTo);
    });
  } catch (e) {
    log.error("oauth callback failed", { platform: "google" }, e);
    return NextResponse.redirect(`${errTo}?oauth=error&platform=google`);
  }
}
