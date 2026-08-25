// Test database wiring.
//
// The tenant pool reads DATABASE_TEST_URL first, then DATABASE_URL
// (src/lib/tenant/pool.ts). Tests that actually touch the database
// (execution-pipeline, tenant-security integration) need a real connection;
// pure unit tests only need the variable to exist at module-load time.
//
// Default: the local sandbox database (app_db). For CI / dedicated test
// databases, export DATABASE_TEST_URL before running vitest — that value
// always wins.
const LOCAL_APP_DB = "postgresql://appuser:apppass@127.0.0.1:5432/app_db";

process.env.DATABASE_TEST_URL ??= LOCAL_APP_DB;
process.env.DATABASE_URL ??= process.env.DATABASE_TEST_URL;

// OAuth token store encrypts with AES-256-GCM derived from ENCRYPTION_KEY
// (src/lib/crypto). Tests that exercise the OAuth callback path need a key;
// this value is test-only and never used outside the test process.
process.env.ENCRYPTION_KEY ??= "test-encryption-key-000000000000000000000000";
