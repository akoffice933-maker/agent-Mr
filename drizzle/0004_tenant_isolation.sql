-- 0004: tenant isolation (Phase C)
-- Order matters: default org → backfill → NOT NULL → RLS.
-- After this migration every app query runs with RLS enabled (FORCE: the
-- app role is subject even as table owner). The app binds `app.org_id`
-- per request (src/lib/tenant/pool.ts); without a context the policy
-- matches nothing → 0 rows (fail-closed).

-- 1. Default organization (migrates all pre-existing data + single-tenant dev)
INSERT INTO organizations (name) VALUES ('Default');

-- 2. Backfill existing rows into the default organization
UPDATE accounts SET organization_id = 1 WHERE organization_id IS NULL;
UPDATE campaigns SET organization_id = 1 WHERE organization_id IS NULL;
UPDATE audit_log SET organization_id = 1 WHERE organization_id IS NULL;
UPDATE chat_messages SET organization_id = 1 WHERE organization_id IS NULL;
UPDATE oauth_tokens SET organization_id = 1 WHERE organization_id IS NULL;
UPDATE pending_actions SET organization_id = 1 WHERE organization_id IS NULL;
UPDATE recommendations SET organization_id = 1 WHERE organization_id IS NULL;
UPDATE settings SET organization_id = 1 WHERE organization_id IS NULL;

-- 3. Structural invariant: organization_id can never be NULL again
ALTER TABLE accounts ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE campaigns ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE audit_log ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE chat_messages ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE oauth_tokens ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE pending_actions ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE recommendations ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE settings ALTER COLUMN organization_id SET NOT NULL;

-- 4. Tenant context accessor. current_setting(..., true) → NULL when unset,
--    so an unbound connection sees nothing (fail-closed).
CREATE OR REPLACE FUNCTION public.tenant_org_id() RETURNS integer AS $$
  SELECT NULLIF(current_setting('app.org_id', true), '')::int
$$ LANGUAGE sql STABLE;

-- 5. Row Level Security — tenant isolation enforced by the database itself.
--    FORCE makes the policy apply to the table owner (the app role) as well.
--    Identity/credential plane (organizations, org_members, api_keys, users,
--    sessions) is intentionally NOT org-scoped: the proxy resolves the tenant
--    context from it *without* a context. They contain no client ad data.
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON accounts FOR ALL
  USING (organization_id = public.tenant_org_id())
  WITH CHECK (organization_id = public.tenant_org_id());

ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON campaigns FOR ALL
  USING (organization_id = public.tenant_org_id())
  WITH CHECK (organization_id = public.tenant_org_id());

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_log FOR ALL
  USING (organization_id = public.tenant_org_id())
  WITH CHECK (organization_id = public.tenant_org_id());

ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON chat_messages FOR ALL
  USING (organization_id = public.tenant_org_id())
  WITH CHECK (organization_id = public.tenant_org_id());

ALTER TABLE oauth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON oauth_tokens FOR ALL
  USING (organization_id = public.tenant_org_id())
  WITH CHECK (organization_id = public.tenant_org_id());

ALTER TABLE pending_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pending_actions FOR ALL
  USING (organization_id = public.tenant_org_id())
  WITH CHECK (organization_id = public.tenant_org_id());

ALTER TABLE recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE recommendations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON recommendations FOR ALL
  USING (organization_id = public.tenant_org_id())
  WITH CHECK (organization_id = public.tenant_org_id());

ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON settings FOR ALL
  USING (organization_id = public.tenant_org_id())
  WITH CHECK (organization_id = public.tenant_org_id());

-- Derived tables (1:many of campaigns): isolation through the parent FK.
ALTER TABLE metrics_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrics_daily FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON metrics_daily FOR ALL
  USING (EXISTS (SELECT 1 FROM campaigns c WHERE c.id = metrics_daily.campaign_id AND c.organization_id = public.tenant_org_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM campaigns c WHERE c.id = metrics_daily.campaign_id AND c.organization_id = public.tenant_org_id()));

ALTER TABLE keywords ENABLE ROW LEVEL SECURITY;
ALTER TABLE keywords FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON keywords FOR ALL
  USING (EXISTS (SELECT 1 FROM campaigns c WHERE c.id = keywords.campaign_id AND c.organization_id = public.tenant_org_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM campaigns c WHERE c.id = keywords.campaign_id AND c.organization_id = public.tenant_org_id()));

ALTER TABLE negative_keywords ENABLE ROW LEVEL SECURITY;
ALTER TABLE negative_keywords FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON negative_keywords FOR ALL
  USING (EXISTS (SELECT 1 FROM campaigns c WHERE c.id = negative_keywords.campaign_id AND c.organization_id = public.tenant_org_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM campaigns c WHERE c.id = negative_keywords.campaign_id AND c.organization_id = public.tenant_org_id()));

ALTER TABLE avito_chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE avito_chats FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON avito_chats FOR ALL
  USING (EXISTS (SELECT 1 FROM campaigns c WHERE c.id = avito_chats.listing_id AND c.organization_id = public.tenant_org_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM campaigns c WHERE c.id = avito_chats.listing_id AND c.organization_id = public.tenant_org_id()));

-- NOTE: `users` and `sessions` are identity tables (a user may belong to
-- several orgs) and are intentionally not org-scoped; access is controlled
-- by the auth layer (Phase B) and Phase D RBAC.

-- 6. Tenant query indexes
CREATE INDEX campaigns_org_idx ON campaigns USING btree (organization_id);
CREATE INDEX audit_log_org_ts_idx ON audit_log USING btree (organization_id, ts DESC);
CREATE INDEX pending_actions_org_idx ON pending_actions USING btree (organization_id);
CREATE INDEX recommendations_org_idx ON recommendations USING btree (organization_id);
CREATE INDEX chat_messages_org_idx ON chat_messages USING btree (organization_id);
