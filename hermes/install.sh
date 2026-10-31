#!/usr/bin/env bash
# Integrates Portfolio HQ with Hermes WITHOUT touching existing profiles/config/cron.
# It adds: (1) the portfolio-hq skill, (2) a new cron job, (3) a new Ollama-only "personal" profile.
# Dry run by default: prints the commands. Use --apply to execute them.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APPLY=0; [ "${1:-}" = "--apply" ] && APPLY=1
run(){ echo "+ $*"; [ "$APPLY" = 1 ] && "$@" || true; }

SKILL_DIR="${HERMES_HOME:-$HOME/.hermes}/skills/portfolio-hq"
echo "# 1. skill (copied, not linked, so Hermes' curator can manage it)"
run mkdir -p "$SKILL_DIR"
run cp "$HERE/skills/portfolio-hq/SKILL.md" "$SKILL_DIR/SKILL.md"

echo "# 2. morning brief cron (08:00 local) delivered to Telegram — adjust --deliver to your chat"
run hermes cron create "0 8 * * *" "$(cat "$HERE/cron/morning-brief.md")" \
  --name portfolio-morning-brief --skill portfolio-hq --deliver telegram

echo "# 3. Ollama-only profile for money questions. Created WITHOUT --clone so no cloud keys are copied."
run hermes profile create personal --no-skills --description "Local-only (Ollama) assistant for personal finance questions"
cat <<'MSG'

Next, manually (interactive, needs your input):
  hermes -p personal model        # choose provider = ollama, model = your local Qwen/Gemma
  hermes -p personal gateway ...  # give it its OWN Telegram bot token (two profiles must not share one)
Confirm with:  hermes -p personal config   # no cloud provider keys present
MSG
[ "$APPLY" = 1 ] || echo "(dry run — re-run with --apply)"
