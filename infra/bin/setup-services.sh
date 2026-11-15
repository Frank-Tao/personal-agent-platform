#!/usr/bin/env bash
# Create ~/services: a prod clone of each service (Cockpit and the Utility Portal), their data, and the launchd jobs that run them.
# Run from your working copy (dev). Safe to run again: it only fills in what is missing and re-syncs data.
#
#   setup-services.sh             dry run: prints every step
#   setup-services.sh --apply
#
# Layout:
#   ~/services/personal-agent-platform/   prod clone of main (marked .pap-prod; its own infra/env; never edited by hand)
#   ~/services/utility-portal/            prod clone of the portal's main
#   ~/services/data/personal-agent-platform/   database, audit log, feedback, ledgers, and the roster / repo list / privacy allow-list
#   ~/services/data/utility-portal/            the portal's projects
# Your working copies under ~/codes stay as they are: that is dev (infra/bin/dev.sh).
set -euo pipefail
DEV="$(cd "$(dirname "$0")/../.." && pwd)"
APPLY=0; [ "${1:-}" = "--apply" ] && APPLY=1
SERVICES="${PAP_SERVICES:-$HOME/services}"
PROD="$SERVICES/personal-agent-platform"; PORTAL_PROD="$SERVICES/utility-portal"
DATA="$SERVICES/data/personal-agent-platform"; PDATA="$SERVICES/data/utility-portal"
PORTAL_DEV="${PORTAL_DEV_DIR:-$HOME/codes/utility-portal}"
UID_="$(id -u)"

step() { printf '\n== %s\n' "$*"; }
run()  { if [ "$APPLY" = 1 ]; then "$@"; else printf '   would run: %s\n' "$*"; fi; }
die()  { echo "✗ $*" >&2; exit 1; }

[ ! -f "$DEV/.pap-prod" ] || die "run this from your working copy, not from the prod clone"
git -C "$DEV" rev-parse --git-dir >/dev/null 2>&1 || die "$DEV is not a git repository (is git working? sudo xcodebuild -license accept)"
PLAT_URL="$(git -C "$DEV" remote get-url origin)"
PORT_URL="$(git -C "$PORTAL_DEV" remote get-url origin 2>/dev/null)" || die "no git remote on $PORTAL_DEV"
git ls-remote --exit-code "$PLAT_URL" main >/dev/null 2>&1 || die "cannot read main from $PLAT_URL (credentials?)"
git ls-remote --exit-code "$PORT_URL" main >/dev/null 2>&1 || die "cannot read main from $PORT_URL (credentials?)"
echo "platform: $PLAT_URL → $PROD"; echo "portal:   $PORT_URL → $PORTAL_PROD"; echo "data:     $DATA , $PDATA"
[ "$APPLY" = 1 ] || echo "(dry run)"

step "1. backup first"
run "$DEV/infra/bin/backup.sh"

step "2. prod clones of main"
run mkdir -p "$SERVICES" "$DATA/config" "$PDATA"
clone() {   # clone <url> <dir>
  if [ -d "$2/.git" ]; then echo "   $2 exists"; run git -C "$2" fetch -q origin main
  else run git clone -q --branch main "$1" "$2"; fi
  run touch "$2/.pap-prod"
}
clone "$PLAT_URL" "$PROD"
clone "$PORT_URL" "$PORTAL_PROD"
run git -C "$PROD" config core.hooksPath .githooks            # the versioned post-merge hook deploys after a manual pull
if [ "$APPLY" = 1 ]; then
  cat > "$PORTAL_PROD/.git/hooks/post-merge" <<HOOK
#!/usr/bin/env bash
# After a manual pull in the portal's prod clone: deploy it (check, restart, roll back if it does not answer).
[ -z "\${PAP_DEPLOYING:-}" ] || exit 0
exec "$PROD/infra/bin/deploy.sh" utility-portal --after-merge
HOOK
  chmod +x "$PORTAL_PROD/.git/hooks/post-merge"
else echo "   would write $PORTAL_PROD/.git/hooks/post-merge"; fi

