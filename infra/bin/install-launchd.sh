#!/usr/bin/env bash
# Renders the launchd agents for Cockpit and the private pipeline.
# Default is a dry run (writes rendered files to a temp dir and shows them). --apply installs + loads.
# Hermes is NOT handled here: its gateway already has its own launchd job.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
NODE="$(command -v node)"
APPLY=0; [ "${1:-}" = "--apply" ] && APPLY=1
OUT="$HOME/Library/LaunchAgents"
mkdir -p "$HOME/Library/Logs/pap"
[ "$APPLY" = 1 ] || OUT="$(mktemp -d)"

for name in cockpit private-pipeline work-watch growth feedback-weekly; do
  label="com.franktao.pap.$name"
  dest="$OUT/$label.plist"
  sed -e "s#__REPO__#$REPO#g" -e "s#__HOME__#$HOME#g" -e "s#__NODE__#$NODE#g" \
      "$REPO/infra/launchd/$label.plist.tmpl" > "$dest"
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
