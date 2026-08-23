import { NextResponse } from "next/server";
import { yandexAuthUrl, yandexExchangeCode } from "@/lib/adapters/yandex-direct/client";
import { createOauthState, consumeOauthState } from "@/lib/oauth-state";
import { setAccountMode } from "@/lib/adapters/oauth-store";
import { getAdapter } from "@/lib/adapters";

export const dynamic = "force-dynamic";

// GET /api/oauth/yandex?start=1  → redirect to Yandex ID consent
// GET /api/oauth/yandex?code=&state=  → callback
export async function GET(req: Request) {
  const url = new URL(req.url);
  const origin = process.env.PUBLIC_URL ?? new URL(req.url).origin;
  const backTo = `${origin}/agent?onboard=yandex`;
  const errTo = `${origin}/safety`;
  try {
    if (url.searchParams.get("start")) {
      const state = createOauthState("yandex");
      return NextResponse.redirect(yandexAuthUrl(state));
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state || !consumeOauthState(state)) {
      return NextResponse.redirect(`${errTo}?oauth=error&platform=yandex`);
    }
    await yandexExchangeCode(code);
    await setAccountMode("yandex", "production");
    // First sync right away so the onboarding banner shows real numbers.
    try {
      await (await getAdapter("yandex")).sync();
    } catch (e) {
      console.error("post-oauth sync failed for yandex:", (e as Error).message);
    }
    return NextResponse.redirect(`${backTo}`);
  } catch (e) {
    console.error("yandex oauth error", e);
    return NextResponse.redirect(`${errTo}?oauth=error&platform=yandex`);
  }
}
