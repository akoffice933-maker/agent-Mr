// Optional API-key auth for the REST surface (ТЗ 10, MVP-фундамент).
// Enabled only when AGENT_API_KEY env var is set — local demo runs without friction.
// Clients send the key in the `x-api-key` header.

import { NextResponse, type NextRequest } from "next/server";

export function proxy(req: NextRequest) {
  const key = process.env.AGENT_API_KEY;
  if (!key) return NextResponse.next();

  const path = req.nextUrl.pathname;
  // Health and OAuth callbacks stay open (OAuth is user-consent driven).
  if (path === "/api/health" || path.startsWith("/api/oauth/")) return NextResponse.next();

  if (req.headers.get("x-api-key") === key) return NextResponse.next();
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

export const config = { matcher: ["/api/:path*"] };
