import { NextResponse } from "next/server";
import { yandexAuthUrl, yandexExchangeCode } from "@/lib/adapters/yandex-direct/client";
import { createOauthState, consumeOauthState } from "@/lib/oauth-state";
import { setAccountMode } from "@/lib/adapters/oauth-store";

export const dynamic = "force-dynamic";

// GET /api/oauth/yandex?start=1  → redirect to Yandex ID consent
// GET /api/oauth/yandex?code=&state=  → callback
export async function GET(req: Request) {
  const url = new URL(req.url);
  const backTo = `${process.env.PUBLIC_URL ?? new URL(req.url).origin}/safety`;
  try {
    if (url.searchParams.get("start")) {
      const state = createOauthState("yandex");
      return NextResponse.redirect(yandexAuthUrl(state));
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state || !consumeOauthState(state)) {
      return NextResponse.redirect(`${backTo}?oauth=error&platform=yandex`);
    }
    await yandexExchangeCode(code);
    await setAccountMode("yandex", "production");
    return NextResponse.redirect(`${backTo}?oauth=ok&platform=yandex`);
  } catch (e) {
    console.error("yandex oauth error", e);
    return NextResponse.redirect(`${backTo}?oauth=error&platform=yandex`);
  }
}
