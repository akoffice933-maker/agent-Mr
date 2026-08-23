import { NextResponse } from "next/server";
import { avitoFetchToken } from "@/lib/adapters/avito/client";
import { setAccountMode } from "@/lib/adapters/oauth-store";
import { getAdapter } from "@/lib/adapters";
import { withTenant } from "@/lib/tenant/pool";
import { resolveRequestContext } from "@/lib/tenant/resolve";
import type { TenantContext } from "@/lib/tenant/pool";

export const dynamic = "force-dynamic";

// Avito Business API uses client_credentials (no consent screen):
// GET /api/oauth/avito?start=1 → fetch token in the caller's tenant context.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const origin = process.env.PUBLIC_URL ?? new URL(req.url).origin;
  const backTo = `${origin}/agent?onboard=avito`;
  const errTo = `${origin}/safety`;
  try {
    if (url.searchParams.get("start")) {
      const ctx = (await resolveRequestContext(req)) as TenantContext | null;
      if (!ctx) return NextResponse.redirect(`${errTo}?oauth=error&platform=avito`);
      return await withTenant(ctx, async () => {
        await avitoFetchToken();
        await setAccountMode("avito", "production");
        try {
          await (await getAdapter("avito")).sync();
        } catch (e) {
          console.error("post-oauth sync failed (avito):", (e as Error).message);
        }
        return NextResponse.redirect(backTo);
      });
    }
    return NextResponse.redirect(backTo);
  } catch (e) {
    console.error("avito oauth error", e);
    return NextResponse.redirect(`${errTo}?oauth=error&platform=avito`);
  }
}
