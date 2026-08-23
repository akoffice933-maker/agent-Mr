-- 0005: api_keys lifecycle (Phase C.1): expiration + revocation
ALTER TABLE "api_keys" ADD COLUMN "expires_at" timestamp;
ALTER TABLE "api_keys" ADD COLUMN "revoked_at" timestamp;
