import { NextResponse } from "next/server";
import { getSettings, updateSettings, writeAudit } from "@/lib/agent/safety";

export const dynamic = "force-dynamic";

export async function GET() {
  const s = await getSettings();
  return NextResponse.json(s);
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
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
  } catch (e) {
    console.error("settings error", e);
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
