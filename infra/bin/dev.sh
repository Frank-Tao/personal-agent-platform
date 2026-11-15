#!/usr/bin/env bash
# Run a dev copy next to prod, from this working copy and whatever branch is checked out in it. Prod is untouched.
#
#   dev.sh cockpit            http://127.0.0.1:3201   fake data (demo): safe, nothing real can be changed
#   dev.sh cockpit --live     http://127.0.0.1:3201   real Hermes, boards and agents: a button here changes real things
#   dev.sh portal             http://127.0.0.1:8889   Utility Portal from ~/codes/utility-portal
#
# The page header says DEV (or DEMO) and the branch, so you always know which endpoint you are on. Prod stays on :3200 and :8888.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
[ ! -f "$REPO/.pap-prod" ] || { echo "this is the prod clone ($REPO): run dev from your working copy, not from ~/services" >&2; exit 1; }
what="${1:-cockpit}"; shift || true
case "$what" in
  cockpit)
    cd "$REPO"
    export PAP_ENV=dev COCKPIT_PORT="${DEV_COCKPIT_PORT:-3201}" COCKPIT_HOST=127.0.0.1
    if [ "${1:-}" = "--live" ]; then
      export COCKPIT_DB="$REPO/data/cockpit-dev.sqlite"   # its own database; prod's is never opened
      echo "DEV on REAL data: Hermes, kanban boards, agents and chat are the real ones. Branch: $(git branch --show-current)"
    else
      export COCKPIT_DEMO=1
      echo "DEV with demo data (nothing real is touched). Branch: $(git branch --show-current). Add --live for real data."
    fi
    echo "→ http://127.0.0.1:$COCKPIT_PORT"
    exec node --env-file-if-exists=infra/env apps/cockpit/src/server.ts
    ;;
  portal)
    PORTAL="${PORTAL_DEV_DIR:-$HOME/codes/utility-portal}"
    [ -f "$PORTAL/server.py" ] || { echo "no $PORTAL/server.py" >&2; exit 1; }
    PY="${PYTHON:-/opt/homebrew/bin/python3}"
    echo "DEV portal from $PORTAL (branch: $(git -C "$PORTAL" branch --show-current 2>/dev/null || echo ?)) → http://127.0.0.1:${DEV_PORTAL_PORT:-8889}"
    cd "$PORTAL"
    exec "$PY" server.py --host 127.0.0.1 --port "${DEV_PORTAL_PORT:-8889}"
    ;;
  *) echo "usage: dev.sh cockpit [--live] | portal" >&2; exit 2 ;;
esac
