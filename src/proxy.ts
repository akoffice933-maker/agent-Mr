// API proxy — the identity boundary (Phases A–C).
//
//   Authentication: session cookie (browser) OR x-api-key (machine clients)
//   Tenant context: session → user → org membership | api key → key's org
//                   (NEVER from client request bodies — see R-invariant)
//   CSRF:           mutating session-authenticated requests require X-Agent-Csrf
//   Rate limiting:  read 120/min, write 20/min, login 10/min (per IP, in-memory)
//   Fail-closed:    auth required + no key + no users → 503
//
// The proxy resolves the full TenantContext and forwards it via INTERNAL
// headers (x-tenant-*) after stripping any client-supplied copies. Downstream
// code wraps its work in withTenantRequest() which pins one RLS-bound
// connection per org (src/lib/tenant/pool.ts).

import { NextResponse, type NextRequest } from "next/server";
import { createHash } from "crypto";
import { getApiKey, isAuthRequired } from "@/lib/auth-policy";
import { identityPool } from "@/lib/tenant/pool";
import { resolveSessionContext } from "@/lib/tenant/resolve";
import { TENANT_HEADERS } from "@/lib/tenant/request";
import { getRateLimiter } from "@/lib/rate-limit";
import { COOKIE_NAME } from "@/lib/auth/sessions";
import { clientIpOf } from "@/lib/net/client-ip";
import { roleForScopes } from "@/lib/agent/scopes";
import { PUBLIC_PAGES } from "@/lib/public-routes";

const g = globalThis as typeof globalThis & {
  __userCache?: { at: number; has: boolean };
};

// Pages reachable without a session — shared with the client guard and the
// app shell so the three can never drift (src/lib/public-routes.ts).
// `/` is in that list because it is now a router, not the dashboard: it sends
// a visitor with a session to /dashboard and everyone else to /welcome.

// Cross-instance rate limiting (Phase 0.2): Redis/Upstash when REDIS_URL is
// set, in-memory token bucket otherwise (and as fail-open fallback).
async function allow(key: string, max: number): Promise<boolean> {
  const limiter = await getRateLimiter();
  const r = await limiter.check(key, max, 60_000);
  return r.ok;
}

function isWriteRoute(req: NextRequest): boolean {
  return req.method === "POST" || req.method === "PUT" || req.method === "DELETE";
}

// ── Trusted-proxy IP handling (review M1, decision: TRUSTED_PROXY) ──────────
// The implementation now lives in src/lib/net/client-ip.ts (review P3: pure,
// reusable helpers should not be trapped inside a framework convention file).
// Re-exported here so existing imports and tests keep working unchanged.
export { ipInCidr, resolveClientIp } from "@/lib/net/client-ip";

function ipOf(req: NextRequest): string {
  return clientIpOf(req);
}

const uc = g.__userCache;
async function hasAnyUser(): Promise<boolean> {
  if (uc && Date.now() - uc.at < 30_000) return uc.has;
  let has = false;
  try {
    const r = await identityPool.query("SELECT 1 FROM users LIMIT 1");
    has = (r as { rows: unknown[] }).rows.length > 0;
  } catch {
    has = false;
  }
  g.__userCache = { at: Date.now(), has };
  return has;
}

interface TenantHeaders {
  "x-tenant-org-id": string;
  "x-tenant-user-id": string | null;
  "x-tenant-role": string;
  "x-tenant-scopes": string | null;
}

// session → user → primary org membership (identity plane: no RLS there)
async function resolveSessionTenant(req: NextRequest): Promise<TenantHeaders | null> {
  const ctx = await resolveSessionContext(req).catch(() => null);
  if (!ctx) return null;
  return {
    "x-tenant-org-id": String(ctx.orgId),
    "x-tenant-user-id": ctx.userId ? String(ctx.userId) : null,
    "x-tenant-role": ctx.role,
    "x-tenant-scopes": null,
  };
}

