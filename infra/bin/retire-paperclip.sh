#!/usr/bin/env bash
# Retire Paperclip: final DB dump + archive of ~/.paperclip, then stop the process and the
# tailscale serve route. Nothing is deleted. Dry run by default; --apply to execute.
# Run only after the live MicroPace / AI Thrival work has been moved to Hermes kanban.
set -euo pipefail
APPLY=0; [ "${1:-}" = "--apply" ] && APPLY=1
run(){ echo "+ $*"; [ "$APPLY" = 1 ] && "$@" || true; }
SRC="$HOME/.paperclip"
DEST="${BACKUP_DIR:-$HOME/Backups/pap}/paperclip-final-$(date +%F)"
# The node server, not its `npm exec` parent: SIGTERM lets it shut embedded Postgres down cleanly.
PID="$(pgrep -f '\.bin/paperclipai run' | head -1 || true)"

[ -d "$SRC" ] || { echo "no $SRC — nothing to retire"; exit 0; }
run mkdir -p "$DEST"
echo "# 1. newest automatic DB dump (Paperclip writes one hourly)"
latest="$(ls -t "$SRC"/instances/default/data/backups/*.sql.gz 2>/dev/null | head -1 || true)"
[ -n "$latest" ] && run cp "$latest" "$DEST/" || echo "  · no automatic dump found"
echo "# 2. stop Paperclip${PID:+ (pid $PID)} so the archive is consistent"
[ -n "$PID" ] && run kill "$PID" || echo "  · not running"
echo "# 3. archive the whole instance (db, configs, company workspaces)"
run tar -C "$HOME" -czf "$DEST/dot-paperclip.tgz" .paperclip
echo "# 4. remove the tailnet route to :3100 (HTTPS 443)"
run tailscale serve --https=443 off
cat <<MSG

Kept: $SRC (delete it yourself once you have checked $DEST).
To bring Paperclip back temporarily:  npx paperclipai@2026.1012.0 run
MSG
[ "$APPLY" = 1 ] || echo "(dry run — re-run with --apply)"
