import { NextResponse } from "next/server";
import { resolvePending } from "@/lib/agent/run";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { id?: number; decision?: string };
    if (!body.id || (body.decision !== "approve" && body.decision !== "reject")) {
      return NextResponse.json({ error: "bad request" }, { status: 400 });
    }
    const agent = await resolvePending(body.id, body.decision, "chat");
    return NextResponse.json({ agent });
  } catch (e) {
    console.error("action error", e);
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
