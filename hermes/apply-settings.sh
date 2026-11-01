#!/usr/bin/env bash
# Hermes kanban settings for the work model (docs/design/work-model.md §8). Dry run unless --apply; config.yaml is backed up first.
#   - auto_decompose stays ON (decision 2026-11-01); decomposed children are promoted by default; throttles and the decomposer model are set
#   - max_in_progress 2, per profile 1: protects limited subscriptions and the 32 GB machine
#   - orchestrator_profile pm: a decomposed root returns to pm, the project owner, to judge completion
#   - the decomposer runs on a working model instead of "auto" (Codex is rate-limited)
set -euo pipefail
APPLY=0; [ "${1:-}" = "--apply" ] && APPLY=1
HOME_DIR="${HERMES_HOME:-$HOME/.hermes}"
CFG="$HOME_DIR/config.yaml"
run(){ echo "+ $*"; [ "$APPLY" = 1 ] && "$@" || true; }

echo "# current values"
for k in kanban.auto_decompose kanban.max_in_progress kanban.max_in_progress_per_profile kanban.orchestrator_profile \
         auxiliary.kanban_decomposer.provider auxiliary.kanban_decomposer.model; do
  printf '  %-45s %s\n' "$k" "$(hermes config get "$k" 2>/dev/null | tail -1)"
done
[ -d "$HOME_DIR/profiles/pm" ] || { echo "✗ profile 'pm' does not exist (run: npm run agents -- sync --only pm --apply)"; exit 1; }

echo "# changes"
if [ "$APPLY" = 1 ]; then cp "$CFG" "$CFG.before-work-model-$(date +%Y%m%d-%H%M%S)"; echo "  backup written next to config.yaml"; fi
run hermes config set kanban.max_in_progress 2
run hermes config set kanban.max_in_progress_per_profile 1
run hermes config set kanban.orchestrator_profile pm
run hermes config set kanban.auto_decompose true
# (kanban.auto_promote_children is in the docs but not recognised by Hermes v0.22.5; children are promoted by default)
run hermes config set auxiliary.kanban_decomposer.provider opencode-zen
run hermes config set auxiliary.kanban_decomposer.model glm-5.3-flash
[ "$APPLY" = 1 ] && echo "Done. If the gateway does not pick this up by itself, restart it: hermes gateway restart (briefly interrupts all bots)." || echo "(dry run — re-run with --apply)"
