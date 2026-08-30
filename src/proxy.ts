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

const g = globalThis as typeof globalThis & {
  __userCache?: { at: number; has: boolean };
};

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
// Rate limiting and login lockout key on the client IP. Previously ipOf()
// blindly trusted the FIRST entry of X-Forwarded-For — a client could spoof it
// (or the header entirely) to rotate IPs and bypass the limits. Now we only
// trust XFF when it demonstrably comes from a configured reverse proxy.
//
// Deployment note: put the app behind a proxy that APPENDS its own address
// as the last X-Forwarded-For hop (not a bare overwrite — that yields a
// single hop, which this code never trusts by design; see .env.example for
// the exact nginx directive), list that proxy (and/or its CIDR) in
// TRUSTED_PROXY, and do not expose the app directly.

/** Parse an IPv4 "a.b.c.d" to a 32-bit unsigned integer, or null. */
function ipv4ToLong(ip: string): number | null {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/** Whether `ip` is inside an IPv4 CIDR (`a.b.c.d/nn`) or exactly matches it. */
export function ipInCidr(ip: string, cidr: string): boolean {
  const [base, bitsStr] = cidr.split("/");
  const bits = bitsStr ? Number(bitsStr) : 32;
  const ipNum = ipv4ToLong(ip);
  const baseNum = ipv4ToLong(base);
  if (ipNum === null || baseNum === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((ipNum & mask) >>> 0) === ((baseNum & mask) >>> 0);
}

/**
 * Decide the client IP for rate limiting / brute-force lockout. Pure & tested.
 *
 * @param headers a minimal {get(name)} of the request headers
 * @param trusted configured trusted proxies (or empty)
 */
export function resolveClientIp(
  headers: Pick<Headers, "get">,
  trusted: string[] = []
): string {
  const xff = headers.get("x-forwarded-for");
  const xRealIp = headers.get("x-real-ip");
  if (trusted.length) {
    if (xff) {
      const hops = xff.split(",").map((s) => s.trim()).filter(Boolean);
      // XFF is appended by each proxy, so the LAST hop is the one that
      // connected directly to us. If it is a trusted proxy, the FIRST hop is
      // the original client. Require >1 hop so a direct client cannot simply
      // claim a trusted proxy as its own address.
      if (hops.length >= 2) {
        const lastHop = hops[hops.length - 1];
        if (trusted.some((p) => ipInCidr(lastHop, p))) {
          return hops[0];
        }
      }
    }
    // Not provably behind a trusted proxy: do not read XFF at all.
    return xRealIp ?? "untrusted";
  }
  // No TRUSTED_PROXY configured (dev / sandbox): best effort, documented as
  // not trust-safe. Deployments that expose the app publicly should set it.
  return xff?.split(",")[0]?.trim() ?? xRealIp ?? "local";
}

function trustedProxies(): string[] {
  const raw = process.env.TRUSTED_PROXY ?? "";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function ipOf(req: NextRequest): string {
  return resolveClientIp(req.headers, trustedProxies());
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
  return { "x-tenant-org-id": String(row.org_id), "x-tenant-user-id": null, "x-tenant-role": "admin", "x-tenant-scopes": row.scopes ? JSON.stringify(row.scopes) : null };
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
      if (!(await allow(`${ip}:login`, 10))) {
        return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": "60" } });
      }
    }
    return NextResponse.next();
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

  // Forward the tenant via INTERNAL headers; strip any client-supplied copies.
  const headers = new Headers(req.headers);
  headers.delete(TENANT_HEADERS.orgId);
  headers.delete(TENANT_HEADERS.userId);
  headers.delete(TENANT_HEADERS.role);
  headers.delete(TENANT_HEADERS.scopes);
  headers.set(TENANT_HEADERS.orgId, tenant["x-tenant-org-id"]);
  if (tenant["x-tenant-user-id"]) headers.set(TENANT_HEADERS.userId, tenant["x-tenant-user-id"]);
  headers.set(TENANT_HEADERS.role, tenant["x-tenant-role"]);
  if (tenant["x-tenant-scopes"]) headers.set(TENANT_HEADERS.scopes, tenant["x-tenant-scopes"]);

  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: ["/api/:path*"] };
