# Solution Design

Revised 2026-11-01. Hermes (as **Atlas**) is the backbone; worker lanes, the agent roster, memory (KB repos)
and the dashboard (**Cockpit**) are owned by this repo, so Hermes stays replaceable. Paperclip was dropped on
2026-10-31.

## 1. Evaluation summary

| | Hermes Agent (Nous Research) | Paperclip | OpenClaw | Letta |
|---|---|---|---|---|
| Role | Chat gateway, memory, self-written skills, kanban, cron, delegation | Org chart, tickets, budgets, approvals UI, CLI adapters | Chat gateway, routing | Stateful agents with tiered memory |
| Channels | Telegram, WeChat (`weixin`), WeCom, Slack, Feishu, Signal, Discord, ~20 more | Web UI only | Many; WeChat via community plugin | Weak (Telegram bot runs on Modal; LettaBot alpha) |
| Learning | Session FTS search, curated notes (capped 2,200/1,375 chars), skills, pluggable memory providers | None | Basic | Best-in-class design |
| Decision | **Backbone** | **Dropped** | Skip (overlap, security record) | Optional memory layer later |

Why Paperclip was dropped (observed on this Mac): an unpinned foreground `npx` process (the npx cache was already one
version ahead of the running server), both companies stalled with most tickets `blocked`/`in_review`, one agent in
`error`. Everything it uniquely offered maps onto Hermes or this repo (§4).

Sources: hermes-agent.nousresearch.com/docs, github.com/paperclipai/paperclip, docs.openclaw.ai,
github.com/letta-ai, github.com/msitarzewski/agency-agents (+ `-app`), arXiv 2608.18066 (fragility of self-improving agents).

## 2. Architecture

```
You ── Telegram · Cockpit chat (WeChat / Slack possible, off by default)
          │
     Atlas — Hermes default profile, "chief of staff"
       chat · memory · skills · kanban dispatch · cron           skills: cockpit · agent-lanes · agent-roster · agent-staffing
          │ assigns tasks to agents (= Hermes profiles) by name
          ▼
     Agents (config/agents.json)   many-to-many with portfolios; personas from agency-agents (pinned, hashed, linted)
          │ each runs work through the lanes
          ▼
     lanes/lane.sh  ──  claude · codex              subscription CLIs, may edit files (worktree)
                        opencode-zen · openrouter · openai   API via the opencode CLI, read-only text
                        ollama                      local, private, the only lane for private data
          │
     State we own:  ~/PortfolioKB/<portfolio> (durable memory, git) · kanban boards (tasks, review = approval)
                    ~/PrivateSummaries (PII-gated) · config/*.json · data/lanes.jsonl (lane run ledger)
          │
     Cockpit (apps/cockpit): dashboard + chat + new task + agent detail, over everything above

     Hermes "personal" profile (Ollama only) ── private pipeline (inbox → extract → redact → summaries)
All on one Mac mini, reached over Tailscale.
```

Rented vs owned is the point: if Hermes is replaced, the lanes, roster, memory, private pipeline and dashboard move
unchanged; only the Hermes adapters in Cockpit and the setup CLI change.

## 3. Components

| Component | Where | Notes |
|---|---|---|
| **Atlas** | Hermes default profile (`~/.hermes`) | own launchd gateway; Telegram; persona in `hermes/atlas-persona.md` |
| Hermes kanban | built into Hermes | boards `ai-thrival`, `micropace-labs`, `investments`, `research`, `family`; one per portfolio |
| **Agent roster** | `config/agents.json`, `agents/cli.ts`, `packages/roster` | agents = Hermes profiles; setup CLI (dry run unless `--apply`) |
| **Worker lanes** | `lanes/lane.sh`, `lanes/models.conf` | one contract for 6 lanes; privacy refusal; timeout; empty answer = failure; run ledger |
| **Work model** | `work/cli.ts`, `packages/work`, `kb-template/` | objectives, project charters, plans (see `docs/design/work-model.md`); files in `~/PortfolioKB` |
| **Cockpit** | `apps/cockpit` | collector, SQLite snapshots, dashboard UI, chat proxy, task API, agent detail |
| **Private pipeline** | `apps/private-pipeline` | Ollama numbers-only extraction, regex redaction, code-written summaries |
| Hermes skills | `hermes/skills/*` | cockpit, agent-lanes, agent-roster, agent-staffing (copied into `~/.hermes/skills` by the installer) |
| Knowledge repos | `~/PortfolioKB/<portfolio>/` | markdown + git; the durable memory |
| Ollama | installed | private pipeline + ollama lane |

