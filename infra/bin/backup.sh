#!/usr/bin/env bash
# Nightly backup: Cockpit db, KB repos, Hermes home (memory, skills, kanban boards).
set -euo pipefail
DEST="${BACKUP_DIR:-$HOME/Backups/pap}/$(date +%F)"
mkdir -p "$DEST"
[ -f "$(dirname "$0")/../../data/cockpit.sqlite" ] && sqlite3 "$(dirname "$0")/../../data/cockpit.sqlite" ".backup '$DEST/cockpit.sqlite'"
tar -C "$HOME" -czf "$DEST/portfolio-kb.tgz" PortfolioKB 2>/dev/null || true
command -v hermes >/dev/null && hermes backup -q -o "$DEST/hermes.zip" && echo "hermes backup done" || true
find "$(dirname "$DEST")" -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf {} +
echo "backup -> $DEST"
