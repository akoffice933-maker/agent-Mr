-- 0001_tenant_isolation.sql
--
-- Phase C/E — FORCE ROW LEVEL SECURITY on every tenant table.
--
-- This is the isolation layer the tenant pool (src/lib/tenant/pool.ts) has
-- depended on since Phase C; the file was missing, so RLS was never actually
-- enforced in the sandbox database. The scripts/rls-audit.ts audit and the
-- tenant-security integration test verify this state against the live DB.
--
-- Design:
--   * Directly-scoped tables — policy on their own organization_id.
--   * Derived tables (metrics_daily, keywords, negative_keywords, avito_chats)
--     have no org column of their own — policy via an EXISTS anchor to
--     campaigns (their tenant root). RLS is recursive, so the anchor query
--     is itself tenant-filtered: no double trust, no bypass.
--   * Fail-closed: with `app.org_id` unset/empty, `(… )::int` is NULL →
--     every policy evaluates to NULL/false → 0 rows. A bug that forgets the
--     tenant context loses data, never leaks it.
--   * Identity/credential plane (organizations, org_members, users, sessions,
--     api_keys, oauth_states) has NO RLS by design — the auth proxy resolves
--     the tenant context from those tables *before* any context exists.

-- ── Directly-scoped tables ─────────────────────────────────────────────────

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON accounts
  USING (organization_id = (current_setting('app.org_id', true))::int)
  WITH CHECK (organization_id = (current_setting('app.org_id', true))::int);

ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON campaigns
  USING (organization_id = (current_setting('app.org_id', true))::int)
  WITH CHECK (organization_id = (current_setting('app.org_id', true))::int);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_log
  USING (organization_id = (current_setting('app.org_id', true))::int)
  WITH CHECK (organization_id = (current_setting('app.org_id', true))::int);

ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON chat_messages
  USING (organization_id = (current_setting('app.org_id', true))::int)
  WITH CHECK (organization_id = (current_setting('app.org_id', true))::int);

ALTER TABLE oauth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON oauth_tokens
  USING (organization_id = (current_setting('app.org_id', true))::int)
  WITH CHECK (organization_id = (current_setting('app.org_id', true))::int);

ALTER TABLE pending_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pending_actions
  USING (organization_id = (current_setting('app.org_id', true))::int)
  WITH CHECK (organization_id = (current_setting('app.org_id', true))::int);

ALTER TABLE recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE recommendations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON recommendations
  USING (organization_id = (current_setting('app.org_id', true))::int)
  WITH CHECK (organization_id = (current_setting('app.org_id', true))::int);

ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON settings
  USING (organization_id = (current_setting('app.org_id', true))::int)
  WITH CHECK (organization_id = (current_setting('app.org_id', true))::int);

-- ── Derived tables: tenant anchor via campaigns ────────────────────────────

ALTER TABLE metrics_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrics_daily FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON metrics_daily
  USING (EXISTS (
    SELECT 1 FROM campaigns c
    WHERE c.id = metrics_daily.campaign_id
      AND c.organization_id = (current_setting('app.org_id', true))::int
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM campaigns c
    WHERE c.id = metrics_daily.campaign_id
      AND c.organization_id = (current_setting('app.org_id', true))::int
  ));

ALTER TABLE keywords ENABLE ROW LEVEL SECURITY;
ALTER TABLE keywords FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON keywords
  USING (EXISTS (
    SELECT 1 FROM campaigns c
    WHERE c.id = keywords.campaign_id
      AND c.organization_id = (current_setting('app.org_id', true))::int
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM campaigns c
    WHERE c.id = keywords.campaign_id
      AND c.organization_id = (current_setting('app.org_id', true))::int
  ));

ALTER TABLE negative_keywords ENABLE ROW LEVEL SECURITY;
ALTER TABLE negative_keywords FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON negative_keywords
  USING (EXISTS (
    SELECT 1 FROM campaigns c
    WHERE c.id = negative_keywords.campaign_id
      AND c.organization_id = (current_setting('app.org_id', true))::int
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM campaigns c
    WHERE c.id = negative_keywords.campaign_id
      AND c.organization_id = (current_setting('app.org_id', true))::int
  ));

ALTER TABLE avito_chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE avito_chats FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON avito_chats
  USING (EXISTS (
    SELECT 1 FROM campaigns c
    WHERE c.id = avito_chats.listing_id
      AND c.organization_id = (current_setting('app.org_id', true))::int
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM campaigns c
    WHERE c.id = avito_chats.listing_id
      AND c.organization_id = (current_setting('app.org_id', true))::int
  ));
