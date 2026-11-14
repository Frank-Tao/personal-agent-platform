#!/usr/bin/env bash
# Renders the launchd agents for Cockpit, the private pipeline, the work watchdog, backups and the Utility Portal.
# Default is a dry run (writes rendered files to a temp dir and shows them). --apply installs + loads.
#   install-launchd.sh [--apply] [job ...]      with job names (cockpit, backup, utility-portal, ...) only those; none = all
# Hermes is NOT handled here: its gateway already has its own launchd job.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
NODE="$(command -v node)"
# Not /usr/bin/python3: Apple's stub stops with a licence prompt until Xcode's licence is accepted (it did after an OS update).
PYTHON="${PYTHON:-}"
for p in /opt/homebrew/bin/python3 /usr/local/bin/python3; do [ -n "$PYTHON" ] || { [ -x "$p" ] && PYTHON="$p"; } || true; done
PORTAL="${PORTAL_DIR:-$HOME/codes/utility-portal}"
APPLY=0; [ "${1:-}" = "--apply" ] && { APPLY=1; shift; }
OUT="$HOME/Library/LaunchAgents"
mkdir -p "$HOME/Library/Logs/pap"
[ "$APPLY" = 1 ] || OUT="$(mktemp -d)"

ALL="cockpit private-pipeline work-watch growth feedback-weekly backup utility-portal"
JOBS="${*:-$ALL}"
for name in $JOBS; do
  label="com.franktao.pap.$name"
  tmpl="$REPO/infra/launchd/$label.plist.tmpl"
  [ -f "$tmpl" ] || { echo "no such job: $name (have: $ALL)" >&2; exit 2; }
  if [ "$name" = utility-portal ]; then
    [ -f "$PORTAL/server.py" ] || { echo "skip $name: no $PORTAL/server.py (set PORTAL_DIR)"; continue; }
    [ -n "$PYTHON" ] || { echo "skip $name: no Homebrew python3 (brew install python)"; continue; }
  fi
  dest="$OUT/$label.plist"
  sed -e "s#__REPO__#$REPO#g" -e "s#__HOME__#$HOME#g" -e "s#__NODE__#$NODE#g" -e "s#__PYTHON__#$PYTHON#g" -e "s#__PORTAL__#$PORTAL#g" \
      "$tmpl" > "$dest"
  plutil -lint "$dest" >/dev/null
  if [ "$APPLY" = 1 ]; then
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$dest"
    echo "loaded $label"
  else
    echo "would install $dest"
  fi
done
[ "$APPLY" = 1 ] || echo "(dry run — re-run with --apply)"
