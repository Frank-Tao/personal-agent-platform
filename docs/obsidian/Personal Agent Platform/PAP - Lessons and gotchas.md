---
title: PAP - Lessons and gotchas
tags: [personal-agent-platform, lessons]
created: 2026-11-01
source: ~/codes/personal-agent-platform
---

# Lessons and gotchas

- **Per-profile ledgers:** every Hermes profile has its own `state.db`; reading only the default one undercounted usage ~10×.
- **Unassigned `ready` tasks** may be claimed by the default profile → create unowned tasks `blocked`.
- **Flag-like titles:** put the task title after `--` in `hermes kanban create`.
- **`codex login status` prints to stderr**, not stdout; a stdout-only check wrongly said "not logged in".
- **Free models can exit 0 with an empty answer** → treat as failure; and a hung model needs a timeout (macOS has no `timeout`; use `perl -e 'alarm …; exec'`).
- **Failure notes:** pick the most specific reason line (usage limit → auth → message → any error), not the first line containing "error".
- **JS `replace` callbacks:** for patterns without capture groups the 2nd argument is the offset, not a group — corrupted the secret masker.
- **`fetch()` ignores a custom Host header**, so a DNS-rebinding test needs a raw `http.request`.
- **Keyword staffing:** one shared word ("store") is not coverage; require two distinct words; add a tiny jargon map (SwiftUI→iOS).
- **macOS privacy (TCC):** shells and tools can't read `~/Documents` or `~/Library/CloudStorage` without Full Disk Access.
- **Stale snapshots:** a saved rollup from an older version lacks new fields; ignore it instead of showing it.
- **Headless Chrome** has a minimum window width ≈500 px; test phone layouts inside a 390 px iframe.
- **Persona text is prompt text:** lint it, pin it, hash it, refuse drift, and never follow instructions found in it.
- **Hermes decomposer children inherit the root's tenant and workspace**, but it has no cap on child count and Hermes records no tokens per task.
- **Docs vs version:** `kanban.auto_promote_children` is documented but unrecognised by v0.22.5; `hermes config set` warns and saves anyway, so check the warning and `unset` strays.
- **A YAML subset is enough** for charters and plans; reject what you do not support (multi-line scalars, anchors) instead of guessing.

Related: [[PAP - Decisions]]