// machine key → its org (stored keys) or the default org (env legacy key)
async function resolveKeyTenant(key: string): Promise<TenantHeaders | null> {
  const envKey = getApiKey();
  if (envKey && key === envKey) {
    return { "x-tenant-org-id": "1", "x-tenant-user-id": null, "x-tenant-role": "admin", "x-tenant-scopes": null };
  }
  const hash = createHash("sha256").update(key).digest("hex");
  // Only active (non-revoked, non-expired) keys resolve; raw key is never
  // matched or stored — only its sha256 hash.
  const r = await identityPool.query(
    "SELECT org_id, scopes FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) LIMIT 1",
    [hash]
  );
  const row = (r as { rows: { org_id: number; scopes: string[] | null }[] }).rows[0];
  if (!row) return null;
  await identityPool.query("UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1", [hash]);
  // Review P2: the role is DERIVED from the key's scopes instead of a blanket
  // "admin". A read-only key must not satisfy a role check that a scope check
  // would have rejected — see roleForScopes().
  return {
    "x-tenant-org-id": String(row.org_id),
    "x-tenant-user-id": null,
    "x-tenant-role": roleForScopes(row.scopes),
    "x-tenant-scopes": row.scopes ? JSON.stringify(row.scopes) : null,
  };
}

/**
 * Strip every client-supplied x-tenant-* header.
 *
 * SECURITY (review P0): these headers are an INTERNAL channel — the proxy sets
 * them after authenticating the caller. A client must never be able to inject
 * them, so they are removed as the very first action, before any early return
 * (health, OAuth) and regardless of auth mode. Pages additionally no longer
 * trust them at all (see src/lib/auth/dal.ts) — this is defense in depth.
 */
function stripTenantHeaders(req: NextRequest): Headers {
  const clean = new Headers(req.headers);
  for (const h of Object.values(TENANT_HEADERS)) clean.delete(h);
  return clean;
}