step "3. dependencies and this install's environment"
if [ "$APPLY" = 1 ]; then
  ( cd "$PROD" && npm ci --ignore-scripts --silent )
  [ -f "$PROD/infra/env" ] || cp "$DEV/infra/env" "$PROD/infra/env"
  grep -vE '^(PAP_ENV|PAP_DATA_DIR)=' "$PROD/infra/env" > "$PROD/infra/env.tmp" || true
  printf 'PAP_ENV=prod\nPAP_DATA_DIR=%s\n' "$DATA" >> "$PROD/infra/env.tmp"
  mv "$PROD/infra/env.tmp" "$PROD/infra/env"; chmod 600 "$PROD/infra/env"
else echo "   would: npm ci in the prod clone; write $PROD/infra/env (copy of dev's, plus PAP_ENV=prod, PAP_DATA_DIR=$DATA)"; fi

sync_data() {
  # state files; the database is copied separately with sqlite's own backup so it is consistent
  run rsync -a --exclude='*.sqlite' --exclude='*.sqlite-*' --exclude='work-show-cache.json*' --exclude='.deploy-*' "$DEV/data/" "$DATA/"
  for f in agents projects privacy; do
    if [ -f "$DEV/config/$f.json" ] && [ ! -f "$DATA/config/$f.json" ]; then run cp "$DEV/config/$f.json" "$DATA/config/$f.json"; fi
  done
  [ -d "$PORTAL_DEV/data" ] && run rsync -a "$PORTAL_DEV/data/" "$PDATA/"
  if [ -f "$DEV/data/cockpit.sqlite" ]; then run sqlite3 "$DEV/data/cockpit.sqlite" ".backup '$DATA/cockpit.sqlite'"; fi
  return 0
}
step "4. copy the data (services still running; repeated after they stop)"
sync_data

step "5. cut over: stop the old jobs, copy what changed, start the prod ones"
if [ "$APPLY" = 1 ]; then
  for j in cockpit private-pipeline utility-portal; do launchctl bootout "gui/$UID_/com.franktao.pap.$j" 2>/dev/null || true; done
  sleep 1
  sync_data
  "$PROD/infra/bin/install-launchd.sh" --apply installed deploy utility-portal   # the jobs you already have, plus the checker and the portal
  ok=0
  for i in $(seq 1 60); do
    if curl -fsS -m 2 -o /dev/null http://127.0.0.1:3200/healthz 2>/dev/null && curl -fsS -m 2 -o /dev/null http://127.0.0.1:8888/ 2>/dev/null; then ok=1; break; fi
    sleep 1
  done
  if [ "$ok" = 1 ]; then echo "   ✓ Cockpit :3200 and the portal :8888 answer from $SERVICES"
  else
    echo "   ✗ they did not answer: putting the old jobs back (they point at $DEV again)" >&2
    "$DEV/infra/bin/install-launchd.sh" --apply cockpit private-pipeline utility-portal || true   # (dev paths again)
    die "cut over failed and was undone; look at ~/Library/Logs/pap/*.error.log"
  fi
else echo "   would: stop cockpit, private-pipeline, utility-portal; re-sync; re-render your installed jobs + deploy + utility-portal to point at prod; check :3200 and :8888; undo if they do not answer"; fi

step "6. agent skills: tell Hermes agents to run the CLIs from prod"
patch_skill() {
  sed -i '' -e 's#~/codes/personal-agent-platform/config/agents.json#~/services/data/personal-agent-platform/config/agents.json#g' \
            -e 's#~/codes/personal-agent-platform#~/services/personal-agent-platform#g' "$1"
}
if [ "$APPLY" = 1 ]; then
  n=0
  for f in "$HOME"/.hermes/skills/*/SKILL.md "$HOME"/.hermes/profiles/*/skills/*/SKILL.md; do
    [ -f "$f" ] && grep -q '~/codes/personal-agent-platform' "$f" || continue
    patch_skill "$f"; n=$((n+1))
  done
  echo "   patched $n installed skill file(s)"
else echo "   would patch ~/codes/personal-agent-platform → ~/services/personal-agent-platform in the installed Hermes skills"; fi

echo; echo "done. prod: http://127.0.0.1:3200 and :8888 · dev: npm run cockpit:dev (:3201), npm run portal:dev (:8889)"
