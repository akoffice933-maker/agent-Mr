import { NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { db } from "@/db";
import { pendingActions } from "@/db/schema";

export const dynamic = "force-dynamic";

// GET /api/agent/pending — actions awaiting confirmation (MCP/Telegram clients, ТЗ US-7).
export async function GET() {
  const rows = await db.select().from(pendingActions).orderBy(desc(pendingActions.id)).limit(20);
  const items = rows
    .filter((r) => r.status === "pending")
    .map((r) => ({
      id: r.id,
      tool: r.tool,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      costDaily: r.costDaily,
      preview: r.preview,
    }));
  return NextResponse.json({ items });
}
