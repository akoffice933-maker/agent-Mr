-- 0005_luxuriant_doctor_faustus.sql
-- Phase 0 hardening (review 27.08.2026):
--  * 0.4 optimistic locking: pending_actions.version — bumped on every
--    lifecycle transition, checked by the atomic claim in resolvePending;
--  * 0.5 approval window: pending_actions.expires_at — stale pending actions
--    are swept to 'expired' (48h for pending, 14d for failed).
ALTER TABLE "pending_actions" ADD COLUMN IF NOT EXISTS "version" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "pending_actions" ADD COLUMN IF NOT EXISTS "expires_at" timestamp;
--> statement-breakpoint
-- Legacy single-column FK is superseded by the composite
-- campaigns_org_account_fk (0004) which enforces the tenant invariant.
ALTER TABLE "campaigns" DROP CONSTRAINT IF EXISTS "campaigns_account_id_accounts_id_fk";
