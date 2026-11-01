#!/usr/bin/env bash
# Worker lanes: one contract for every model CLI, so any orchestrator (Hermes today) can call them.
#
#   lanes/lane.sh <lane> <workdir> <prompt-file> <out-dir>
#   lane = claude | codex | opencode-zen | openrouter | openai | ollama
#
# Writes <out-dir>/result.md (final answer), <out-dir>/log.txt (full CLI output) and
# <out-dir>/meta.json; exits with the CLI's status. The lane's output is input for the
# orchestrator to verify (diff, tests) — never a completion signal on its own.
#
#   claude, codex   subscription CLIs: may edit files in <workdir> (use a worktree)
#   opencode-zen,   API models reached through the `opencode` CLI in its read-only `plan` agent: they
#   openrouter,     return text (writing, research, review) and never edit files or run commands
#   openai
#   ollama          local only, no tools; the only lane allowed to see private data
#
# Credentials stay in each CLI's own store; nothing here reads them. Default model per lane:
# lanes/models.conf (override one run with LANE_MODEL=...).
set -euo pipefail

usage(){ echo "usage: $0 <claude|codex|opencode-zen|openrouter|openai|ollama> <workdir> <prompt-file> <out-dir>" >&2; exit 2; }
[ $# -eq 4 ] || usage
LANE="$1"; WORKDIR="$(cd "$2" && pwd)"; PROMPT="$3"; OUT="$4"
[ -f "$PROMPT" ] || { echo "prompt file not found: $PROMPT" >&2; exit 2; }
PROMPT="$(cd "$(dirname "$PROMPT")" && pwd)/$(basename "$PROMPT")"
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
HERE="$(cd "$(dirname "$0")" && pwd)"

# Privacy boundary (PR1/PR3): raw financial data never goes to a cloud lane.
PRIV="${PRIVATE_DIR:-$HOME/Private}"
if [ "$LANE" != ollama ]; then
  case "$WORKDIR/" in "$PRIV"/*) echo "refused: $WORKDIR is private; use the ollama lane" >&2; exit 3 ;; esac
  # ~/PrivateSummaries (the PII-gated summary layer) is fine; ~/Private itself is not.
  if grep -qE "(^|[^[:alnum:]_])(~|\\\$HOME|$HOME)/Private(/|[[:space:]]|$)" "$PROMPT"; then
    echo "refused: prompt references the private inbox; use the ollama lane" >&2; exit 3
  fi
fi

# Default model for this lane from models.conf, unless LANE_MODEL overrides it.
conf(){ [ -f "$HERE/models.conf" ] && sed -n "s/^$1=//p" "$HERE/models.conf" | head -1 || true; }
case "$LANE" in
  claude) DEFAULT_MODEL="$(conf LANE_MODEL_CLAUDE)" ;;
  codex) DEFAULT_MODEL="$(conf LANE_MODEL_CODEX)" ;;
  opencode-zen) DEFAULT_MODEL="$(conf LANE_MODEL_OPENCODE_ZEN)" ;;
  openrouter) DEFAULT_MODEL="$(conf LANE_MODEL_OPENROUTER)" ;;
  openai) DEFAULT_MODEL="$(conf LANE_MODEL_OPENAI)" ;;
  ollama) DEFAULT_MODEL="${PRIVATE_MODEL:-$(conf LANE_MODEL_OLLAMA)}" ;;
  *) usage ;;
esac
MODEL="${LANE_MODEL:-$DEFAULT_MODEL}"

# opencode prints ANSI colour and a "> agent · model" header; keep only the answer.
oc_clean(){ perl -pe 's/\e\[[0-9;]*m//g' | awk 'BEGIN{h=0} h==0 && /^> .* · /{h=1; next} h==0 && /^[[:space:]]*$/{next} {h=1; print}'; }

# A hung model must not hang the caller (macOS has no `timeout`): the child is killed after LANE_TIMEOUT s.
LANE_TIMEOUT="${LANE_TIMEOUT:-1800}"
tmo(){ perl -e 'alarm shift @ARGV; exec @ARGV or die "exec: $!"' "$LANE_TIMEOUT" "$@"; }

STARTED="$(date -u +%FT%TZ)"
set +e
case "$LANE" in
  claude)
    # Edits allowed; shell/network tools only if the caller opts in via LANE_ALLOWED_TOOLS.
    (cd "$WORKDIR" && tmo claude --print --permission-mode acceptEdits \
      ${LANE_ALLOWED_TOOLS:+--allowedTools "$LANE_ALLOWED_TOOLS"} \
      ${MODEL:+--model "$MODEL"} < "$PROMPT") > "$OUT/log.txt" 2>&1
    STATUS=$?; cp "$OUT/log.txt" "$OUT/result.md" ;;
  codex)
    tmo codex exec --cd "$WORKDIR" --sandbox workspace-write --skip-git-repo-check \
      ${MODEL:+-m "$MODEL"} --output-last-message "$OUT/result.md" - < "$PROMPT" > "$OUT/log.txt" 2>&1
    STATUS=$? ;;
  opencode-zen|openrouter|openai)
    [ -n "$MODEL" ] || { echo "no model for lane $LANE: set LANE_MODEL_* in lanes/models.conf" >&2; exit 2; }
    (cd "$WORKDIR" && tmo opencode run --agent plan -m "$MODEL" "$(cat "$PROMPT")") > "$OUT/raw.txt" 2>&1
    STATUS=$?
    oc_clean < "$OUT/raw.txt" > "$OUT/result.md"; cp "$OUT/raw.txt" "$OUT/log.txt"; rm -f "$OUT/raw.txt" ;;
  ollama)
    # Local only, no tools: text in, text out.
    tmo ollama run "$MODEL" < "$PROMPT" > "$OUT/result.md" 2> "$OUT/log.txt"
    STATUS=$? ;;
esac
set -e

# A zero exit with no answer is a failed run (free models sometimes return nothing): never report it as success.
EMPTY_NOTE=""
if [ "$STATUS" -eq 142 ]; then EMPTY_NOTE="timed out after ${LANE_TIMEOUT}s (LANE_TIMEOUT)"; fi
if [ "$STATUS" -eq 0 ] && ! grep -q '[^[:space:]]' "$OUT/result.md" 2>/dev/null; then
  STATUS=1; EMPTY_NOTE="empty response from the model (exit 0 but no answer)"
fi

# Ledger line per real run (a privacy refusal exits earlier and is not a run). Cockpit reads this to show
# each lane's recent runs, failures and last model. On failure the best-matching log line is kept (<=160 chars).
LEDGER="${LANE_LEDGER:-$(cd "$HERE/.." && pwd)/data/lanes.jsonl}"
NOTE="$EMPTY_NOTE"
if [ "$STATUS" -ne 0 ] && [ -z "$NOTE" ]; then
  # Most specific reason first (limit, then auth, then a message field), then any error line. Never the whole log.
  for pat in 'usage limit|quota|rate limit' 'not logged in|unauthorized|error authenticating|ineligible|permission denied' '"message"|unexpected|not found' 'error|denied|failed'; do
    NOTE="$(perl -pe 's/\e\[[0-9;]*m//g' "$OUT/log.txt" 2>/dev/null | grep -v '^[[:space:]]*$' | grep -E -i "$pat" | head -1 | tr -d '"\\' | cut -c1-160 || true)"
    [ -z "$NOTE" ] || break
  done
fi
mkdir -p "$(dirname "$LEDGER")" 2>/dev/null && printf '{"lane":"%s","model":"%s","status":%s,"startedAt":"%s","endedAt":"%s","note":"%s"}\n' \
  "$LANE" "$MODEL" "$STATUS" "$STARTED" "$(date -u +%FT%TZ)" "$NOTE" >> "$LEDGER" 2>/dev/null || true

cat > "$OUT/meta.json" <<JSON
{"lane":"$LANE","model":"$MODEL","workdir":"$WORKDIR","status":$STATUS,"startedAt":"$STARTED","endedAt":"$(date -u +%FT%TZ)"}
JSON
exit "$STATUS"
