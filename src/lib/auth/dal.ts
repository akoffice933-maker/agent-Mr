// Data Access Layer (DAL) — the security boundary for React Server Components.
//
// WHY THIS EXISTS (review P0, 30.08.2026)
// ---------------------------------------
// Server components used to derive the tenant from the `x-tenant-*` request
// headers, exactly like API routes do. That was a critical vulnerability:
//
//   * the proxy (src/proxy.ts) is what authenticates the caller and STRIPS any
//     client-supplied x-tenant-* headers — but its matcher only covered
//     "/api/:path*";
//   * pages are not API routes, so the proxy never ran for them, and the
//     header arrived from the client untouched;
//   * `curl -H "x-tenant-org-id: 2" /campaigns` therefore rendered another
//     organization's data with no session at all.
//
// Every defense-in-depth layer behaved "correctly" and still leaked: RLS
// faithfully returned rows for the org it was told about, RBAC faithfully
// applied the role it was handed. The trust entered from OUTSIDE the perimeter.
//
// THE FIX: pages never read headers for identity. They call getTenantContext(),
// which resolves the tenant from the HttpOnly session cookie and verifies it
// against the database. A cookie cannot be forged by an attacker the way an
// arbitrary header can (it is HttpOnly, and the session id must exist, be
// unrevoked and unexpired in `sessions`).
//
// The proxy remains a useful early gate (fast 401s, rate limiting, tenant
// headers for API routes) but it is NO LONGER the only thing standing between
// an anonymous request and tenant data.
//
// Next.js 16 renamed `middleware.ts` to `proxy.ts` for precisely this reason:
// that layer is a network boundary, not an authorization boundary.

import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { isAuthRequired } from "@/lib/auth-policy";
import { identityPool, withTenant, type TenantContext } from "@/lib/tenant/pool";
import { COOKIE_NAME } from "@/lib/auth/sessions";

/**
 * Resolve the tenant for the current server-rendered request from the session
 * cookie. Returns null when there is no valid session.
 *
 * `cache()` dedupes the DB lookup across all components of a single render
 * pass, so a page with several server components pays for one query.
 */
export const getTenantContextOrNull = cache(async (): Promise<TenantContext | null> => {
  const h = await headers();
  const raw = h.get("cookie") ?? "";
  let sid: string | undefined;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE_NAME) {
      sid = v.join("=");
      break;
    }
  }

  if (sid && /^[a-f0-9]{64}$/.test(sid)) {
    const r = await identityPool.query(
      `SELECT u.id AS user_id, m.org_id, m.role
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         JOIN LATERAL (
           SELECT org_id, role FROM org_members WHERE user_id = s.user_id ORDER BY created_at LIMIT 1
         ) m ON true
        WHERE s.id = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
      [sid]
    );
    const row = (r as { rows: { user_id: number; org_id: number; role: string }[] }).rows[0];
    if (row) return { orgId: row.org_id, userId: row.user_id, role: row.role };
  }

  // Auth-off (local dev / sandbox demo): a single default tenant, exactly as
  // the proxy does for API routes. In production this path is unreachable.
  if (!isAuthRequired()) return { orgId: 1, userId: null, role: "admin" };

  return null;
});

/**
 * Tenant for a protected page. Redirects to /login when unauthenticated —
 * pages must never render tenant data without a verified session.
 */
export async function getTenantContext(): Promise<TenantContext> {
  const ctx = await getTenantContextOrNull();
  if (!ctx) redirect("/login");
  return ctx;
}

/**
 * Page-level replacement for the old `withTenantHeaders(await headers(), fn)`.
 *
 * Identity comes from the session cookie (verified against the DB), never from
 * request headers. The callback then runs inside the RLS-bound tenant
 * transaction, exactly like API routes do via withTenantRequest().
 */
export async function withTenantPage<T>(fn: (ctx: TenantContext) => Promise<T>): Promise<T> {
  const ctx = await getTenantContext();
  return withTenant(ctx, fn);
}
