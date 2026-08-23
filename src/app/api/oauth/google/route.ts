import { NextResponse } from "next/server";
import { googleAuthUrl, googleExchangeCode } from "@/lib/adapters/google-ads/client";
import { createOauthState, consumeOauthState } from "@/lib/oauth-state";
import { setAccountMode } from "@/lib/adapters/oauth-store";

export const dynamic = "force-dynamic";

// GET /api/oauth/google?start=1  → redirect to Google consent screen
// GET /api/oauth/google?code=&state=  → callback: exchange code, store token, back to UI
export async function GET(req: Request) {
  const url = new URL(req.url);
  const backTo = `${process.env.PUBLIC_URL ?? new URL(req.url).origin}/safety`;
  try {
    if (url.searchParams.get("start")) {
      const state = createOauthState("google");
      return NextResponse.redirect(googleAuthUrl(state));
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state || !consumeOauthState(state)) {
      return NextResponse.redirect(`${backTo}?oauth=error&platform=google`);
    }
    await googleExchangeCode(code);
    await setAccountMode("google", "production");
    return NextResponse.redirect(`${backTo}?oauth=ok&platform=google`);
  } catch (e) {
    console.error("google oauth error", e);
    return NextResponse.redirect(`${backTo}?oauth=error&platform=google`);
  }
}
