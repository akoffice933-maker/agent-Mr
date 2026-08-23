import { NextResponse } from "next/server";
import { getChatHistory } from "@/lib/agent/run";

export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await getChatHistory();
  return NextResponse.json({ messages: rows });
}
