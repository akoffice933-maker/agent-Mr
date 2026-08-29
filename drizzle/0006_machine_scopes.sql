-- Phase 1: capability scopes for machine/API keys.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS scopes jsonb;
-- Existing keys remain unrestricted for backwards compatibility.
-- New keys created by the CLI receive explicit scopes.