## 4. What replaced Paperclip

| Paperclip feature | Replacement |
|---|---|
| Tickets, dependencies, assignees | Hermes kanban (atomic claim, links, profiles as assignees, dispatch daemon) |
| Companies | One kanban board per portfolio |
| Org chart | The roster: agents ↔ portfolios, many-to-many (deliberately flat) |
| Approvals UI | Kanban `review` state → Telegram / Cockpit "Needs you" |
| Claude Code / Codex adapters | `lanes/lane.sh` (official CLIs only) |
| Budgets | Subscriptions for workers; provider-console caps for API keys; Cockpit shows usage, limits and recorded spend |
| Web UI | Cockpit (+ the Hermes dashboard, linked from the header) |

## 5. Portfolios, agents and staffing

- **Portfolios** (Cockpit sections, defined once in `apps/cockpit/src/types.ts`): AI Thrival (content & brand: iOS apps, Udemy
  courses) · MicroPace (greenfield, not yet consumer-ready) · Investments · Research · Family (also receives the PII-gated
  household finance summaries). `config/cockpit.json` maps boards and cron-job name patterns to sections.
- **Agents** are Hermes profiles with their own memory, skills and model. `config/agents.json` lists each agent, its role, lanes,
  portfolios (`*` = all) and optional catalog persona. Many agents can serve one portfolio; one agent can serve several.
  Cockpit labels each agent `active` (profile exists), `proposed` (in the roster, not created) or `unlisted` (a profile the roster
  does not mention). Creating a profile only happens through `agents sync --apply`.
- **Personas** come from agency-agents, pinned to a commit (`b37b5bb…`), cloned to `~/.local/share/agency-agents`, recorded with a
  SHA-256, linted for red flags (`curl | sh`, "ignore previous instructions", secrets exfiltration, base64 blobs, sudo, rm -rf) and
  refused on drift. Persona text is **untrusted prompt text**; size is reported because it is added to every turn.
- **Staffing** has two layers. Cockpit runs a deterministic keyword check (`packages/roster/staffing.ts`, no tokens) on every
  unowned task and surfaces it in Needs-you; it needs two distinct matched words to call a task covered. Atlas' `agent-staffing`
  skill does the real judgement: pick an existing agent, or propose a catalog persona and a model (`agents models` lists the
  models that exist here and which are rate-limited) and **ask before creating anything**.

## 6. Memory: "smarter with use"

- **Owned, durable:** `~/PortfolioKB/<portfolio>/{goals,decisions,context}.md`. The agent-lanes skill appends decisions after
  each task. Survives any platform change.
- **Hermes, automatic:** session search; self-written skills (creation needs approval, `skills.write_approval: true`); small
  curated notes (2,200 / 1,375 characters). Cockpit's agent detail shows all three per agent: prompt, skills (bundled / platform /
  written by the agent / hub / added, with use counts and stale flags) and memory (with how full it is).
- **Later, if recall is weak:** a Hermes memory-provider plugin for semantic search; Letta only if that is still not enough.

## 7. Cockpit design

