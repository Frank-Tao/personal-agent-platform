#!/usr/bin/env bash
# Idempotent bootstrap checks + directory layout. Changes nothing outside $HOME dirs listed below.
set -euo pipefail
ok(){ printf '  ✔ %s\n' "$*"; }; bad(){ printf '  ✖ %s\n' "$*"; FAIL=1; }; FAIL=0

echo "Tools"
node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
[ "$node_major" -ge 24 ] && ok "node $(node -v)" || bad "node >= 24.11 required"
for c in ollama tailscale hermes git; do command -v "$c" >/dev/null && ok "$c" || bad "$c missing"; done
command -v paperclipai >/dev/null && ok "paperclipai" || echo "  · paperclipai not installed yet: run  npx paperclipai@latest onboard"

echo "Directories"
mkdir -p "$HOME/Private/inbox" "$HOME/PrivateSummaries" "$HOME/PortfolioKB"
chmod 700 "$HOME/Private"           # raw financial documents
chmod 755 "$HOME/PrivateSummaries"  # summary layer, PII-gated before it is read by anything else
ok "~/Private (700)  ~/PrivateSummaries  ~/PortfolioKB"

echo "Ollama"
if curl -fsS localhost:11434/api/tags >/dev/null 2>&1; then ok "ollama reachable"; else bad "ollama not running"; fi
model="${PRIVATE_MODEL:-qwen3.8:27b}"
ollama list 2>/dev/null | awk '{print $1}' | grep -qx "$model" && ok "model $model present" || bad "model $model missing: ollama pull $model"

cat <<'MSG'

Manual steps (need your approval / sudo, not done by this script)
  1. System Settings ▸ Energy: prevent automatic sleeping; "Start up automatically after a power failure".
  2. tailscale up   (then `tailscale serve --bg 3200` to reach Portfolio HQ from phone/MacBook)
  3. paperclipai service install   (after onboarding; Paperclip supervises itself via launchd)
  4. infra/bin/install-launchd.sh --apply        (Portfolio HQ + private pipeline)
  5. hermes/install.sh                           (review, then --apply)
  6. infra/bin/private-user.sh                   (optional hardening: separate macOS user for ~/Private)
MSG
exit $FAIL
