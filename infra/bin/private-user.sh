#!/usr/bin/env bash
# OPTIONAL hardening (needs sudo): run the private pipeline as a separate macOS user so agents
# running as your normal user cannot read raw financial documents. Dry run prints the steps.
set -euo pipefail
APPLY=0; [ "${1:-}" = "--apply" ] && APPLY=1
U=agentpriv
run(){ echo "+ $*"; [ "$APPLY" = 1 ] && "$@" || true; }

run sudo sysadminctl -addUser "$U" -fullName "Agent Private" -password - -home "/Users/$U"
run sudo mkdir -p "/Users/$U/Private/inbox" "/Users/$U/PrivateSummaries"
run sudo chown -R "$U" "/Users/$U/Private" "/Users/$U/PrivateSummaries"
run sudo chmod 700 "/Users/$U/Private"
run sudo chmod 755 "/Users/$U/PrivateSummaries" "/Users/$U"   # summaries readable by your user
cat <<MSG

Then:
  * Move the private-pipeline launchd job to a LaunchDaemon with <key>UserName</key><string>$U</string>
    and PRIVATE_HOME=/Users/$U/Private, PRIVATE_SUMMARIES_DIR=/Users/$U/PrivateSummaries.
  * Point Portfolio HQ at it:  PRIVATE_SUMMARIES_DIR=/Users/$U/PrivateSummaries
  * Drop statements via a drop folder you can write to (e.g. an ACL'd inbox) — never give cloud agents access to it.
Until this is done the pipeline runs as YOUR user: the PII gate still protects the dashboard/brief,
but it is NOT an OS-level barrier against other agents running as you.
MSG
[ "$APPLY" = 1 ] || echo "(dry run — re-run with --apply)"
