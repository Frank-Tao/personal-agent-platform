#!/usr/bin/env bash
# Makes Hermes the backbone ("Atlas": chat, kanban, cron) WITHOUT touching other profiles or cron jobs.
# It adds: (1) the cockpit + agent-lanes + agent-roster + agent-staffing + portfolio-planning + privacy-handoff + agent-growth skills (agent-growth also into every profile) (and project-planning into the pm profile), (2) one kanban board per section, (3) kanban tools in
# Telegram chats, (4) the Atlas persona, (5) approval for self-written skills, (6) the morning-brief cron,
# (7) an Ollama-only "personal" profile.
# Dry run by default: prints the commands. Use --apply to execute them.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APPLY=0; [ "${1:-}" = "--apply" ] && APPLY=1
run(){ echo "+ $*"; [ "$APPLY" = 1 ] && "$@" || true; }

echo "# 1. skills (copied, not linked, so Hermes' curator can manage them)"
for s in cockpit agent-lanes agent-roster agent-staffing portfolio-planning privacy-handoff agent-growth; do
  run mkdir -p "${HERMES_HOME:-$HOME/.hermes}/skills/$s"
  run cp "$HERE/skills/$s/SKILL.md" "${HERMES_HOME:-$HOME/.hermes}/skills/$s/SKILL.md"
done

# agent-growth goes to every roster agent's profile (not the privacy agent, not profiles that belong to other people)
for p in $(node -e "console.log(JSON.parse(require('fs').readFileSync('$HERE/../config/agents.json','utf8')).agents.filter(a=>a.id!=='personal'&&a.profile!=='default').map(a=>a.profile).join(' '))"); do
  prof="${HERMES_HOME:-$HOME/.hermes}/profiles/$p"
  [ -d "$prof/skills" ] || continue
  run mkdir -p "$prof/skills/agent-growth"
  run cp "$HERE/skills/agent-growth/SKILL.md" "$prof/skills/agent-growth/SKILL.md"
done
if [ -d "${HERMES_HOME:-$HOME/.hermes}/profiles/pm" ]; then
  run mkdir -p "${HERMES_HOME:-$HOME/.hermes}/profiles/pm/skills/project-planning"
  run cp "$HERE/skills/project-planning/SKILL.md" "${HERMES_HOME:-$HOME/.hermes}/profiles/pm/skills/project-planning/SKILL.md"
fi

echo "# 2. one kanban board per section (skipped if it already exists)"
existing="$(hermes kanban boards list --json --all 2>/dev/null || echo '[]')"
board(){ grep -q "\"slug\": \"$1\"" <<<"$existing" && echo "  · board $1 exists" || run hermes kanban boards create "$@"; }
board ai-thrival     --name "AI Thrival"     --description "Content & brand: iOS apps, Udemy courses"
board micropace-labs --name "MicroPace Labs" --description "Greenfield projects, not yet ready for consumers"
board investments    --name "Investments"    --description "Research only — never trades"
board research       --name "Research"       --description "Research and learning tasks"
board family         --name "Family"         --description "Household and family tasks — titles only, nothing sensitive"
# Household finance has no board on purpose: it runs in the private pipeline + the Ollama-only `personal` profile
# and shows up in Cockpit's Family section as PII-gated summaries.
# Section mapping for Cockpit lives in config/cockpit.json.

echo "# 3. let Atlas create and manage kanban tasks from Telegram (and CLI/dashboard chat)"
run hermes tools enable kanban --platform telegram
run hermes tools enable kanban

echo "# 4. Atlas persona, appended once to the default profile's SOUL.md (backup kept)"
SOUL="${HERMES_HOME:-$HOME/.hermes}/SOUL.md"
if grep -q "You are \*\*Atlas\*\*" "$SOUL" 2>/dev/null; then echo "  · persona already present"
else run cp "$SOUL" "$SOUL.before-atlas"; echo "+ append hermes/atlas-persona.md >> $SOUL"
  [ "$APPLY" = 1 ] && { printf '\n'; cat "$HERE/atlas-persona.md"; } >> "$SOUL"; fi

echo "# 5. self-written skills need the user's approval (guards against skill drift)"
run hermes config set skills.write_approval true

echo "# 6. morning brief cron (08:00 local) delivered to Telegram — adjust --deliver to your chat"
run hermes cron create "0 8 * * *" "$(cat "$HERE/cron/morning-brief.md")" \
  --name atlas-morning-brief --skill cockpit --deliver telegram

echo "# 7. Ollama-only profile for money questions. Created WITHOUT --clone so no cloud keys are copied."
run hermes profile create personal --no-skills --description "Local-only (Ollama) assistant for personal finance questions"
cat <<'MSG'

Start a NEW Telegram chat with the bot afterwards: tool changes apply to new conversations only.
Rename the bot to "Atlas" in @BotFather (/setname) if you want the name in Telegram too.

Then set up the agent roster (all dry runs until --apply):
  npm run agents -- catalog sync --apply     # fetch the agency-agents catalog at the pinned commit
  npm run agents -- list                     # who serves which portfolio
  npm run agents -- sync                     # preview creating the proposed agents' Hermes profiles

Next, manually (interactive, needs your input):
  hermes -p personal model        # choose provider = ollama, model = your local Qwen/Gemma
  hermes -p personal gateway ...  # give it its OWN Telegram bot token (two profiles must not share one)
Confirm with:  hermes -p personal config   # no cloud provider keys present
MSG
[ "$APPLY" = 1 ] || echo "(dry run — re-run with --apply)"
