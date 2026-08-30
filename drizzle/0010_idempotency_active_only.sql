-- 0010_idempotency_active_only.sql
--
-- Review P1.2: the idempotency key must scope only ACTIVE pending actions.
--
-- Problem
-- -------
-- `pending_actions.idempotency_key` carried a plain UNIQUE constraint, and the
-- key is deterministic: sha256(org:tool:JSON(params)). The row is never
-- deleted when an action reaches a terminal state, so the key stayed occupied
-- forever. A completely normal user flow therefore hit a hard failure:
--
--   1. "pause campaign X"        -> pending #1 created
--   2. user rejects it           -> status 'rejected', ROW REMAINS
--   3. user changes their mind,
--      asks for the same thing   -> INSERT -> 23505 duplicate key -> HTTP 500
--
-- The same dead-end applied after 'expired' and after a successful 'verified'
-- (repeating an identical action later was impossible).
--
-- Fix
-- ---
-- A PARTIAL unique index: idempotency is what protects an in-flight action
-- from being duplicated (double-click, retried webhook, concurrent approver),
-- so it only needs to hold while the action is actually in flight. Terminal
-- states (verified / failed / rejected / expired) release the key.
--
-- 'failed' is deliberately NOT part of the active set: a failed action is
-- retried by re-approving the EXISTING row (resolvePending allows
-- pending|failed -> executing), never by inserting a new one. Leaving it out
-- lets the user re-issue the request from chat after a permanent failure.
--
-- Note: the constraint is dropped by name. Drizzle generated it as
-- "pending_actions_idempotency_key_unique"; older databases may carry the
-- index-only variant, so both spellings are handled.

ALTER TABLE pending_actions DROP CONSTRAINT IF EXISTS pending_actions_idempotency_key_unique;
DROP INDEX IF EXISTS pending_actions_idempotency_key_unique;

CREATE UNIQUE INDEX IF NOT EXISTS pending_actions_idem_active_idx
  ON pending_actions (idempotency_key)
  WHERE status IN ('pending', 'executing');
