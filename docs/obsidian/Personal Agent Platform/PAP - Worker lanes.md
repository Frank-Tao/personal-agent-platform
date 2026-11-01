---
title: PAP - Worker lanes
tags: [personal-agent-platform, lanes,models]
created: 2026-11-01
source: ~/codes/personal-agent-platform
---

# Worker lanes (lanes/lane.sh)

`lane.sh <lane> <workdir> <prompt-file> <out-dir>` → `result.md`, `log.txt`, `meta.json`. Exit 3 = privacy refusal, 142 = timeout (30 min default),
an empty answer = failure. Every real run is appended to `data/lanes.jsonl` (lane, model, status, note).

| Lane | What | Checked how |
|---|---|---|
| claude | subscription CLI, may edit (worktree) | `claude auth status`; limits via `claude -p "/usage"` |
| codex | subscription CLI, may edit | `codex login status` (prints to stderr); shares the ChatGPT plan limit with Hermes |
| opencode-zen | free models via `opencode`, read-only `plan` agent | `opencode models opencode` |
| openrouter | API via `opencode`, read-only | `opencode auth list`; spend from `opencode stats` |
| openai | API via `opencode` — **not set up** | `opencode auth login` → OpenAI |
| ollama | local, only lane for private data | API `/api/ps` shows the model in memory |

Gemini was removed (Google's CLI login rejected: "client no longer supported"). Default models: `lanes/models.conf`.

Related: [[PAP - Architecture]]
