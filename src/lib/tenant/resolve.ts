// Tenant context resolution from an incoming request (identity plane).
// Used by the proxy (all /api routes) and by the OAuth callbacks (which are
// outside the proxy's auth block but still need the caller's org).

import { isAuthRequired } from "@/lib/auth-policy";
import { readSessionCookie } from "@/lib/auth/cookies";
import { rawDbPool, type TenantContext } from "./pool";

export async function resolveSessionContext(req: Request): Promise<TenantContext | null> {
  const sid = readSessionCookie(req);
  if (!sid) return null;
  const r = await rawDbPool.query(
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
  if (!row) return null;
  return { orgId: row.org_id, userId: row.user_id, role: row.role };
}

/**
 * Context for any request: session → org; in auth-off (dev/sandbox) mode the
 * default org. Returns null when auth is required and there is no valid
 * session (caller must deny).
 */
export async function resolveRequestContext(req: Request): Promise<TenantContext | null> {
  const ctx = await resolveSessionContext(req).catch(() => null);
  if (ctx) return ctx;
  return isAuthRequired() ? null : { orgId: 1, userId: null, role: "admin" };
}
