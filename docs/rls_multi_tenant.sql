-- RLS: tenant isolation (multi-tenancy phase).
-- NOT applied in the single-tenant phase. Apply when multi-tenancy is implemented
-- and the app sets app.org_id per-request (via the pool's withTenant).
CREATE OR REPLACE FUNCTION public.tenant_org_id() RETURNS integer AS $$
  SELECT NULLIF(current_setting('app.org_id', true), '')::int
$$ LANGUAGE sql STABLE;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['accounts','campaigns','audit_log','chat_messages','oauth_tokens','pending_actions','recommendations','settings','api_keys','org_members','organizations','oauth_states']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
  END LOOP;
END $$;

CREATE POLICY tenant_isolation ON organizations FOR ALL
  USING (id = public.tenant_org_id()) WITH CHECK (id = public.tenant_org_id());
CREATE POLICY tenant_isolation ON org_members FOR ALL
  USING (org_id = public.tenant_org_id()) WITH CHECK (org_id = public.tenant_org_id());
CREATE POLICY tenant_isolation ON api_keys FOR ALL
  USING (org_id = public.tenant_org_id()) WITH CHECK (org_id = public.tenant_org_id());
CREATE POLICY tenant_isolation ON oauth_states FOR ALL
  USING (organization_id = public.tenant_org_id()) WITH CHECK (organization_id = public.tenant_org_id());
CREATE POLICY tenant_isolation ON accounts FOR ALL
  USING (organization_id = public.tenant_org_id()) WITH CHECK (organization_id = public.tenant_org_id());
CREATE POLICY tenant_isolation ON campaigns FOR ALL
  USING (organization_id = public.tenant_org_id()) WITH CHECK (organization_id = public.tenant_org_id());
CREATE POLICY tenant_isolation ON audit_log FOR ALL
  USING (organization_id = public.tenant_org_id()) WITH CHECK (organization_id = public.tenant_org_id());
CREATE POLICY tenant_isolation ON chat_messages FOR ALL
  USING (organization_id = public.tenant_org_id()) WITH CHECK (organization_id = public.tenant_org_id());
CREATE POLICY tenant_isolation ON oauth_tokens FOR ALL
  USING (organization_id = public.tenant_org_id()) WITH CHECK (organization_id = public.tenant_org_id());
CREATE POLICY tenant_isolation ON pending_actions FOR ALL
  USING (organization_id = public.tenant_org_id()) WITH CHECK (organization_id = public.tenant_org_id());
CREATE POLICY tenant_isolation ON recommendations FOR ALL
  USING (organization_id = public.tenant_org_id()) WITH CHECK (organization_id = public.tenant_org_id());
CREATE POLICY tenant_isolation ON settings FOR ALL
  USING (organization_id = public.tenant_org_id()) WITH CHECK (organization_id = public.tenant_org_id());
CREATE POLICY tenant_isolation ON metrics_daily FOR ALL
  USING (EXISTS (SELECT 1 FROM campaigns c WHERE c.id = metrics_daily.campaign_id AND c.organization_id = public.tenant_org_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM campaigns c WHERE c.id = metrics_daily.campaign_id AND c.organization_id = public.tenant_org_id()));
CREATE POLICY tenant_isolation ON keywords FOR ALL
  USING (EXISTS (SELECT 1 FROM campaigns c WHERE c.id = keywords.campaign_id AND c.organization_id = public.tenant_org_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM campaigns c WHERE c.id = keywords.campaign_id AND c.organization_id = public.tenant_org_id()));
CREATE POLICY tenant_isolation ON negative_keywords FOR ALL
  USING (EXISTS (SELECT 1 FROM campaigns c WHERE c.id = negative_keywords.campaign_id AND c.organization_id = public.tenant_org_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM campaigns c WHERE c.id = negative_keywords.campaign_id AND c.organization_id = public.tenant_org_id()));
CREATE POLICY tenant_isolation ON avito_chats FOR ALL
  USING (EXISTS (SELECT 1 FROM campaigns c WHERE c.id = avito_chats.listing_id AND c.organization_id = public.tenant_org_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM campaigns c WHERE c.id = avito_chats.listing_id AND c.organization_id = public.tenant_org_id()));
-- users/sessions: identity plane, intentionally NOT org-scoped.