- **Atlas panel and health:** read-only from `gateway_state.json` (gateway, heartbeat, channels, served profiles) and every
  profile's `cron/jobs.json` (status only). Amber = degraded (failing job, secondary channel down, any limit ≥85%); red = cannot
  work (gateway or main Telegram down, a provider limit at 100%). Each reason is listed.
- **Usage:** read-only from every profile's `state.db` `sessions` table (counts, model, channel, billing; never titles or text) plus
  `hermes usage --json` (Codex weekly window). Charts split by Type, Channel or Agent.
- **Lanes (real checks):** `claude auth status`, `claude -p "/usage"`, `codex login status`, `opencode auth list` / `stats`, Ollama's
  API (loaded model). Codex shares the ChatGPT plan limit with Hermes. API lanes show recorded spend, not limits.
- **Chat:** Cockpit's server streams to Hermes' OpenAI-compatible API server with the API key (server-side only); each
  conversation is its own Hermes session (`X-Hermes-Session-Id: cockpit-…`), with Atlas' persona, memory and tools.
- **Tasks:** `POST /api/tasks` drives `hermes kanban create` with fixed arguments (title after `--`). Unowned → `blocked`
  (an unassigned `ready` task could be claimed by the default profile); assigned → `ready`. `POST /api/tasks/assign` assigns then
  unblocks.
- **Agent detail:** `GET /api/agents/:id` reads SOUL.md, skills and memory from the profile folder, masking PII and key-like strings.
- **Write security:** every `/api` request needs an allowed Host (DNS rebinding); writes also need same-origin `Origin`, a JSON
  content type, and the optional `COCKPIT_TOKEN`. These stop web pages in your browser from driving Atlas via localhost.
- **Collector / store / rollup:** kanban via the Hermes CLI (not the SQLite file); `~/PrivateSummaries/*.json` (PII-gated on read);
  `data/portfolio/*.json` (manual KPIs, optional `group` and `earnings`). SQLite snapshots for trends; a snapshot from an older
  version is ignored. `/api/brief` feeds Atlas' morning cron.

## 8. Privacy architecture (enforced, not promised)

1. Raw files in `~/Private/inbox`, owned by a separate macOS user once `private-user.sh` is applied.
2. Private pipeline: Ollama extracts numbers only → code writes the text → deterministic regex gate → `~/PrivateSummaries`.
   Cockpit re-checks on read.
3. `lanes/lane.sh` refuses cloud lanes whose workdir is in `~/Private` or whose prompt references it (exit 3).
4. The `personal` Hermes profile is Ollama only. Staffing never routes money questions to a cloud model.
5. Tailscale-only access; Cockpit binds to loopback and is published with `tailscale serve`.
6. Agent prompts and memory are masked before Cockpit shows them.

## 9. Models and cost routing

- Subscriptions through official CLIs for workers (Claude Code, Codex); API lanes through `opencode` (OpenCode Zen free models,
  OpenRouter, OpenAI once set up); Ollama for everything private (`qwen3.8:27b` for the pipeline, loaded on demand).
- Observed 2026-10-31: the Codex Plus weekly limit was at 100% (resets Nov 4); Atlas' sessions ran on OpenCode Zen's
  `glm-5.3-flash`; the `diane` agent's scheduled jobs were ~90% of all tokens. New agents copy the default profile's model unless
  `--model/--provider` is given, so choose per agent.

## 10. Risks

Hermes is young and fast-moving (pin it; CVEs in 2026) · self-written skills drifting (approval on, weekly review) · prompt
injection via inbound channels and via persona text (allowlists, lint, drift refusal, untrusted-data rule) · Cockpit now has write
endpoints (host/origin/JSON guards, optional token, tailnet-only) · the Hermes dashboard and API server listen on all interfaces
(both need auth; consider binding to loopback) · the staffing heuristic can miss synonyms (Atlas judges; nothing is created without
your yes) · lane runs mistaken for completion (Hermes must verify diffs/tests) · a single Mac mini (nightly backups incl. `hermes backup`).
