// Re-export the tenant-aware pool (Phase C). All app code imports `db` from
// here; the pool pins one RLS-bound connection per tenant context.
export { db, identityPool, withTenant, currentTenant, tenantOrgId } from "@/lib/tenant/pool";
export type { TenantContext } from "@/lib/tenant/pool";
