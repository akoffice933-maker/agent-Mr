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
import { rawDbPool } from "@/lib/tenant/pool";
import { resolveSessionContext } from "@/lib/tenant/resolve";
import { TENANT_HEADERS } from "@/lib/tenant/request";

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
    const r = await rawDbPool.query("SELECT 1 FROM users LIMIT 1");
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
}

// session → user → primary org membership (identity plane: no RLS there)
async function resolveSessionTenant(req: NextRequest): Promise<TenantHeaders | null> {
  const ctx = await resolveSessionContext(req).catch(() => null);
  if (!ctx) return null;
  return {
    "x-tenant-org-id": String(ctx.orgId),
    "x-tenant-user-id": ctx.userId ? String(ctx.userId) : null,
    "x-tenant-role": ctx.role,
  };
}

// machine key → its org (stored keys) or the default org (env legacy key)
async function resolveKeyTenant(key: string): Promise<TenantHeaders | null> {
  const envKey = getApiKey();
  if (envKey && key === envKey) {
    return { "x-tenant-org-id": "1", "x-tenant-user-id": null, "x-tenant-role": "admin" };
  }
  const hash = createHash("sha256").update(key).digest("hex");
  const r = await rawDbPool.query("SELECT org_id FROM api_keys WHERE key_hash = $1 LIMIT 1", [hash]);
  const row = (r as { rows: { org_id: number }[] }).rows[0];
  if (!row) return null;
  await rawDbPool.query("UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1", [hash]);
  return { "x-tenant-org-id": String(row.org_id), "x-tenant-user-id": null, "x-tenant-role": "admin" };
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
    tenant = { "x-tenant-org-id": "1", "x-tenant-user-id": null, "x-tenant-role": "admin" };
  }

  // General rate limits (applies in all modes).
  const write = isWriteRoute(req);
  const limit = write ? 20 : 120;
  if (!allow(`${ip}:${write ? "w" : "r"}`, limit)) {
    return NextResponse.json(
      { error: "rate_limited", message: "Слишком много запросов — повторите через минуту." },
      { status: 429, headers: { "Retry-After": "60" } }
    );
  }

  // Forward the tenant via INTERNAL headers; strip any client-supplied copies.
  const headers = new Headers(req.headers);
  headers.delete(TENANT_HEADERS.orgId);
  headers.delete(TENANT_HEADERS.userId);
  headers.delete(TENANT_HEADERS.role);
  headers.set(TENANT_HEADERS.orgId, tenant["x-tenant-org-id"]);
  if (tenant["x-tenant-user-id"]) headers.set(TENANT_HEADERS.userId, tenant["x-tenant-user-id"]);
  headers.set(TENANT_HEADERS.role, tenant["x-tenant-role"]);

  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: ["/api/:path*"] };
