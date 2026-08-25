-- 0003_rls_oauth_states.sql
--
-- Put oauth_states under the same FORCE RLS tenant policy as the other
-- directly-scoped tables. oauth_states is client-data (organization_id
-- NOT NULL + FK to organizations), not part of the identity/credential
-- plane: the proxy resolves the tenant from session/machine-key BEFORE any
-- OAuth state lookup, so no code path needs context-free access.
-- NULLIF keeps the fail-closed guarantee identical to the other policies
-- (see 0002): unset or empty app.org_id → 0 rows, never an error.

ALTER TABLE oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_states FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON oauth_states
  USING (organization_id = NULLIF(current_setting('app.org_id', true), '')::int)
  WITH CHECK (organization_id = NULLIF(current_setting('app.org_id', true), '')::int);