export async function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname;

  // Sanitize FIRST: no code path may forward client-supplied tenant headers.
  const sanitized = stripTenantHeaders(req);
  const passThrough = () => NextResponse.next({ request: { headers: sanitized } });

  // Non-API routes (pages, RSC payloads). The authorization boundary for them
  // is the DAL (src/lib/auth/dal.ts) — it resolves identity from the session
  // cookie and redirects when there is none. Here we additionally:
  //   1. guarantee forged x-tenant-* headers never reach the render;
  //   2. short-circuit anonymous requests with an honest 307 instead of
  //      rendering a full RSC payload that only carries a redirect.
  if (!path.startsWith("/api/")) {
    if (isAuthRequired() && !PUBLIC_PAGES.has(path)) {
      const sid = req.cookies.get(COOKIE_NAME)?.value;
      if (!sid || !/^[a-f0-9]{64}$/.test(sid)) {
        const to = new URL("/login", req.url);
        if (path !== "/") to.searchParams.set("next", path);
        return NextResponse.redirect(to, 307);
      }
    }
    return passThrough();
  }

  // Always-open routes.
  //
  // Billing webhooks are called by Stripe/ЮKassa, which have no session and no
  // API key. They are NOT unauthenticated in effect: the Stripe handler
  // verifies an HMAC signature over the raw body, and the ЮKassa handler
  // re-reads the payment from the provider API before granting anything.
  // `/api/public/*` serves compile-time constants (plan prices and limits) and
  // touches neither the database nor tenant data — see app/api/public/plans.
  if (
    path === "/api/health" ||
    path.startsWith("/api/public/") ||
    path.startsWith("/api/oauth/") ||
    path.startsWith("/api/billing/webhook/")
  ) {
    return passThrough();
  }

  const authRequired = isAuthRequired();
  const ip = ipOf(req);

  // Signup and email verification: reachable without a session by definition
  // (the account does not exist yet), so per-IP limits are the abuse control.
  // Signup is the stricter of the two — each accepted request creates a user,
  // an organization and sends an email.
  if (path.startsWith("/api/auth/signup")) {
    if (req.method === "POST" && !(await allow(`${ip}:signup`, 5))) {
      return NextResponse.json(
        { error: "rate_limited", reason: "Слишком много попыток регистрации. Попробуйте через минуту." },
        { status: 429, headers: { "Retry-After": "60" } }
      );
    }
    return passThrough();
  }
  if (path.startsWith("/api/auth/verify")) {
    // Also guards token guessing: a verification token is 32 random bytes, and
    // 20 tries/minute makes brute force hopeless rather than merely slow.
    if (!(await allow(`${ip}:verify`, 20))) {
      return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": "60" } });
    }
    return passThrough();
  }

  // Login endpoint: open (when auth is required) but brute-force limited.
  if (path.startsWith("/api/auth/login")) {
    if (authRequired) {
      if (!(await hasAnyUser())) {
        return NextResponse.json(
          { error: "misconfigured", message: "No users registered. Create one: npm run create-user <email> <password>" },
          { status: 503 }
        );
      }
      if (!(await allow(`${ip}:login`, 10))) {
        return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": "60" } });
      }
    }
    return passThrough();
  }

  let tenant: TenantHeaders;

  if (authRequired) {
    const key = getApiKey();
    const provided = req.headers.get("x-api-key");

    if (provided) {
      // Machine clients (MCP / Telegram / scripts).
      const t = key || provided ? await resolveKeyTenant(provided).catch(() => null) : null;
      if (!t) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
      tenant = t;
    } else {
      // Browser: server-side session → user → org.
      const t = await resolveSessionTenant(req).catch(() => null);
      if (!t) return NextResponse.json({ error: "unauthorized", message: "Login required" }, { status: 401 });
      // CSRF: mutating requests authenticated by cookie must carry the header.
      if (isWriteRoute(req) && req.headers.get("x-agent-csrf") !== "1") {
        return NextResponse.json({ error: "csrf", message: "Missing X-Agent-Csrf header" }, { status: 403 });
      }
      tenant = t;
    }

    // Fail-closed: no key configured and no users → misconfiguration.
    if (!key && !(await hasAnyUser())) {
      return NextResponse.json(
        { error: "misconfigured", message: "Auth is required but no AGENT_API_KEY and no users exist." },
        { status: 503 }
      );
    }
  } else {
    // Development / sandbox mode: single default tenant.
    tenant = { "x-tenant-org-id": "1", "x-tenant-user-id": null, "x-tenant-role": "admin", "x-tenant-scopes": null };
  }

  // Capability boundary for machine keys. Agent requests are checked by the
  // Policy Engine because the required capability depends on the tool.
  // Ordinary API reads require `read`; direct write routes use route guards.
  if (tenant["x-tenant-scopes"]) {
    let scopes: string[] = [];
    try { scopes = JSON.parse(tenant["x-tenant-scopes"]) as string[]; } catch { scopes = []; }
    if (!scopes.includes("read") && !isWriteRoute(req)) {
      return NextResponse.json({ error: "forbidden", reason: "API key не имеет scope: read" }, { status: 403 });
    }
  }

  // General rate limits (applies in all modes). Per-IP first (existing
  // behavior, unchanged), then an additive per-org cap (review M2 P2): a
  // single tenant sharing an IP with others (corporate NAT, VPN exit node)
  // must not be able to exhaust everyone else's per-IP bucket, and a tenant
  // rotating across many IPs must not bypass a ceiling on its own total
  // usage. Same limit values as the per-IP check for now — a fleet with
  // many concurrent users per org may want a separate, higher org ceiling;
  // tune independently once real traffic shape is known.
  const write = isWriteRoute(req);
  const limit = write ? 20 : 120;
  if (!(await allow(`${ip}:${write ? "w" : "r"}`, limit))) {
    return NextResponse.json(
      { error: "rate_limited", message: "Слишком много запросов — повторите через минуту." },
      { status: 429, headers: { "Retry-After": "60" } }
    );
  }
  if (!(await allow(`org:${tenant["x-tenant-org-id"]}:${write ? "w" : "r"}`, limit))) {
    return NextResponse.json(
      { error: "rate_limited", message: "Слишком много запросов от вашей организации — повторите через минуту." },
      { status: 429, headers: { "Retry-After": "60" } }
    );
  }

  // Forward the tenant via INTERNAL headers. `sanitized` already had every
  // client-supplied copy removed at the top of this function.
  const headers = sanitized;
  headers.set(TENANT_HEADERS.orgId, tenant["x-tenant-org-id"]);
  if (tenant["x-tenant-user-id"]) headers.set(TENANT_HEADERS.userId, tenant["x-tenant-user-id"]);
  headers.set(TENANT_HEADERS.role, tenant["x-tenant-role"]);
  if (tenant["x-tenant-scopes"]) headers.set(TENANT_HEADERS.scopes, tenant["x-tenant-scopes"]);

  return NextResponse.next({ request: { headers } });
}

// Matcher now covers PAGES too (review P0): previously "/api/:path*" meant the
// proxy never ran for server-rendered routes, so client-supplied x-tenant-*
// headers reached them untouched. Pages are authorized by the DAL, but the
// proxy still strips forged tenant headers for them — defense in depth.
//
// Static assets and Next internals are excluded: they carry no tenant data and
// running the proxy for every chunk would add pointless latency.
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|mp4|webm|css|js|map|woff|woff2|ttf)$).*)",
  ],
};
