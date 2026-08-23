import { NextResponse } from "next/server";
import { googleAuthUrl, googleExchangeCode } from "@/lib/adapters/google-ads/client";
import { createOauthState, consumeOauthState } from "@/lib/oauth-state";
import { setAccountMode } from "@/lib/adapters/oauth-store";
import { getAdapter } from "@/lib/adapters";
import { withTenant } from "@/lib/tenant/pool";
import { requireActionRole } from "@/lib/tenant/route-authz";
import { parseRole } from "@/lib/agent/rbac";
import { resolveRequestContext, resolveSessionContext } from "@/lib/tenant/resolve";
import type { TenantContext } from "@/lib/tenant/pool";

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
      const state = createOauthState("google", ctx);
      return NextResponse.redirect(googleAuthUrl(state));
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const entry = state ? consumeOauthState(state) : null;
    // Verify the completing session matches the one that initiated the flow.
    const session = await resolveSessionContext(req).catch(() => null);
    if (!code || !entry || !session || entry.orgId !== session.orgId || (entry.userId !== null && entry.userId !== session.userId)) {
      return NextResponse.redirect(`${errTo}?oauth=error&platform=google`);
    }
    const ctx: TenantContext = session;
    return await withTenant(ctx, async () => {
      await googleExchangeCode(code!);
      await setAccountMode("google", "production");
      try {
        await (await getAdapter("google")).sync();
      } catch (e) {
        console.error("post-oauth sync failed (google):", (e as Error).message);
      }
      return NextResponse.redirect(backTo);
    });
  } catch (e) {
    console.error("google oauth error", e);
    return NextResponse.redirect(`${errTo}?oauth=error&platform=google`);
  }
}
