#!/usr/bin/env bash
# Deploy: bring a prod clone up to origin/main, safely.
#
#   deploy.sh [platform|utility-portal|all] [--force] [--after-merge] [--quiet]
#
# Run by launchd every few minutes (com.franktao.pap.deploy) and by the post-merge hook after a manual `git pull` in the prod clone.
# For each target:
#   1. fetch origin/main; nothing new = nothing to do (a failed commit is not retried until main moves on, or --force)
#   2. check the new commit in a scratch copy (type check + tests; for the portal, a syntax check). The live files are not touched.
#   3. only if that passes: fast-forward the prod clone, restart the service (not for docs-only changes)
#   4. wait for the service to answer; if it does not, put the previous version back and restart again
#   5. write data/deploy-status-<target>.json; Cockpit shows a failure in Needs-you
# `--after-merge` is for the git hook: the merge already happened, so the new code is checked in place and undone if it fails.
# A prod clone is marked by a .pap-prod file; this script refuses to touch anything else, so it cannot deploy over a working copy.
#
# Whole script lives in functions and ends with `main "$@"; exit`, so bash has read all of it before the first line runs:
# a deploy that updates this very file cannot corrupt itself half way.
set -uo pipefail

SELF="$(cd "$(dirname "$0")/../.." && pwd)"   # the platform clone this script belongs to
FORCE=0; AFTER=0; QUIET=0

log() { printf '%s %s\n' "$(date '+%F %T')" "$*"; }
say() { [ "$QUIET" = 1 ] || log "$@"; }

# PAP_DATA_DIR: environment first, then infra/env (same rule as the code), else <repo>/data.
data_dir() {
  local d="${PAP_DATA_DIR:-}"
  [ -n "$d" ] || d="$(sed -n 's/^PAP_DATA_DIR=//p' "$SELF/infra/env" 2>/dev/null | tail -1 | tr -d "\"'")"
  d="${d/#\~/$HOME}"
  printf '%s' "${d:-$SELF/data}"
}

env_value() { sed -n "s/^$1=//p" "$SELF/infra/env" 2>/dev/null | tail -1 | tr -d "\"'"; }

json_text() { printf '%s' "$1" | tr -d '"\\' | tr '\n\r\t' '   ' | cut -c1-220; }

write_status() {   # write_status <ok true|false> <from> <to> <message> <failedSha or "">
  local f="$DATA/deploy-status-$NAME.json" failed="null"
  [ -z "$5" ] || failed="\"$5\""
  printf '{"target":"%s","at":"%s","ok":%s,"from":"%s","to":"%s","message":"%s","failedSha":%s}\n' \
    "$NAME" "$(date -u +%FT%TZ)" "$1" "$2" "$3" "$(json_text "$4")" "$failed" > "$f.tmp" && mv "$f.tmp" "$f"
}

failed_sha() { sed -n 's/.*"failedSha":"\([0-9a-f]*\)".*/\1/p' "$DATA/deploy-status-$NAME.json" 2>/dev/null | head -1; }

restart_label() {
  if [ -n "${DEPLOY_RESTART_CMD:-}" ]; then $DEPLOY_RESTART_CMD "$1"; else launchctl kickstart -k "gui/$(id -u)/$1" >/dev/null 2>&1; fi
}

wait_healthy() {
  local i
  for i in $(seq 1 "${DEPLOY_HEALTH_TRIES:-45}"); do
    if [ -n "${DEPLOY_HEALTH_CMD:-}" ]; then bash -c "$DEPLOY_HEALTH_CMD" >/dev/null 2>&1 && return 0
    else curl -fsS -m 2 -o /dev/null "$HEALTH" 2>/dev/null && return 0; fi
    sleep "${DEPLOY_HEALTH_SLEEP:-1}"
  done
  return 1
}

# Check a commit in `$1` (a directory with that commit checked out). Sets VERIFY_MSG on failure.
verify() {
  local d="$1" tmp rc
  VERIFY_MSG=""
  if [ -n "${DEPLOY_VERIFY_CMD:-}" ]; then
    ( cd "$d" && bash -c "$DEPLOY_VERIFY_CMD" ) >"$LOGF" 2>&1 && return 0
    VERIFY_MSG="verification failed: $(tail -1 "$LOGF")"; return 1
  fi
  case "$NAME" in
    platform)
      tmp="$(mktemp -d)"   # the tests get a throw-away data folder, never prod's
      ( cd "$d" && PAP_DATA_DIR="$tmp" npm run --silent check ) >"$LOGF" 2>&1 || { VERIFY_MSG="type check failed ($(grep -c 'error TS' "$LOGF") errors)"; rm -rf "$tmp"; return 1; }
      ( cd "$d" && PAP_DATA_DIR="$tmp" npm test --silent ) >"$LOGF" 2>&1; rc=$?
      rm -rf "$tmp"
      [ $rc -eq 0 ] || { VERIFY_MSG="tests failed ($(sed -n 's/^ℹ fail //p' "$LOGF" | tail -1) failing)"; return 1; }
      ;;
    utility-portal)
      ( cd "$d" && "${PYTHON:-/opt/homebrew/bin/python3}" -m py_compile server.py voicebox_tts.py ) >"$LOGF" 2>&1 || { VERIFY_MSG="syntax check failed: $(tail -1 "$LOGF")"; return 1; }
      ;;
  esac
  return 0
}

