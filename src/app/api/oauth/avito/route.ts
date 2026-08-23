import { NextResponse } from "next/server";
import { avitoFetchToken } from "@/lib/adapters/avito/client";
import { setAccountMode } from "@/lib/adapters/oauth-store";

export const dynamic = "force-dynamic";

// Avito Business API uses OAuth2 client_credentials (no user consent screen):
// GET /api/oauth/avito?start=1 → fetch token directly, store, mark production.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const backTo = `${process.env.PUBLIC_URL ?? new URL(req.url).origin}/safety`;
  try {
    if (url.searchParams.get("start")) {
      await avitoFetchToken();
      await setAccountMode("avito", "production");
      return NextResponse.redirect(`${backTo}?oauth=ok&platform=avito`);
    }
    return NextResponse.redirect(backTo);
  } catch (e) {
    console.error("avito oauth error", e);
    return NextResponse.redirect(`${backTo}?oauth=error&platform=avito`);
  }
}
