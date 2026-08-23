// Tenant context extraction.
//
// SECURITY INVARIANT: the tenant (organization) is NEVER taken from request
// bodies/params. It comes exclusively from internal headers set by the proxy
// (src/proxy.ts) after authenticating the session or machine key. The proxy
// strips any client-supplied x-tenant-* headers before setting its own.

import type { TenantContext } from "./pool";
import { withTenant } from "./pool";

export const TENANT_HEADERS = {
  orgId: "x-tenant-org-id",
  userId: "x-tenant-user-id",
  role: "x-tenant-role",
} as const;

export function tenantContextFromHeaders(h: Headers): TenantContext {
  const orgId = Number(h.get(TENANT_HEADERS.orgId));
  const userIdRaw = h.get(TENANT_HEADERS.userId);
  return {
    orgId: Number.isFinite(orgId) && orgId > 0 ? orgId : 1,
    userId: userIdRaw ? Number(userIdRaw) : null,
    role: h.get(TENANT_HEADERS.role) ?? "admin",
  };
}

/** Route handlers: wrap the whole handler body. */
export function withTenantRequest<T>(req: Request, fn: (ctx: TenantContext) => Promise<T>): Promise<T> {
  return withTenant(tenantContextFromHeaders(new Headers(req.headers)), fn);
}

/** Server components: pass the result of `headers()`. */
export function withTenantHeaders<T>(h: Headers, fn: (ctx: TenantContext) => Promise<T>): Promise<T> {
  return withTenant(tenantContextFromHeaders(h), fn);
}
