// scripts/migrate.mjs — reliable migration runner for CI and the sandbox.
//
// Why not `drizzle-kit migrate`? The 0.31.x CLI hides migration errors behind
// a TUI spinner and exits 1 without printing the error — in CI (no TTY) the
// failure is a silent "applying migrations..." with zero diagnostics (this
// broke CI for 1e9b381/1423b4a/dd974a5). This script uses the drizzle-orm
// migrator directly: same journal, same applied-tracking table, but real
// errors and a proper exit code.
//
// Usage:  DATABASE_URL=postgresql://... node scripts/migrate.mjs
// (wired as `npm run migrate`)

import pgm from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = new pgm.Pool({ connectionString: url });
try {
  await migrate(drizzle(pool), { migrationsFolder: "drizzle" });
  console.log("MIGRATE OK: all migrations applied");
} catch (e) {
  console.error("MIGRATE FAILED:", e?.message ?? e);
  process.exitCode = 1;
} finally {
  await pool.end();
}
