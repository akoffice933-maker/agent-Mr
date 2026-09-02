import { NextResponse } from "next/server";
import { getSettings, updateSettings, writeAudit } from "@/lib/agent/safety";
import { accountMode, deleteToken, hasToken, setAccountMode, tokenState } from "@/lib/adapters/oauth-store";
import type { Platform } from "@/lib/agent/types";
import { withTenantRequest } from "@/lib/tenant/request";
import { tenantOrgId } from "@/lib/tenant/pool";
import { requireAction } from "@/lib/tenant/route-authz";
import { canConnectPlatform } from "@/lib/billing/quota";
import { log } from "@/lib/log";

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
      // Решение по лимиту тарифа отдаём вместе со списком площадок (ТЗ §5.2
      // п.9): экран подключения обязан объяснить, ПОЧЕМУ следующая площадка
      // недоступна, и сделать это текстом сервера (quota.ts), а не своим.
      const platforms = (["google", "yandex", "avito"] as Platform[]).map(async (p) => {
        const quota = await canConnectPlatform(tenantOrgId(), p);
        return {
          platform: p,
          mode: await accountMode(p),
          token: await hasToken(tenantOrgId(), p),
          // Строка в таблице ≠ работающий доступ: протухший токен без
          // refresh_token выглядел в интерфейсе как «токен сохранён».
          tokenState: await tokenState(tenantOrgId(), p),
          configured: platformConfigured(p),
          canConnect: quota.allowed,
          blockedReason: quota.allowed ? null : (quota.reason ?? null),
        };
      });
      return NextResponse.json({ ...s, platforms: await Promise.all(platforms) });
    });
  } catch (e) {
    log.error("settings request failed", {}, e);
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    return await withTenantRequest(req, async () => {
      const body = await req.json();
      // Отзыв доступа к рекламному кабинету. До этого удалить сохранённый
      // токен было нельзя ничем, кроме прямого доступа к базе, — а политика
      // конфиденциальности обещает пользователю возможность отзыва.
      if (typeof body.platform === "string" && ["google", "yandex", "avito"].includes(body.platform) && body.disconnect === true) {
        const denied = requireAction(req, "credentials");
        if (denied) return denied;
        const platform = body.platform as Platform;
        const removed = await deleteToken(tenantOrgId(), platform);
        // Площадка без токена не может работать в production: оставить режим
        // как есть значило бы обещать реальный API там, где ходить уже нечем.
        if (removed) {
          await setAccountMode(platform, "sandbox");
          await writeAudit({
            actor: "ui",
            tool: "disconnect_platform",
            params: { platform },
            platforms: [platform],
            dryRun: false,
            status: "applied",
            summary: `Доступ к площадке ${platform} отозван, токен удалён`,
          });
        }
        return NextResponse.json({ ok: true, platform, removed });
      }
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
    log.error("settings request failed", {}, e);
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
