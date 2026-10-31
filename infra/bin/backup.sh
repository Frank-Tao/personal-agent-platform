#!/usr/bin/env bash
# Nightly backup: Hermes home, Portfolio HQ db, KB, Paperclip data (stopped-free copy via pg_dump if DATABASE_URL set).
set -euo pipefail
DEST="${BACKUP_DIR:-$HOME/Backups/pap}/$(date +%F)"
mkdir -p "$DEST"
[ -f "$(dirname "$0")/../../data/hq.sqlite" ] && sqlite3 "$(dirname "$0")/../../data/hq.sqlite" ".backup '$DEST/hq.sqlite'"
tar -C "$HOME" -czf "$DEST/portfolio-kb.tgz" PortfolioKB 2>/dev/null || true
command -v hermes >/dev/null && hermes backup >/dev/null 2>&1 && echo "hermes backup done" || true
if [ -n "${DATABASE_URL:-}" ]; then
  pg_dump "$DATABASE_URL" | gzip > "$DEST/paperclip.sql.gz"
else
  echo "Paperclip uses embedded Postgres: stop it (paperclipai service stop) before copying ~/.paperclip, or switch to DATABASE_URL + pg_dump." >&2
fi
find "$(dirname "$DEST")" -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf {} +
echo "backup -> $DEST"
