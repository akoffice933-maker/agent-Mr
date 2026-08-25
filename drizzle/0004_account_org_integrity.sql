-- 0004_account_org_integrity.sql
--
-- Tenant relationship integrity (review E.1 P0-3): campaigns.account_id could
-- reference an account from ANOTHER organization. RLS protects the rows, but
-- the cross-tenant relationship invariant was not expressed in the schema.
--
-- Composite FK: campaigns(organization_id, account_id)
--   → accounts(organization_id, id)
-- requires the unique key on accounts(organization_id, id). A NULL account_id
-- still passes (dev/sandbox campaigns without an account); any non-null pair
-- must belong to the same org.

ALTER TABLE accounts ADD CONSTRAINT accounts_organization_id_id_key UNIQUE (organization_id, id);

ALTER TABLE campaigns ADD CONSTRAINT campaigns_org_account_fk
  FOREIGN KEY (organization_id, account_id)
  REFERENCES accounts (organization_id, id)
  ON DELETE SET NULL;
