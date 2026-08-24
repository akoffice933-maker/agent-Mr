import { NextResponse } from "next/server";
import { getSettings, updateSettings, writeAudit } from "@/lib/agent/safety";
import { accountMode, hasToken, setAccountMode } from "@/lib/adapters/oauth-store";
import type { Platform } from "@/lib/agent/types";
import { withTenantRequest } from "@/lib/tenant/request";
import { currentTenant } from "@/lib/tenant/pool";
import { requireAction } from "@/lib/tenant/route-authz";

export const dynamic = "force-dynamic";

/** Whether the OAuth env vars for a platform are configured (start URL available). */
function platformConfigured(p: Platform): boolean {
  switch (p) {
    case "google":
      return Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_ADS_DEVELOPER_TOKEN);
    case "yandex":
      return Boolean(process.env.YANDEX_OAUTH_CLIENT_ID && process.env.YANDEX_OAUTH_CLIENT_SECRET);
    case "avito":
      return Boolean(process.env.AVITO_CLIENT_ID && process.env.AVITO_CLIENT_SECRET);
  }
}

// Tenant-scoped: settings and account modes belong to the caller's organization (RLS).
export async function GET(req: Request) {
  try {
    return await withTenantRequest(req, async () => {
      const s = await getSettings();
      const platforms = (["google", "yandex", "avito"] as Platform[]).map(async (p) => ({
        platform: p,
        mode: await accountMode(p),
        token: await hasToken(currentTenant()?.orgId ?? 1, p),
        configured: platformConfigured(p),
      }));
      return NextResponse.json({ ...s, platforms: await Promise.all(platforms) });
    });
  } catch (e) {
    console.error("settings error", e);
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    return await withTenantRequest(req, async () => {
      const body = await req.json();
      // Switch an account back to sandbox (or production) mode from the UI.
      if (typeof body.platform === "string" && ["google", "yandex", "avito"].includes(body.platform) && ["sandbox", "production"].includes(body.mode)) {
        const denied = requireAction(req, "credentials");
        if (denied) return denied;
        await setAccountMode(body.platform as Platform, body.mode as "sandbox" | "production");
        await writeAudit({
          actor: "ui",
          tool: "set_platform_mode",
          params: body,
          platforms: [body.platform],
          dryRun: false,
          status: "applied",
          summary: `Режим площадки ${body.platform}: ${body.mode}`,
        });
        return NextResponse.json({ ok: true, platform: body.platform, mode: body.mode });
      }
      const denied = requireAction(req, "policy");
      if (denied) return denied;
      const s = await updateSettings({
        dryRun: typeof body.dryRun === "boolean" ? body.dryRun : undefined,
        readOnly: typeof body.readOnly === "boolean" ? body.readOnly : undefined,
        dailyLimit: typeof body.dailyLimit === "number" ? body.dailyLimit : undefined,
        weeklyLimit: typeof body.weeklyLimit === "number" ? body.weeklyLimit : undefined,
        monthlyLimit: typeof body.monthlyLimit === "number" ? body.monthlyLimit : undefined,
        confirmBudget: typeof body.confirmBudget === "boolean" ? body.confirmBudget : undefined,
      });
      await writeAudit({
        actor: "ui",
        tool: "update_settings",
        params: body,
        platforms: [],
        dryRun: false,
        status: "applied",
        summary: `Изменены настройки безопасности: ${Object.keys(body).join(", ")}`,
      });
      return NextResponse.json(s);
    });
  } catch (e) {
    console.error("settings error", e);
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
