import { NextResponse } from "next/server";
import { avitoFetchToken } from "@/lib/adapters/avito/client";
import { setAccountMode } from "@/lib/adapters/oauth-store";
import { getAdapter } from "@/lib/adapters";

export const dynamic = "force-dynamic";

// Avito Business API uses OAuth2 client_credentials (no user consent screen):
// GET /api/oauth/avito?start=1 → fetch token directly, store, mark production.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const origin = process.env.PUBLIC_URL ?? new URL(req.url).origin;
  const backTo = `${origin}/agent?onboard=avito`;
  const errTo = `${origin}/safety`;
  try {
    if (url.searchParams.get("start")) {
      await avitoFetchToken();
      await setAccountMode("avito", "production");
    // First sync right away so the onboarding banner shows real numbers.
    try {
      await (await getAdapter("avito")).sync();
    } catch (e) {
      console.error("post-oauth sync failed for avito:", (e as Error).message);
    }
      return NextResponse.redirect(`${backTo}`);
    }
    return NextResponse.redirect(backTo);
  } catch (e) {
    console.error("avito oauth error", e);
    return NextResponse.redirect(`${errTo}?oauth=error&platform=avito`);
  }
}