needs_restart() { git -C "$DIR" diff --name-only "$1" "$2" | grep -vE '^(docs/|README|requirement\.md|solution\.md|implement_plan\.md|learning-roi|kb-template/|\.githooks/|\.gitignore|hermes/skills/)|\.test\.ts$' | grep -q .; }
changed() { git -C "$DIR" diff --name-only "$1" "$2" | grep -qE "$3"; }

restart_all() {
  local l
  if [ "$NAME" = platform ] && changed "$1" "$2" '^infra/(launchd/|bin/install-launchd\.sh)'; then
    # A job definition changed: render and reload every job except this checker (reloading it would kill this very run).
    if [ -n "${DEPLOY_RELOAD_CMD:-}" ]; then bash -c "$DEPLOY_RELOAD_CMD"; else "$DIR/infra/bin/install-launchd.sh" --apply cockpit private-pipeline work-watch growth feedback-weekly backup utility-portal >/dev/null 2>&1; fi
    changed "$1" "$2" '^infra/launchd/com\.franktao\.pap\.deploy' && log "$NAME: the deploy job's own definition changed; run infra/bin/install-launchd.sh --apply deploy to load it"
    return
  fi
  for l in $LABELS; do restart_label "$l"; done
}

deploy_inner() {
  local from to stage="" lock_changed=0 verified_in=""
  LOGF="$DATA/.deploy-$NAME.log"
  from="$(git -C "$DIR" rev-parse --short HEAD)"

  if [ "$AFTER" = 1 ]; then
    # The hook: the merge is done. FROM is where we were before it.
    local prev; prev="$(git -C "$DIR" rev-parse --short ORIG_HEAD 2>/dev/null || git -C "$DIR" rev-parse --short 'HEAD@{1}' 2>/dev/null || echo "$from")"
    to="$from"; from="$prev"
    [ "$from" != "$to" ] || { say "$NAME: nothing changed"; return 0; }
    log "$NAME: $from -> $to merged by hand; checking it in place"
    if ! verify "$DIR"; then
      git -C "$DIR" reset -q --hard "$from"
      log "$NAME: $VERIFY_MSG; put $from back"
      write_status false "$from" "$to" "$VERIFY_MSG (put $from back)" "$to"
      return 1
    fi
  else
    git -C "$DIR" fetch -q origin main 2>>"$LOGF" || { log "$NAME: cannot reach origin (no heartbeat)"; return 0; }
    touch "$DATA/deploy-heartbeat-$NAME"
    to="$(git -C "$DIR" rev-parse --short origin/main)"
    if [ "$from" = "$to" ] && [ "$FORCE" = 0 ]; then say "$NAME: up to date at $to"; return 0; fi
    if [ "$FORCE" = 0 ] && [ "$(failed_sha)" = "$to" ]; then say "$NAME: $to already failed; waiting for a newer commit (or --force)"; return 0; fi
    if [ -n "$(git -C "$DIR" status --porcelain --untracked-files=no)" ]; then
      log "$NAME: the prod clone has local changes; not deploying"
      write_status false "$from" "$to" "the prod clone has local changes (git -C $DIR status)" ""
      return 1
    fi
    if [ "$from" != "$to" ] && ! git -C "$DIR" merge-base --is-ancestor "$from" "origin/main"; then
      log "$NAME: $from is not an ancestor of origin/main"
      write_status false "$from" "$to" "prod has commits that are not on main, so it cannot be fast-forwarded" "$to"
      return 1
    fi
    log "$NAME: $from -> $to; checking it in a scratch copy"
    stage="$SERVICES/.staging-$NAME"
    git -C "$DIR" worktree remove --force "$stage" >/dev/null 2>&1; rm -rf "$stage"; git -C "$DIR" worktree prune
    git -C "$DIR" worktree add -q --detach "$stage" "origin/main" >>"$LOGF" 2>&1 || { write_status false "$from" "$to" "could not create the scratch copy" ""; return 1; }
    if [ "$NAME" = platform ] && [ -f "$stage/package-lock.json" ]; then
      if git -C "$DIR" diff --quiet "$from" "origin/main" -- package-lock.json 2>/dev/null && [ -d "$DIR/node_modules" ]; then ln -s "$DIR/node_modules" "$stage/node_modules"
      else lock_changed=1; ( cd "$stage" && npm ci --ignore-scripts --silent ) >>"$LOGF" 2>&1 || { git -C "$DIR" worktree remove --force "$stage" >/dev/null 2>&1; write_status false "$from" "$to" "npm ci failed" "$to"; return 1; }; fi
    fi
    verify "$stage"; local ok=$?
    git -C "$DIR" worktree remove --force "$stage" >/dev/null 2>&1; rm -rf "$stage"; git -C "$DIR" worktree prune
    if [ $ok -ne 0 ]; then
      log "$NAME: $VERIFY_MSG; prod stays on $from"
      write_status false "$from" "$to" "$VERIFY_MSG" "$to"
      return 1
    fi
    if [ "$from" != "$to" ]; then
      PAP_DEPLOYING=1 git -C "$DIR" merge -q --ff-only "origin/main" >>"$LOGF" 2>&1 || { write_status false "$from" "$to" "fast-forward failed" "$to"; return 1; }
    fi
    [ "$lock_changed" = 0 ] || ( cd "$DIR" && npm ci --ignore-scripts --silent ) >>"$LOGF" 2>&1
  fi

  # Restart unless only documentation changed.
  if [ "$from" != "$to" ] && [ "$FORCE" = 0 ] && ! needs_restart "$from" "$to"; then
    log "$NAME: $from -> $to deployed; documentation only, no restart"
    write_status true "$from" "$to" "deployed, no restart needed (documentation only)" ""
    return 0
  fi
  log "$NAME: restarting ($LABELS)"
  restart_all "$from" "$to"
  if wait_healthy; then
    log "$NAME: $to is up"
    write_status true "$from" "$to" "deployed and restarted" ""
    return 0
  fi
  # Unhealthy: put the previous version back.
  log "$NAME: not answering after the restart; putting $from back"
  git -C "$DIR" reset -q --hard "$from"
  [ "$lock_changed" = 0 ] || ( cd "$DIR" && npm ci --ignore-scripts --silent ) >>"$LOGF" 2>&1
  restart_all "$to" "$from"
  wait_healthy && log "$NAME: $from is up again" || log "$NAME: $from did not come up either; look at the service log"
  write_status false "$from" "$to" "the service did not answer after the restart; rolled back to $from" "$to"
  return 1
}

