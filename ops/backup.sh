#!/usr/bin/env bash
# Nightly logical backup for Glam Connect.
#
# Use a role that can read every row, not `glam_app`: RLS would otherwise limit
# the dump to whatever tenant context is unset (usually nothing). Point
# BACKUP_DATABASE_URL at a dedicated BYPASSRLS role, or fall back to the
# migration/owner URL.
#
# Usage:
#   BACKUP_DATABASE_URL=postgres://backup:***@db:5432/glamconnect ./ops/backup.sh
#
# Cron example (02:15 IST daily):
#   15 2 * * * cd /srv/glamconnect && BACKUP_DATABASE_URL=... ./ops/backup.sh >> /var/log/glam-backup.log 2>&1
set -euo pipefail

: "${BACKUP_DATABASE_URL:=${MIGRATE_DATABASE_URL:-${DATABASE_URL:-}}}"
if [[ -z "$BACKUP_DATABASE_URL" ]]; then
  echo "Set BACKUP_DATABASE_URL (or MIGRATE_DATABASE_URL/DATABASE_URL)" >&2
  exit 1
fi

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
mkdir -p "$BACKUP_DIR"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$BACKUP_DIR/glamconnect-$stamp.dump"

echo "Backing up to $target"
pg_dump --format=custom --no-owner --no-privileges --file="$target" "$BACKUP_DATABASE_URL"

# A dump that cannot be listed is not a usable dump.
pg_restore --list "$target" > /dev/null
size=$(wc -c < "$target" | tr -d ' ')
echo "Verified $target ($size bytes)"

find "$BACKUP_DIR" -maxdepth 1 -name 'glamconnect-*.dump' -type f -mtime +"$RETENTION_DAYS" -print -delete

echo "Done. Restore with:"
echo "  pg_restore --clean --if-exists --no-owner --no-privileges -d <target-db> $target"
