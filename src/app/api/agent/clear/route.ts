import { NextResponse } from "next/server";
import { db } from "@/db";
import { messages } from "@/db/schema";

export const dynamic = "force-dynamic";

export async function POST() {
  await db.delete(messages);
  await db.insert(messages).values({
    role: "agent",
    content:
      "История очищена. Я готов к работе — напишите команду, например: «Покажи расходы по всем площадкам за последние 7 дней».",
    meta: null,
  });
  return NextResponse.json({ ok: true });
}
