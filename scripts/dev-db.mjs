// scripts/dev-db.mjs — embedded Postgres for sandbox/dev (pg-embedded).
//
// The sandbox resets system packages and background processes between steps,
// so instead of a system Postgres we run the real Postgres binary shipped
// with the pg-embedded npm package. The cluster lives in /home/user/pgdata
// (inside the persisted workspace), so schema + data survive sandbox resets.
//
// pg-embedded's role provisioning is unreliable in the sandbox (the configured
// username can end up without a usable password), so this script bootstraps
// the app role itself: temporarily flips pg_hba to trust, creates/repairs
// `appuser` (superuser, password apppass) and `app_db`, then restores
// password auth. Self-healing: if a previous run died mid-bootstrap, the
// patch/restore sequence converges again.
//
// Revival after a sandbox reset:
//   npm install
//   node scripts/dev-db.mjs          (keeps running; prints DEV DB READY)
//   DATABASE_URL=postgresql://appuser:apppass@127.0.0.1:5432/app_db npx drizzle-kit migrate
//   DATABASE_URL=... npm run seed
//
// The Next.js app and the test suite both connect to
// postgresql://appuser:apppass@127.0.0.1:5432/app_db
// (tests: DATABASE_TEST_URL, see tests/setup.ts).

import fs from "node:fs";
import { PostgresInstance } from "pg-embedded";
import pgm from "pg";

const { Pool } = pgm;

const DATA_DIR = process.env.PG_DATA_DIR ?? "/home/user/pgdata";
const APP_URL = "postgresql://appuser:apppass@127.0.0.1:5432/app_db";

const HBA = DATA_DIR + "/pg_hba.conf";
const hbaTo = (mode) => {
  const before = fs.readFileSync(HBA, "utf8");
  const after = mode === "trust" ? before.replace(/\bpassword(?=\s*$)/gm, "trust") : before.replace(/\btrust(?=\s*$)/gm, "password");
  if (before !== after) fs.writeFileSync(HBA, after);
};

const postgres = new PostgresInstance({
  host: "127.0.0.1",
  port: 5432,
  username: "appuser",
  password: "apppass",
  databaseName: "app_db",
  dataDir: DATA_DIR,
  persistent: true,
});

// 0b) Self-heal: snapshot restore also drops EMPTY directories the cluster
// needs (pg_notify, pg_stat_tmp, ...) — without them postgres dies at startup
// with "could not open directory". Recreate the standard set (idempotent).
try {
  const stdDirs = [
    "pg_commit_ts", "pg_dynshmem", "pg_logical/mappings", "pg_logical/replorigin_snapshot",
    "pg_logical/snapshots", "pg_notify", "pg_replslot", "pg_serial", "pg_snapshots",
    "pg_stat", "pg_stat_tmp", "pg_subtrans", "pg_tblspc", "pg_twophase",
  ];
  for (const d of stdDirs) {
    const p = DATA_DIR + "/" + d;
    if (!fs.existsSync(p)) {
      fs.mkdirSync(p, { recursive: true, mode: 0o700 });
    }
  }
} catch {}

// 0) Self-heal: sandbox snapshot restore strips execute bits from the
// embedded Postgres binaries (/home/user/.theseus/postgresql/*/bin) — without
// them start() dies with "Permission denied (os error 13)".
try {
  const theseus = "/home/user/.theseus/postgresql";
  for (const v of fs.readdirSync(theseus)) {
    const binDir = `${theseus}/${v}/bin`;
    if (!fs.existsSync(binDir)) continue;
    for (const f of fs.readdirSync(binDir)) {
      try {
        fs.chmodSync(`${binDir}/${f}`, 0o755);
      } catch {}
    }
  }
} catch {}

// 1) Trust auth for the bootstrap window.
hbaTo("trust");

// 2) Start (or attach to an already-running instance with the same dataDir).
const net = await import("node:net");
const portUp = () =>
  new Promise((resolve) => {
    const s = net.connect(5432, "127.0.0.1");
    s.on("connect", () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
  });

if (await portUp()) {
  console.log("postgres already listening on 5432 — attaching (no start)");
} else {
  // A stale postmaster.pid from a crashed run makes pg_ctl try to inspect a
  // (possibly foreign) /proc/<pid> and fail with EPERM. The port check above
  // proves no server is running, so removing it is safe.
  for (const f of ["postmaster.pid", "postmaster.opts"]) {
    try {
      fs.rmSync(DATA_DIR + "/" + f, { force: true });
    } catch {}
  }
  // Sandbox snapshot restore widens the data dir to 0755; Postgres 18 hard-
  // requires u=rwx (0700) or u=rwx,g=rx (0750). Self-heal to 0700.
  try {
    fs.chmodSync(DATA_DIR, 0o700);
  } catch {}
  await postgres.start();
}
// Readiness = a real SQL connection (isHealthy() only knows instances this
// process started).
const sqlReady = async () => {
  for (let i = 0; i < 60; i++) {
    const p = new Pool({ connectionString: "postgresql://postgres@127.0.0.1:5432/postgres", connectionTimeoutMillis: 1500 });
    try {
      await p.query("select 1");
      await p.end();
      return true;
    } catch {
      await p.end().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return false;
};
if (!(await sqlReady())) {
  console.error("DEV DB FAILED TO START (dataDir: " + DATA_DIR + ")");
  process.exit(1);
}

// 3) Bootstrap role + database over the trusted local connection.
//    pg-embedded initializes the cluster with the built-in superuser `postgres`.
const admin = new Pool({ connectionString: "postgresql://postgres@127.0.0.1:5432/postgres", connectionTimeoutMillis: 5000 });
try {
  // IMPORTANT: appuser must NOT be a superuser — superusers BYPASS RLS
  // entirely (even with FORCE), which would silently disable tenant
  // isolation. appuser is a plain role that OWNS the database and its
  // tables, exactly like the original sandbox setup (postgres is the
  // superuser; appuser is the owner subject to FORCE RLS).
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'appuser') THEN
      CREATE ROLE appuser LOGIN PASSWORD 'apppass';
    ELSE
      ALTER ROLE appuser WITH LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'apppass';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'app_db') THEN
      CREATE DATABASE "app_db" OWNER appuser;
    ELSE
      ALTER DATABASE "app_db" OWNER TO appuser;
    END IF;
  END $$;`);
  await admin.query(`GRANT ALL PRIVILEGES ON DATABASE "app_db" TO appuser`);
  console.log("bootstrap: appuser role (non-superuser owner) + app_db OK");
} finally {
  await admin.end();
}

// 4) Restore password auth (appuser now has a known password).
hbaTo("password");
const reload = new Pool({ connectionString: "postgresql://postgres@127.0.0.1:5432/postgres", connectionTimeoutMillis: 5000 });
await reload.query("SELECT pg_reload_conf()");
await reload.end();
console.log("bootstrap: pg_hba restored to password auth");

// 5) Final check: the exact connection string the app uses must work.
const check = new Pool({ connectionString: APP_URL, connectionTimeoutMillis: 5000 });
await check.query("select 1");
await check.end();
console.log("DEV DB READY: " + APP_URL + " (dataDir: " + DATA_DIR + ")");

// Keep running until killed (SIGTERM → clean stop).
if (process.env.KEEP_ALIVE !== "0") {
  setInterval(() => {}, 1 << 30);
  process.on("SIGTERM", async () => {
    try {
      await postgres.stop();
    } catch {}
    process.exit(0);
  });
} else {
  // Probe mode: leave the server stopped (clean state for the next run).
  await postgres.stop().catch(() => undefined);
}
