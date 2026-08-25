-- 0002_rls_null_safe.sql
--
-- Harden the tenant policies (0001) against an EMPTY-STRING app.org_id.
--
-- 0001's policy casts the setting directly: `current_setting('app.org_id', true)::int`.
-- A NEVER-SET setting is NULL → cast is NULL → policy is NULL → 0 rows (fail-closed, OK).
-- But a setting explicitly set to '' (empty string) makes `''::int` RAISE:
-- "invalid input syntax for type integer" — a fail-closed layer that turns into
-- a 500 instead of 0 rows. NULLIF('', '') → NULL → clean fail-closed in both cases.
--
-- Recreated for every tenant table; no structural change.

DROP POLICY tenant_isolation ON accounts;
CREATE POLICY tenant_isolation ON accounts
  USING (organization_id = NULLIF(current_setting('app.org_id', true), '')::int)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::int);

DROP POLICY tenant_isolation ON campaigns;
CREATE POLICY tenant_isolation ON campaigns
  USING (organization_id = NULLIF(current_setting('app.org_id', true), '')::int)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::int);

DROP POLICY tenant_isolation ON audit_log;
CREATE POLICY tenant_isolation ON audit_log
  USING (organization_id = NULLIF(current_setting('app.org_id', true), '')::int)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::int);

DROP POLICY tenant_isolation ON chat_messages;
CREATE POLICY tenant_isolation ON chat_messages
  USING (organization_id = NULLIF(current_setting('app.org_id', true), '')::int)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::int);

DROP POLICY tenant_isolation ON oauth_tokens;
CREATE POLICY tenant_isolation ON oauth_tokens
  USING (organization_id = NULLIF(current_setting('app.org_id', true), '')::int)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::int);

DROP POLICY tenant_isolation ON pending_actions;
CREATE POLICY tenant_isolation ON pending_actions
  USING (organization_id = NULLIF(current_setting('app.org_id', true), '')::int)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::int);

DROP POLICY tenant_isolation ON recommendations;
CREATE POLICY tenant_isolation ON recommendations
  USING (organization_id = NULLIF(current_setting('app.org_id', true), '')::int)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::int);

DROP POLICY tenant_isolation ON settings;
CREATE POLICY tenant_isolation ON settings
  USING (organization_id = NULLIF(current_setting('app.org_id', true), '')::int)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::int);

DROP POLICY tenant_isolation ON metrics_daily;
CREATE POLICY tenant_isolation ON metrics_daily
  USING (EXISTS (
    SELECT 1 FROM campaigns c
    WHERE c.id = metrics_daily.campaign_id
      AND c.organization_id = NULLIF(current_setting('app.org_id', true), '')::int
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM campaigns c
    WHERE c.id = metrics_daily.campaign_id
      AND c.organization_id = NULLIF(current_setting('app.org_id', true), '')::int
  ));

DROP POLICY tenant_isolation ON keywords;
CREATE POLICY tenant_isolation ON keywords
  USING (EXISTS (
    SELECT 1 FROM campaigns c
    WHERE c.id = keywords.campaign_id
      AND c.organization_id = NULLIF(current_setting('app.org_id', true), '')::int
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM campaigns c
    WHERE c.id = keywords.campaign_id
      AND c.organization_id = NULLIF(current_setting('app.org_id', true), '')::int
  ));

DROP POLICY tenant_isolation ON negative_keywords;
CREATE POLICY tenant_isolation ON negative_keywords
  USING (EXISTS (
    SELECT 1 FROM campaigns c
    WHERE c.id = negative_keywords.campaign_id
      AND c.organization_id = NULLIF(current_setting('app.org_id', true), '')::int
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM campaigns c
    WHERE c.id = negative_keywords.campaign_id
      AND c.organization_id = NULLIF(current_setting('app.org_id', true), '')::int
  ));

DROP POLICY tenant_isolation ON avito_chats;
CREATE POLICY tenant_isolation ON avito_chats
  USING (EXISTS (
    SELECT 1 FROM campaigns c
    WHERE c.id = avito_chats.listing_id
      AND c.organization_id = NULLIF(current_setting('app.org_id', true), '')::int
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM campaigns c
    WHERE c.id = avito_chats.listing_id
      AND c.organization_id = NULLIF(current_setting('app.org_id', true), '')::int
  ));
