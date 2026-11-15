#!/usr/bin/env bash
# Nightly backup: Cockpit db, KB repos, Hermes home (memory, skills, kanban boards). Run by launchd (com.franktao.pap.backup, 03:10).
# Every step is checked and the result is written to data/backup-status.json, which Cockpit reads: a failed or missing backup
# shows up in Needs-you instead of passing silently. Also trims the launchd logs, which nothing else rotates.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
ROOT="${BACKUP_DIR:-$HOME/Backups/pap}"
DEST="$ROOT/$(date +%F)"
# Runtime state: PAP_DATA_DIR in prod (environment, then infra/env), <repo>/data in dev.
DATA="${PAP_DATA_DIR:-}"
[ -n "$DATA" ] || DATA="$(sed -n 's/^PAP_DATA_DIR=//p' "$REPO/infra/env" 2>/dev/null | tail -1 | tr -d "\"'")"
DATA="${DATA/#\~/$HOME}"; DATA="${DATA:-$REPO/data}"
STATUS="${BACKUP_STATUS:-$DATA/backup-status.json}"
KB="${PORTFOLIO_KB:-$HOME/PortfolioKB}"
HERMES="${HERMES_BIN:-$HOME/.local/bin/hermes}"
LOGS="${PAP_LOGS:-$HOME/Library/Logs/pap}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
mkdir -p "$DEST" "$(dirname "$STATUS")"

steps=""; failed=0
step() { # step <name> <ok|failed|skipped> <detail>
  [ "$2" = failed ] && failed=1
  steps="$steps${steps:+,}{\"name\":\"$1\",\"result\":\"$2\",\"detail\":\"$(printf '%s' "$3" | tr -d '"\\' | tr '\n' ' ' | cut -c1-160)\"}"
  echo "$1: $2 $3"
}

if [ -f "$DATA/cockpit.sqlite" ]; then
  if err=$(sqlite3 "$DATA/cockpit.sqlite" ".backup '$DEST/cockpit.sqlite'" 2>&1); then step cockpit-db ok "$(du -h "$DEST/cockpit.sqlite" | cut -f1 | tr -d ' ')"; else step cockpit-db failed "$err"; fi
else step cockpit-db skipped "no database yet"; fi

if [ -f "$DATA/audit.jsonl" ]; then
  if err=$(cp "$DATA/audit.jsonl" "$DEST/audit.jsonl" 2>&1); then step audit-log ok "$(du -h "$DEST/audit.jsonl" | cut -f1 | tr -d ' ')"; else step audit-log failed "$err"; fi
fi

if [ -d "$DATA" ]; then
  if err=$(tar -C "$DATA" -czf "$DEST/pap-state.tgz" --exclude='*.sqlite' --exclude='*.sqlite-*' --exclude='work-show-cache.json*' . 2>&1); then step pap-state ok "$(du -h "$DEST/pap-state.tgz" | cut -f1 | tr -d ' ')"; else step pap-state failed "$err"; fi
fi

if [ -d "$KB" ]; then
  if err=$(tar -C "$(dirname "$KB")" -czf "$DEST/portfolio-kb.tgz" "$(basename "$KB")" 2>&1); then step portfolio-kb ok "$(du -h "$DEST/portfolio-kb.tgz" | cut -f1 | tr -d ' ')"; else step portfolio-kb failed "$err"; fi
else step portfolio-kb skipped "no $KB"; fi

# Hermes: what cannot be recreated (agent memory and prompts, cron jobs, config, the kanban boards). Not `hermes backup`: the full
# archive is tens of GB here, and `hermes backup -q` only makes a snapshot inside ~/.hermes, which is no use if that folder is lost.
# Secrets (.env, auth) are deliberately left out.
HH="${HERMES_HOME:-$HOME/.hermes}"
if [ -d "$HH" ]; then
  list="$DEST/.hermes-files"
  ( cd "$HH" && { ls -d memories SOUL.md config.yaml cron skills/*/SKILL.md 2>/dev/null; ls -d profiles/*/memories profiles/*/SOUL.md profiles/*/config.yaml 2>/dev/null; } ) > "$list"
  if [ -s "$list" ] && err=$(tar -C "$HH" -czf "$DEST/hermes-state.tgz" -T "$list" 2>&1); then step hermes-state ok "$(du -h "$DEST/hermes-state.tgz" | cut -f1 | tr -d ' ')"; else step hermes-state failed "${err:-nothing to archive in $HH}"; fi
  rm -f "$list"
  n=0; bad=""
  for db in "$HH"/kanban/boards/*/kanban.db; do
    [ -f "$db" ] || continue
    b="$(basename "$(dirname "$db")")"; mkdir -p "$DEST/boards"
    if sqlite3 "$db" ".backup '$DEST/boards/$b.db'" 2>/dev/null; then n=$((n+1)); else bad="$bad $b"; fi
  done
  if [ -n "$bad" ]; then step hermes-boards failed "could not copy:$bad"; elif [ $n -gt 0 ]; then step hermes-boards ok "$n boards, $(du -sh "$DEST/boards" | cut -f1 | tr -d ' ')"; else step hermes-boards skipped "no boards"; fi
  if [ -x "$HERMES" ]; then "$HERMES" backup -q >/dev/null 2>&1 || true; fi   # Hermes' own quick snapshot, kept inside ~/.hermes: a convenience, not counted
else step hermes-state skipped "no $HH"; fi

# Old backups: dated folders only (YYYY-MM-DD), so anything else kept there by hand is left alone.
find "$ROOT" -mindepth 1 -maxdepth 1 -type d -name '20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]' -mtime +"$KEEP_DAYS" -exec rm -rf {} + 2>/dev/null

# Logs: launchd keeps the files open, so copy then truncate in place; one previous copy is kept.
if [ -d "$LOGS" ]; then
  for f in "$LOGS"/*.log; do
    [ -f "$f" ] || continue
    if [ "$(stat -f%z "$f" 2>/dev/null || echo 0)" -gt 5242880 ]; then cp "$f" "$f.1" && : > "$f"; fi
  done
fi

printf '{"at":"%s","ok":%s,"dest":"%s","steps":[%s]}\n' "$(date -u +%FT%TZ)" "$([ $failed = 0 ] && echo true || echo false)" "$DEST" "$steps" > "$STATUS.tmp" && mv "$STATUS.tmp" "$STATUS"
echo "backup -> $DEST ($([ $failed = 0 ] && echo ok || echo FAILED))"
exit $failed
