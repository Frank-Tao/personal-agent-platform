#!/usr/bin/env bash
# Keeps every folder in the Obsidian vault writable by its owner. Synced folders (Syncthing with permissions
# on) can arrive read-only (dr-xr-xr-x), which makes agent writes fail with Errno 13. Only adds the owner write
# bit to folders that lack it; touches nothing else. Run by launchd (com.franktao.pap.vault-writable).
set -euo pipefail
VAULT="${OBSIDIAN_VAULT:-$HOME/Documents/Obsidian Vault}"
[ -d "$VAULT" ] || exit 0
n=$(find "$VAULT" -type d ! -perm -u+w -print -exec chmod u+w {} + | wc -l | tr -d ' ')
[ "$n" = 0 ] || echo "$(date -u +%FT%TZ) made $n folder(s) writable"
