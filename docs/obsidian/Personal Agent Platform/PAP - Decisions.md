---
title: PAP - Decisions
tags: [personal-agent-platform, decisions]
created: 2026-11-01
source: ~/codes/personal-agent-platform
---

# Decisions (2026-10-31 → 2026-11-01)

| Decision | Why |
|---|---|
| Drop Paperclip; Hermes is the backbone | Unstable as run (unpinned `npx`, stalled companies); Hermes already has channels, kanban, skills, memory |
| Keep Hermes replaceable | Own the lanes, roster, memory, pipeline, dashboard; rent channels/dispatcher |
| Names: **Atlas** (agent), **Cockpit** (dashboard) | Short, speakable on Telegram |
| Portfolios: AI Thrival, MicroPace, Investments, Research, Family; Personal merged into Family | Two brands with different goals; household finance summaries belong with family |
| Agents = Hermes profiles, many-to-many with portfolios | One coding agent serves several brands; several specialists per brand |
| Personas from agency-agents, pinned + hashed + linted | Real specialist roles without writing prompts; but they are untrusted text |
| Roster registered registry-only | Creating profiles changes live Hermes; only on explicit `--apply` |
| Gemini out; OpenCode Zen / OpenRouter / OpenAI in, via `opencode` | Gemini login rejected; one runner for API lanes, read-only |
| Chat = plain UI streamed through Cockpit; Hermes dashboard = header link | Simple and clean; no embedded second UI |
| Unowned tasks created `blocked` | An unassigned `ready` task could be claimed by the default profile |
| Atlas never creates an agent without the user's yes | Cost and prompt-injection safety |
| Obsidian: project knowledge → KnowledgeBase vault | Per the stored vault-split rule |
| Work model: rolling objectives; projects ≈ 1 week, ≤ 9 tasks; **humans approve objectives and project charters only**; `kanban.auto_decompose` stays on | Fewer questions; safety comes from the charter, code guardrails, an outbox for outward actions, and escalation by exception |

| Phase 1 of the work model built; Hermes kanban throttles applied | `work` CLI + `packages/work`; `max_in_progress 2`, per-profile 1, `orchestrator_profile pm` |

## Findings worth remembering
- Codex Plus weekly limit hit 100% (reset Nov 4); Atlas fell back to OpenCode Zen `glm-5.3-flash`.
- The `diane` agent's scheduled jobs were ~90% of all tokens (≈6.9M in 7 days).
