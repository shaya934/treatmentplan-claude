#!/usr/bin/env bash
# Backup/restore drill. Local: dump the database, restore into a scratch DB,
# compare row counts per table. AWS: see docs/RESTORE.md (RDS point-in-time restore).
set -euo pipefail
SRC=${SRC_DB:-aba}
DST=aba_restore_test
OWNER=postgres://aba_owner:aba_owner_local@127.0.0.1:5432
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
chmod 777 "$tmp"
# Superuser dump: RLS is forced on every table, so the owner alone would see nothing.
su postgres -c "pg_dump -Fc $SRC -f $tmp/backup.dump"
su postgres -c "dropdb --if-exists $DST && createdb -O aba_owner $DST"
su postgres -c "pg_restore -d $DST $tmp/backup.dump"
fail=0
for t in tenants users clients templates template_versions plans plan_versions files evidence bcba_answers review_items audit_log ai_usage; do
  a=$(su postgres -c "psql -tA $SRC -c 'SELECT count(*) FROM $t'")
  b=$(su postgres -c "psql -tA $DST -c 'SELECT count(*) FROM $t'")
  printf "%-18s source=%-6s restored=%-6s %s\n" "$t" "$a" "$b" "$([ "$a" = "$b" ] && echo OK || echo MISMATCH)"
  [ "$a" = "$b" ] || fail=1
done
su postgres -c "dropdb $DST"
[ $fail = 0 ] && echo "RESTORE TEST PASSED" || { echo "RESTORE TEST FAILED"; exit 1; }
