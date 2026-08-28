#!/usr/bin/env bash
# Self-healing Postgres bootstrap (sandbox-reset-proof).
#
# The sandbox restore WIPES EMPTY FILES AND DIRECTORIES between steps, and
# Postgres needs a specific set of empty files/dirs to boot. This recreates
# them fresh on every start, then starts postgres if it's down. Idempotent +
# idempotent against the sandbox wiping empty entries between steps.
set -e
PGBIN=/home/user/.theseus/postgresql/18.0.0/bin
PGDATA=/home/user/pgdata

chmod +x "$PGBIN"/* 2>/dev/null || true
chmod 700 "$PGDATA" 2>/dev/null || true

# Recreate the empty subdirs postgres needs (the sandbox restore wipes them).
# NOTE: pg_commit_ts MUST be a directory (it's an SLRU); the sandbox wipes it
# when empty, so recreate it as a dir, not a file (a file breaks boot with
# 'could not open directory "pg_commit_ts": Not a directory').
for d in pg_commit_ts pg_notify pg_replslot pg_serial pg_snapshots pg_stat \
         pg_stat_tmp pg_twophase pg_tblspc pg_logical/mappings \
         pg_logical/snapshots pg_wal/archive_status pg_wal/summaries \
         pg_multixact/members pg_multixact/offsets pg_subtrans pg_xact \
         base/1 base/4 base/5 base/16384 global; do
  mkdir -p "$PGDATA/$d"
done
# Empty file postgres needs (the sandbox restore wipes empty files too).
touch "$PGDATA/pg_logical/replorigin_snapshot" 2>/dev/null || true
chmod 700 "$PGDATA"/pg_* 2>/dev/null || true

if ! "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
  "$PGBIN/pg_ctl" -D "$PGDATA" -l /tmp/pg.log -w start
fi
for i in $(seq 1 40); do
  "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1 && break
  sleep 0.5
done
"$PGBIN/pg_ctl" -D "$PGDATA" status | head -1
