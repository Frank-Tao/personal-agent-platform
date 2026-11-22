#!/usr/bin/env bash
# Copy the skills in this repo into the Hermes profiles that use them, so a change to a skill actually reaches the agents.
# (hermes/install.sh does the same at setup time; this is the small, safe version to run after a merge.) Dry run unless --apply.
#
#   sync-skills.sh            show what is out of date
#   sync-skills.sh --apply    copy it
#
# qa-browser-evidence -> the qa profile        project-planning -> the pm profile and the shared skills folder
set -euo pipefail
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
HOME_DIR="${HERMES_HOME:-$HOME/.hermes}"
APPLY=0; [ "${1:-}" = "--apply" ] && APPLY=1
changed=0
sync_skill() {   # sync_skill <skill> <destination skills folder>
  local skill="$1" dest="$2" src="$HERE/hermes/skills/$1/SKILL.md"
  [ -f "$src" ] || { echo "? $skill: not in the repo"; return; }
  [ -d "$dest" ] || { echo "· $skill: no $dest (profile not created), skipped"; return; }
  if cmp -s "$src" "$dest/$skill/SKILL.md" 2>/dev/null; then echo "= $skill is current in $dest"; return; fi
  changed=$((changed + 1))
  echo "$([ $APPLY = 1 ] && echo '✓' || echo '+') $skill -> $dest/$skill/SKILL.md"
  if [ $APPLY = 1 ]; then mkdir -p "$dest/$skill"; cp "$src" "$dest/$skill/SKILL.md"; fi
}
sync_skill qa-browser-evidence "$HOME_DIR/profiles/qa/skills"
sync_skill project-planning "$HOME_DIR/profiles/pm/skills"
sync_skill project-planning "$HOME_DIR/skills"
[ $APPLY = 1 ] || { [ $changed -eq 0 ] || echo "(dry run: add --apply)"; }
