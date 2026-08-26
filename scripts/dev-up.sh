#!/usr/bin/env bash
# Self-healing dev bootstrap (sandbox-reset-proof) — the durable fix for the
# "stuck in a loop" feeling. The sandbox restore WIPES runtime state between
# steps: it kills the Postgres process, wipes node_modules, drops .env, and
# deletes the empty files/dirs Postgres needs to boot. This script idempotently
# restores a working dev environment in ONE run:
#
#   1. Self-heal Postgres: recreate wiped empty files/dirs, restore exec bits,
#      start the server if it was killed, wait until it accepts connections.
#   2. Restore node_modules if the sandbox wiped it (npm ci).
#   3. Ensure .env (DATABASE_URL / DATABASE_TEST_URL / ENCRYPTION_KEY).
#   4. Apply migrations + seed (idempotent).
#
# Usage:
#   bash scripts/dev-up.sh            # restore env + migrate + seed
#   bash scripts/dev-up.sh --test     # + run the full test suite
set -e
cd "$(dirname "$0")/.."
PGBIN=/home/user/.theseus/postgresql/18.0.0/bin
PGDATA=/home/user/pgdata
DBURL="postgresql://appuser:apppass@127.0.0.1:5432/app_db"

# 1. Self-heal Postgres (sandbox wipes empty files/dirs + exec bits, kills server).
chmod +x "$PGBIN"/* 2>/dev/null || true
chmod 700 "$PGDATA" 2>/dev/null || true
# pg_commit_ts + pg_wal/* + pg_multixact/* + pg_* are empty SLRU/directories the
# sandbox restore deletes; pg_logical/replorigin_snapshot is an empty file.
rm -rf "$PGDATA/pg_commit_ts"
for d in pg_notify pg_replslot pg_serial pg_snapshots pg_stat pg_stat_tmp pg_twophase \
         pg_tblspc pg_commit_ts pg_logical/mappings pg_logical/snapshots \
         pg_wal/archive_status pg_wal/summaries pg_multixact/members pg_multixact/offsets \
         pg_subtrans pg_xact base/1 base/4 base/5 base/16384 global; do
  mkdir -p "$PGDATA/$d"
done
rm -rf "$PGDATA/pg_logical/replorigin_snapshot" 2>/dev/null || true; touch "$PGDATA/pg_logical/replorigin_snapshot" 2>/dev/null || true
chmod 700 "$PGDATA"/pg_* 2>/dev/null || true
if ! "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
  "$PGBIN/pg_ctl" -D "$PGDATA" -l /tmp/pg.log -w start
fi
for i in $(seq 1 40); do "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1 && break; sleep 0.5; done

# 2. Restore node_modules if the sandbox wiped it (root + telegram-bot).
if [ ! -d node_modules/vitest ]; then npm ci --no-audit --no-fund; fi
if [ ! -d telegram-bot/node_modules/grammy ]; then (cd telegram-bot && npm ci --no-audit --no-fund); fi

# 3. Ensure .env.
[ -f .env ] || cp .env.example .env
grep -q '^DATABASE_URL=' .env || echo 'DATABASE_URL=postgresql://appuser:apppass@127.0.0.1:5432/app_db' >> .env
grep -q '^DATABASE_TEST_URL=' .env || echo 'DATABASE_TEST_URL=postgresql://appuser:apppass@127.0.0.1:5432/app_db' >> .env
grep -q '^ENCRYPTION_KEY=' .env || echo 'ENCRYPTION_KEY=dev-only-encryption-key-0000000000' >> .env
export DATABASE_URL="$DBURL"

# 4. Migrate + seed (idempotent).
npm run migrate >/dev/null
npm run seed >/dev/null
echo "✓ environment restored (postgres up, deps, .env, migrated, seeded)"

# 5. Optional: run the tests.
if [ "$1" = "--test" ]; then npm run test; fi