deploy_target() {
  NAME="$1"
  case "$NAME" in
    platform)
      DIR="$SELF"; LABELS="${DEPLOY_PLATFORM_LABELS:-com.franktao.pap.cockpit com.franktao.pap.private-pipeline}"
      HEALTH="${DEPLOY_PLATFORM_HEALTH:-http://127.0.0.1:$(env_value COCKPIT_PORT | grep . || echo 3200)/healthz}" ;;
    utility-portal)
      DIR="${PORTAL_PROD_DIR:-$SERVICES/utility-portal}"; LABELS="com.franktao.pap.utility-portal"
      HEALTH="${DEPLOY_PORTAL_HEALTH:-http://127.0.0.1:8888/}" ;;
    *) log "unknown target $NAME"; return 2 ;;
  esac
  [ -d "$DIR/.git" ] || { log "$NAME: no clone at $DIR (run infra/bin/setup-services.sh)"; return 1; }
  [ -f "$DIR/.pap-prod" ] || { log "$NAME: $DIR is not a prod clone (no .pap-prod file); refusing to touch it"; return 1; }
  local lock="$DATA/.deploy-$NAME.lock" rc
  if ! mkdir "$lock" 2>/dev/null; then
    if [ -n "$(find "$lock" -maxdepth 0 -mmin +20 2>/dev/null)" ]; then rm -rf "$lock"; mkdir "$lock" 2>/dev/null || return 0
    else say "$NAME: another deploy is running"; return 0; fi
  fi
  deploy_inner; rc=$?
  rm -rf "$lock"
  return $rc
}

main() {
  local targets=() a rc=0
  for a in "$@"; do
    case "$a" in
      --force) FORCE=1 ;; --after-merge) AFTER=1 ;; --quiet) QUIET=1 ;;
      platform|utility-portal) targets+=("$a") ;;
      all) targets=(platform utility-portal) ;;
      -h|--help) sed -n '2,19p' "$0"; return 0 ;;
      *) echo "unknown argument: $a (see --help)" >&2; return 2 ;;
    esac
  done
  [ ${#targets[@]} -gt 0 ] || targets=(platform)
  SERVICES="$(dirname "$SELF")"
  DATA="$(data_dir)"; mkdir -p "$DATA"
  for a in "${targets[@]}"; do deploy_target "$a" || rc=1; done
  return $rc
}

main "$@"; exit $?
