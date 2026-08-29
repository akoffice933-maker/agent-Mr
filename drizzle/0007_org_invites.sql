-- Phase 1: organization invitations.
CREATE TABLE IF NOT EXISTS org_invites (
  id serial PRIMARY KEY,
  org_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL DEFAULT 'viewer',
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz
);
CREATE INDEX IF NOT EXISTS org_invites_org_idx ON org_invites(org_id);
CREATE INDEX IF NOT EXISTS org_invites_email_idx ON org_invites(email);
