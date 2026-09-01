-- 0013: product-analytics events (self-serve funnel).
--
-- Identity-plane, no RLS: cross-tenant product/growth data, never displayed
-- back to a specific organization's own users — same reasoning as
-- sessions/api_keys staying outside RLS. org_id nullable: most funnel steps
-- (landing_view, cta_signup_click) happen before a session exists at all.
CREATE TABLE IF NOT EXISTS analytics_events (
  id serial PRIMARY KEY,
  event text NOT NULL,
  org_id integer REFERENCES organizations(id) ON DELETE SET NULL,
  meta jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS analytics_events_event_idx ON analytics_events (event, created_at);
