// API proxy — the identity boundary (Production Hardening v1, Phases A–B).
//
//   Authentication: session cookie (browser) OR x-api-key (machine clients)
//   CSRF:           mutating session-authenticated requests require X-Agent-Csrf
//   Rate limiting:  read 120/min, write 20/min, login 10/min (per IP, in-memory;
//                   move to a shared store for multi-instance deployments)
//   Fail-closed:    auth required + no API key + no registered users → 503
//
// Open routes: /api/health, /api/oauth/* (user-consent flows), /api/auth/login.
//
// Note: Next.js 16 proxy always runs on the Node.js runtime (DB access OK).

import { NextResponse, type NextRequest } from "next/server";
import { getApiKey, isAuthRequired } from "@/lib/auth-policy";
import { readSessionCookie } from "@/lib/auth/cookies";
import { countUsers, validateSession } from "@/lib/auth/sessions";

const g = globalThis as typeof globalThis & {
  __rlBuckets?: Map<string, { tokens: number; ts: number }>;
  __userCache?: { at: number; has: boolean };
};
const buckets: Map<string, { tokens: number; ts: number }> = g.__rlBuckets ?? (g.__rlBuckets = new Map());

function isWriteRoute(req: NextRequest): boolean {
  return req.method === "POST" || req.method === "PUT" || req.method === "DELETE";
}

function ipOf(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? req.headers.get("x-real-ip") ?? "local";
}

function allow(key: string, max: number): boolean {
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: max, ts: now };
  b.tokens = Math.min(max, b.tokens + ((now - b.ts) / 1000) * (max / 60));
  b.ts = now;
  const ok = b.tokens >= 1;
  if (ok) b.tokens -= 1;
  buckets.set(key, b);
  return ok;
}

const uc = g.__userCache;
async function hasAnyUser(): Promise<boolean> {
  if (uc && Date.now() - uc.at < 30_000) return uc.has;
  let has = false;
  try {
    has = (await countUsers()) > 0;
  } catch {
    has = false;
  }
  g.__userCache = { at: Date.now(), has };
  return has;
}

export async function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname;

  // Always-open routes.
  if (path === "/api/health" || path.startsWith("/api/oauth/")) {
    return NextResponse.next();
  }

  const authRequired = isAuthRequired();
  const ip = ipOf(req);

  // Login endpoint: open (when auth is required) but brute-force limited.
  if (path.startsWith("/api/auth/login")) {
    if (authRequired) {
      if (!(await hasAnyUser())) {
        return NextResponse.json(
          { error: "misconfigured", message: "No users registered. Create one: npm run create-user <email> <password>" },
          { status: 503 }
        );
      }
      if (!allow(`${ip}:login`, 10)) {
        return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": "60" } });
      }
    }
    return NextResponse.next();
  }

  if (authRequired) {
    const key = getApiKey();

    // 1. Machine clients (MCP / Telegram / scripts): x-api-key.
    const provided = req.headers.get("x-api-key");
    if (provided) {
      if (!key || provided !== key) {
        return NextResponse.json({ error: "unauthorized" }, { status: 401 });
      }
      // key-authenticated requests pass (no CSRF for non-cookie auth)
    } else {
      // 2. Browser: server-side session in an HttpOnly cookie.
      const session = await validateSession(readSessionCookie(req)).catch(() => null);
      if (!session) {
        return NextResponse.json({ error: "unauthorized", message: "Login required" }, { status: 401 });
      }
      // CSRF: mutating requests authenticated by cookie must carry the header.
      if (isWriteRoute(req) && req.headers.get("x-agent-csrf") !== "1") {
        return NextResponse.json({ error: "csrf", message: "Missing X-Agent-Csrf header" }, { status: 403 });
      }
    }

    // 3. Fail-closed: no key configured and no users → misconfiguration.
    if (!key && !(await hasAnyUser())) {
      return NextResponse.json(
        { error: "misconfigured", message: "Auth is required but no AGENT_API_KEY and no users exist." },
        { status: 503 }
      );
    }
  }

  // General rate limits (applies in all modes).
  const write = isWriteRoute(req);
  const limit = write ? 20 : 120;
  if (!allow(`${ip}:${write ? "w" : "r"}`, limit)) {
    return NextResponse.json({ error: "rate_limited", message: "Слишком много запросов — повторите через минуту." }, { status: 429, headers: { "Retry-After": "60" } });
  }

  return NextResponse.next();
}

export const config = { matcher: ["/api/:path*"] };
