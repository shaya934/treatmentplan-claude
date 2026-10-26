#!/usr/bin/env bash
# Local Postgres 16 for development and tests (synthetic data only).
# Creates two roles: aba_owner (owns schema, runs migrations) and aba_app
# (runtime, non-owner, subject to forced row-level security).
set -euo pipefail
cmd="${1:-start}"
if [ "$cmd" = "stop" ]; then service postgresql stop; exit 0; fi
service postgresql start >/dev/null
for i in $(seq 1 20); do pg_isready -q -h 127.0.0.1 && break; sleep 0.5; done
su postgres -c "psql -v ON_ERROR_STOP=1 -q" <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aba_owner') THEN CREATE ROLE aba_owner LOGIN PASSWORD 'aba_owner_local'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aba_app') THEN CREATE ROLE aba_app LOGIN PASSWORD 'aba_app_local' NOBYPASSRLS; END IF;
END $$;
SQL
for db in aba aba_test; do
  if ! su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='$db'\"" | grep -q 1; then
    su postgres -c "createdb -O aba_owner $db"
  fi
done
echo "Postgres ready: postgres://aba_app:aba_app_local@127.0.0.1:5432/aba"
