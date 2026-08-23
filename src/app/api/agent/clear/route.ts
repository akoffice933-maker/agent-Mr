import { NextResponse } from "next/server";
import { db } from "@/db";
import { messages } from "@/db/schema";
import { withTenantRequest } from "@/lib/tenant/request";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    return await withTenantRequest(req, async (ctx) => {
      await db.delete(messages);
      await db.insert(messages).values({
        organizationId: ctx.orgId,
        role: "agent",
        content:
          "История очищена. Я готов к работе — напишите команду, например: «Покажи расходы по всем площадкам за последние 7 дней».",
        meta: null,
      });
      return NextResponse.json({ ok: true });
    });
  } catch (e) {
    console.error("clear error", e);
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
