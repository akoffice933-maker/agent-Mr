-- Review (perf P1): indexes on the (organization_id, ...) filters every
-- tenant-scoped read already runs (via RLS) but had no index for. Purely
-- additive — no data/behavior change.
CREATE INDEX IF NOT EXISTS "pending_actions_org_status_idx" ON "pending_actions" ("organization_id", "status");
CREATE INDEX IF NOT EXISTS "audit_log_org_ts_idx" ON "audit_log" ("organization_id", "ts");
CREATE INDEX IF NOT EXISTS "recommendations_org_status_idx" ON "recommendations" ("organization_id", "status");
CREATE INDEX IF NOT EXISTS "campaigns_org_platform_ext_idx" ON "campaigns" ("organization_id", "platform", "external_id");
