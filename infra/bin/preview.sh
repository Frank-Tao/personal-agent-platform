#!/usr/bin/env bash
# Look at a pull request (or any branch) in a running Cockpit BEFORE you merge it. Prod is untouched.
#
#   preview.sh 49            the PR's code, fake data (safe: nothing real can change)
#   preview.sh 49 --live     the PR's code on REAL data (Hermes, boards, agents): a button here changes real things
#   preview.sh feat/my-branch [--live]
#   preview.sh status        what is being previewed and where to open it
#   preview.sh stop          stop it
#
# It checks the code out into its own folder (~/codes/pap-preview, never your working copy), starts the dev Cockpit from it on :3201 and
# prints the address. The header says DEV, the branch and the commit, so a preview is never mistaken for prod.
# Reachable from other devices when Tailscale serves :3201 (one-time: tailscale serve --bg --https=8444 3201); otherwise the Mac only.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
[ ! -f "$REPO/.pap-prod" ] || { echo "run preview from your working copy, not from the prod clone ($REPO)" >&2; exit 1; }
DIR="${PREVIEW_DIR:-$HOME/codes/pap-preview}"
PORT="${DEV_COCKPIT_PORT:-3201}"
LOGDIR="$HOME/Library/Logs/pap"; mkdir -p "$LOGDIR"
LOG="$LOGDIR/preview.log"; PIDFILE="$LOGDIR/preview.pid"; LABELFILE="$LOGDIR/preview.label"
HOST="${PREVIEW_HOST:-franks-mac-mini.tailc8c7e9.ts.net}"

url() {
  if command -v tailscale >/dev/null 2>&1 && tailscale serve status 2>/dev/null | grep -q "http://127.0.0.1:$PORT"; then
    port=$(tailscale serve status 2>/dev/null | grep -B1 "127.0.0.1:$PORT" | grep -o ':[0-9]*[ ]*(tailnet' | head -1 | tr -dc 0-9)
    echo "https://$HOST${port:+:$port}"
  else
    echo "http://127.0.0.1:$PORT   (this Mac only; to open it from other devices: tailscale serve --bg --https=8444 $PORT)"
  fi
}
running() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }
stop() {
  if running; then
    pid="$(cat "$PIDFILE")"
    # only ever our own preview: its command line must be the dev server started from the preview folder
    if ps -o command= -p "$pid" | grep -q "dev.sh\|apps/cockpit/src/server.ts"; then pkill -P "$pid" 2>/dev/null || true; kill "$pid" 2>/dev/null || true; fi
  fi
  rm -f "$PIDFILE"
  # anything left listening on the preview port that runs from the preview folder
  for p in $(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null || true); do
    [ "$(lsof -a -p "$p" -d cwd -Fn 2>/dev/null | grep '^n' | cut -c2-)" = "$DIR" ] && kill "$p" 2>/dev/null || true
  done
}

case "${1:-status}" in
  status)
    if running; then echo "previewing: $(git -C "$DIR" log -1 --format='%h %s' 2>/dev/null)  [$(cat "$LABELFILE" 2>/dev/null)]"; echo "open: $(url)"; else echo "no preview running. Start one: npm run preview -- <PR number or branch> [--live]"; fi
    exit 0 ;;
  stop) stop; echo "preview stopped"; exit 0 ;;
esac

what="$1"; shift || true
live=""; [ "${1:-}" = "--live" ] && live="--live"
cd "$REPO"
git fetch -q origin
if [[ "$what" =~ ^[0-9]+$ ]]; then
  git fetch -q origin "pull/$what/head:refs/preview/pr-$what" --force
  ref="refs/preview/pr-$what"; label="PR #$what"
else
  git rev-parse -q --verify "origin/$what" >/dev/null || { echo "no branch origin/$what (did you push it?)" >&2; exit 1; }
  ref="origin/$what"; label="$what"
fi
stop
if [ -d "$DIR/.git" ] || [ -f "$DIR/.git" ]; then git -C "$DIR" checkout -q --detach "$ref"; else git worktree add -q --detach "$DIR" "$ref"; fi
[ -e "$DIR/node_modules" ] || ln -s "$REPO/node_modules" "$DIR/node_modules"
cd "$DIR"
PREVIEW_LABEL="$label" DEV_COCKPIT_PORT="$PORT" nohup bash infra/bin/dev.sh cockpit $live > "$LOG" 2>&1 &
echo $! > "$PIDFILE"; echo "$label" > "$LABELFILE"
for _ in $(seq 1 30); do curl -fs -o /dev/null "http://127.0.0.1:$PORT/api/version" && break; sleep 1; done
curl -fs -o /dev/null "http://127.0.0.1:$PORT/api/version" || { echo "did not start; see $LOG" >&2; exit 1; }
echo "previewing $label ($(git log -1 --format='%h %s' | cut -c1-70)) $([ -n "$live" ] && echo 'on REAL data' || echo 'with fake data')"
echo "open: $(url)"
echo "stop: npm run preview -- stop"
