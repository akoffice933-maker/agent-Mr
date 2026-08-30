-- Self-serve signup + billing (identity/billing plane).
--
-- 1. users.email UNIQUE
--    There was NO unique index on users.email. getUserByEmail() takes rows[0],
--    so two rows with the same address make login non-deterministic: which
--    password works depends on physical row order. The CLI was the only way to
--    create users and it checked for duplicates in application code, which
--    hid the gap. Self-serve signup makes it reachable by anyone, and two
--    concurrent requests for the same address race past any SELECT-then-INSERT
--    check. The constraint is the only real fix.
--
--    Emails are stored already-normalised (lower+trim) by the application, so
--    a plain UNIQUE is enough and stays index-only for the login lookup.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx ON users (email);

-- 2. Email verification
--    Only the hash of the token is stored: a leaked database (or log line)
--    must not yield a working verification link. Same discipline as
--    org_invites.token_hash.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;

CREATE TABLE IF NOT EXISTS email_verifications (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  sent_to text NOT NULL
);
CREATE INDEX IF NOT EXISTS email_verifications_user_idx ON email_verifications(user_id);

-- 3. Billing
--    One subscription row per organization. `plan` is the entitlement the app
--    reads; provider fields stay nullable so a free org needs no provider
--    account at all.
CREATE TABLE IF NOT EXISTS subscriptions (
  id serial PRIMARY KEY,
  org_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan text NOT NULL DEFAULT 'free',
  status text NOT NULL DEFAULT 'active',
  provider text,                       -- 'stripe' | 'yookassa' | NULL (free)
  provider_customer_id text,
  provider_subscription_id text,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- One subscription per org: the entitlement lookup must never be ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_org_unique_idx ON subscriptions(org_id);

--    Payment events, for idempotent webhook processing and for an audit trail
--    of money. Providers retry webhooks and can deliver out of order, so the
--    provider's own event id is the idempotency key.
CREATE TABLE IF NOT EXISTS payment_events (
  id serial PRIMARY KEY,
  org_id integer REFERENCES organizations(id) ON DELETE SET NULL,
  provider text NOT NULL,
  event_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
-- Same event delivered twice must be stored (and acted on) exactly once.
CREATE UNIQUE INDEX IF NOT EXISTS payment_events_provider_event_idx ON payment_events(provider, event_id);
CREATE INDEX IF NOT EXISTS payment_events_org_idx ON payment_events(org_id);
