// API proxy (formerly middleware) — auth + rate limiting (Production Hardening v1).
//
// Auth (fail-closed):
//   - AGENT_API_KEY set        → every /api route requires the `x-api-key` header
//   - key NOT set + production → 503 misconfigured (the API is intentionally unavailable)
//   - key NOT set + dev        → open (local development only)
//   - /api/health and /api/oauth/* always stay open
//
// Rate limiting (per IP, in-memory token bucket — single instance;
// for multi-instance deployments move to a shared store, e.g. Redis):
//   - read routes: 120 req/min
//   - write routes: 20 req/min

import { NextResponse, type NextRequest } from "next/server";
import { apiKeyRequired, getApiKey } from "@/lib/auth-policy";

const g = globalThis as typeof globalThis & {
  __rlBuckets?: Map<string, { tokens: number; ts: number }>;
};
const buckets: Map<string, { tokens: number; ts: number }> = g.__rlBuckets ?? (g.__rlBuckets = new Map());

const LIMITS = { read: { max: 120, perMin: true }, write: { max: 20, perMin: true } };
const REFILL = (max: number) => max / 60; // tokens per second

function bucketKey(req: NextRequest, write: boolean): string {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? req.headers.get("x-real-ip") ?? "local";
  return `${ip}:${write ? "w" : "r"}`;
}

function allow(key: string, max: number): boolean {
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: max, ts: now };
  b.tokens = Math.min(max, b.tokens + ((now - b.ts) / 1000) * REFILL(max));
  b.ts = now;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    buckets.set(key, b);
    return true;
  }
  buckets.set(key, b);
  return false;
}

function isWriteRoute(req: NextRequest): boolean {
  return req.method === "POST" || req.method === "PUT" || req.method === "DELETE";
}

export function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname;

  // Health and OAuth callbacks are always open (OAuth is user-consent driven).
  if (path === "/api/health" || path.startsWith("/api/oauth/")) {
    return NextResponse.next();
  }

  // ── auth ─────────────────────────────────────────────────────────────────
  const key = getApiKey();
  if (key) {
    if (req.headers.get("x-api-key") !== key) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  } else if (apiKeyRequired()) {
    // Fail closed: production without a key is a misconfiguration, not an open API.
    return NextResponse.json(
      {
        error: "misconfigured",
        message: "AGENT_API_KEY is not set while the app runs in production mode — the API is intentionally unavailable. Set AGENT_API_KEY (see .env.example).",
      },
      { status: 503 }
    );
  }

  // ── rate limiting ────────────────────────────────────────────────────────
  const write = isWriteRoute(req);
  const limit = LIMITS[write ? "write" : "read"].max;
  if (!allow(bucketKey(req, write), limit)) {
    return NextResponse.json(
      { error: "rate_limited", message: "Слишком много запросов — повторите через минуту." },
      { status: 429, headers: { "Retry-After": "60" } }
    );
  }

  return NextResponse.next();
}

export const config = { matcher: ["/api/:path*"] };
