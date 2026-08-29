-- 0008_drop_users_role.sql (review L4)
--
-- The `users.role` column was deprecated (E.1): the effective role ALWAYS comes
-- from org_members.role (per-tenant membership), and the column was never read
-- for authorization. This migration removes it, closing the last place where a
-- stale/legacy role could be displayed (e.g. /api/auth/me, /api/auth/login once
-- they read it) or confused for the real one.
ALTER TABLE "users" DROP COLUMN IF EXISTS "role";
