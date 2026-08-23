import { NextResponse } from "next/server";
import { yandexAuthUrl, yandexExchangeCode } from "@/lib/adapters/yandex-direct/client";
import { createOauthState, consumeOauthState } from "@/lib/oauth-state";
import { setAccountMode } from "@/lib/adapters/oauth-store";
import { getAdapter } from "@/lib/adapters";
import { withTenant } from "@/lib/tenant/pool";
import { resolveRequestContext, resolveSessionContext } from "@/lib/tenant/resolve";
import type { TenantContext } from "@/lib/tenant/pool";

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
      const state = createOauthState("yandex", ctx);
      return NextResponse.redirect(yandexAuthUrl(state));
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const entry = state ? consumeOauthState(state) : null;
    const session = await resolveSessionContext(req).catch(() => null);
    if (!code || !entry || !session || entry.orgId !== session.orgId || (entry.userId !== null && entry.userId !== session.userId)) {
      return NextResponse.redirect(`${errTo}?oauth=error&platform=yandex`);
    }
    const ctx: TenantContext = session;
    return await withTenant(ctx, async () => {
      await yandexExchangeCode(code!);
      await setAccountMode("yandex", "production");
      try {
        await (await getAdapter("yandex")).sync();
      } catch (e) {
        console.error("post-oauth sync failed (yandex):", (e as Error).message);
      }
      return NextResponse.redirect(backTo);
    });
  } catch (e) {
    console.error("yandex oauth error", e);
    return NextResponse.redirect(`${errTo}?oauth=error&platform=yandex`);
  }
}
