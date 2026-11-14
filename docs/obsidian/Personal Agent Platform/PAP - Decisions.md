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

## 2026-11-08
- Codex model set = GPT-6.1 Sol / Terra, GPT-6 Luna; all glm agents → `gpt-6.1-terra`.
- Skills trimmed per role via `config/skills.json` (≈3k → 0.4–0.9k tokens per session); four mandatory skills in every agent. Details: [[PAP - Skills and models]].
- New `finance` agent (Finance Analyst) for Investments/Family.
- Cockpit: agent and project pages have a left-hand switcher list.

## 2026-11-09
- "Nothing sent out" means email or messages to people outside the approved list, public posts, deploys, spending. Commits, PRs and merging them on a project's repo (with test evidence), KnowledgeBase writes and Telegram to Frank or Diane are not outward. Details and the Auto Research Agent story: [[PAP - Auto Research Agent]].
- New repos get a private GitHub twin named like the folder; the skills curator no longer prunes Hermes' built-in skills; the watchdog ignores decomposer steps.

## 2026-11-14
- Cockpit keeps full snapshots for an hour, then one per hour for 7 days; the daily trend has its own table (the database was 504 MB after two weeks, now about 13 MB).
- Every `/api` route is listed in `apps/cockpit/src/access.ts` with the role it needs. A Guest (unknown device) gets the redacted dashboard only; agent prompts, memory, models, growth and feedback decisions are owner-only (Frank, Admin). Diane keeps chat, tasks and projects.
- Who has their own view is in `config/cockpit.json` under `people`. A device tailscale does not know is always a Guest; no config entry can change that.
- The `work` CLI runs in a child process from Cockpit, and the project list keeps unchanged `kanban show` answers (`packages/work/showcache.ts`): about 100 s down to 5 s.
- `npm run check` (TypeScript, strict) and the tests run before every push (`.githooks/pre-push`).
- Nightly backup at 03:10 (`com.franktao.pap.backup`): Cockpit database, PortfolioKB, Hermes memory/prompts/config/cron and the kanban boards, about 15 MB, kept 14 days in `~/Backups/pap`. Not `hermes backup`: `-q` only snapshots inside `~/.hermes`, and the full archive is tens of GB. A failed or missing backup appears in Needs-you.
- The Cockpit page is three files (`index.html`, `styles.css`, `app.js`) with a `script-src 'self'` policy; `work/cli.ts` is split into `work/shared.ts` and `work/commands/`.

## 2026-11-15
- Diane may change agent models, prompts and memory (was owner-only for a day). Guests still may not. Every change and every refused write goes to `data/audit.jsonl` (`npm run audit`). A limited viewer cannot save a file that has lines hidden from them.
- Branches merged into `main` as PR #5. Seven old branches were already on `main` (it was rewritten on 7 Nov; PRs #1-#4 merged them); the Family portfolio panel and the privacy/chat fixes from `wip/local-changes` were ported over.
- The Utility Portal now runs as a launchd service (`com.franktao.pap.utility-portal`, installed with `infra/bin/install-launchd.sh --apply utility-portal`). It was never a service, so after the 15 Nov restart nothing started it and Cockpit's Utility Portal group was empty. Cockpit raises a Needs-you item when the portal stops answering.

