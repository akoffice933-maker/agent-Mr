import { NextResponse } from "next/server";
import { googleAuthUrl, googleExchangeCode } from "@/lib/adapters/google-ads/client";
import { createOauthState, consumeOauthState } from "@/lib/oauth-state";
import { setAccountMode } from "@/lib/adapters/oauth-store";
import { getAdapter } from "@/lib/adapters";

export const dynamic = "force-dynamic";

// GET /api/oauth/google?start=1  → redirect to Google consent screen
// GET /api/oauth/google?code=&state=  → callback: exchange code, store token, back to UI
export async function GET(req: Request) {
  const url = new URL(req.url);
  const origin = process.env.PUBLIC_URL ?? new URL(req.url).origin;
  const backTo = `${origin}/agent?onboard=google`;
  const errTo = `${origin}/safety`;
  try {
    if (url.searchParams.get("start")) {
      const state = createOauthState("google");
      return NextResponse.redirect(googleAuthUrl(state));
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state || !consumeOauthState(state)) {
      return NextResponse.redirect(`${errTo}?oauth=error&platform=google`);
    }
    await googleExchangeCode(code);
    await setAccountMode("google", "production");
    // First sync right away so the onboarding banner shows real numbers.
    try {
      await (await getAdapter("google")).sync();
    } catch (e) {
      console.error("post-oauth sync failed for google:", (e as Error).message);
    }
    return NextResponse.redirect(`${backTo}`);
  } catch (e) {
    console.error("google oauth error", e);
    return NextResponse.redirect(`${errTo}?oauth=error&platform=google`);
  }
}
