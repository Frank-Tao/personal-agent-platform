---
title: PAP - Work model design
tags: [personal-agent-platform, design]
created: 2026-11-01
source: ~/codes/personal-agent-platform/docs/design/work-model.md
---

# Design: objectives → projects → tasks, orchestrated across agents

Status: **decisions taken 2026-11-01, not yet implemented** (§14). Principle chosen by you: *humans approve objectives and
projects; Atlas and `pm` decide everything below that.* Open items: budgets and where key-result numbers come from.

## 1. Problem

Today a portfolio is a flat kanban board of tasks. You want a **high-level objective** per portfolio, **small projects** under it,
**tasks** broken out of each project, and **several agents** carrying them out (one agent such as `coding` may work across
portfolios) — with **as few human approvals as possible**: you approve the objective and the project, not the plan or the tasks.

Non-goals: replacing Hermes' kanban, a general project-management product, automating strategy.

## 2. Vocabulary

| Level | Meaning | Size | Who decides |
|---|---|---|---|
| **Portfolio** | A brand or area of life (AI Thrival, MicroPace, Investments, Research, Family) | permanent | you |
| **Objective** | What the portfolio must achieve next, with 1–4 measurable **key results**. **Rolling**: no fixed period, reviewed weekly | next ~4–8 weeks | **you approve**; Atlas drafts |
| **Project** | A bounded outcome that moves a key result, defined by a **charter** | about **one week, ≤ 9 tasks** | **you approve the charter**; `pm` drafts it and owns delivery |
| **Task** | One unit of work for **one** agent: one run, an acceptance test | ≤ ~2 h of agent time | **Atlas / `pm` decide**, no approval |

## 3. What Hermes already provides (verified on this machine)

| Need | Hermes mechanism | Verified |
|---|---|---|
| Hard isolation per portfolio | **Board** | in use |
| Group a project's tasks | **Tenant** (`--tenant <project>`); `list --tenant` filters | yes |
| Dependencies | `--parent`; child waits in `todo`, becomes `ready` when all parents are `done` | yes |
| No duplicates on re-apply | `--idempotency-key` returns the existing task | yes |
| Auto-split a goal into routed tasks | **Triage + decomposer** (routes by each profile's description, LLM-driven) | yes: **children inherit the root's tenant and workspace**; no limit on child count |
| Parallel research → verify → synthesize | `kanban swarm` | exists |
| Open-ended task judged against criteria | `--goal`, `--completion-contract` | exists |
| Per-task model/lane, pinned skills | `--model`, `--provider`, `--skill` | exists |
| Throttles and failure handling | `max_in_progress(_per_profile)`, `--max-runtime`, `failure_limit` (auto-block), respawn guard | exists |
| What it does **not** record | tokens per task (task runs store time, outcome, summary only) | checked in the schema |

**Missing, therefore new:** objectives and key results, the project charter, guardrails tied to a charter, an outbox for outward
actions, escalation-by-exception, and roll-up of progress across tasks.

## 4. Design decisions

| # | Decision | Alternatives rejected |
|---|---|---|
| D1 | **Portfolio = board** (unchanged) | one board: loses isolation |
| D2 | **Project = markdown record (charter + plan + log) in the portfolio's KB repo + a kanban tenant of the same slug** | project = board (many dispatcher views); project = parent task only (no home for charter/budget); Hermes `project` (per-profile, repo-oriented) |
| D3 | **Objectives live in git markdown**, not in Hermes `/goal` | `/goal` is session-scoped |
| D4 | **Approval happens once, at the charter.** Inside it, Atlas and `pm` act without asking | approving plans/tasks: too many questions |
| D5 | **Guardrails are code and capabilities, not prompts** (principle PR3): what an agent cannot do, it cannot do | "the prompt says be careful" |
| D6 | **Escalate by exception**, summarised in a digest | per-task notifications |
| D7 | One task = one assignee; shared work is split | multi-assignee tasks: unsupported |
| D8 | Truth: **charter/plan/objectives = KB git; tasks = kanban; agents = roster; Cockpit = read-only view** | state duplicated in Cockpit |
| D9 | **`kanban.auto_decompose` stays ON** (your decision); it is one of two ways to expand work, inside the same guardrails (§8) | turning it off |

## 5. Data model

### 5.1 Files (per portfolio, in `~/PortfolioKB/<portfolio>/`)

```
objectives.md                 # rolling objectives and key results
projects/<slug>.md            # one per project: charter + plan + log
decisions.md  context.md
```

**`objectives.md`**
```markdown
---
portfolio: micropace
horizon: rolling          # reviewed weekly; no fixed end
reviewed: 2026-11-01
---
## O1 Ship the first consumer-ready product
- KR1.1 Notice → Calendar v1 live on a public URL, 12-check verification passing   (aim: ~2 weeks)
- KR1.2 Day-0 accuracy gate ≥ 90% correct dates on 30 real notices
- KR1.3 5 external users complete the flow
```

**`projects/<slug>.md`** — the front-matter *is the charter*; approving the project approves exactly this:
```markdown
---
id: notice-to-calendar-v1
portfolio: micropace
objective: O1
key_results: [KR1.1, KR1.2]
status: proposed          # proposed | active | paused | review | done | cancelled
owner: pm                 # drafts the plan, owns delivery, replans
tenant: notice-to-calendar-v1
timebox: 7d               # about a week
charter:
  outcome: "Notice → Calendar v1 on a public URL; spec §6 bar met"
  done_when: ["12 checks pass with evidence (qa)", "rollback documented"]
  team: [coding, qa, content, architect]       # agents the project may use
  new_agents: []          # catalog personas pre-approved for creation, with models (see agent-staffing)
  models: { default: glm-5.3-flash, lanes: [claude, openrouter] }
  max_tasks: 9
  budget: { usd: 5, lane_minutes: 120 }        # advisory ceilings, see §8
  outward:                # what the project may do in the world WITHOUT asking again
    deploy: { allowed: true, targets: [preview.example.com], rollback: required }
    publish: { allowed: draft-only }           # draft-only | auto (with limits) | no
    spend: { allowed: false }
  never: [money-movement, private-finance-data, deleting-outside-workspace]   # fixed floor, §9
  escalate_when: [over-budget, over-timebox, scope-change, qa-fails-twice, new-recipient]
repo: ~/projects/notice-calendar
---
## Context and decisions (stamped into every task body)
## Plan   (written by pm; format in 5.2; no approval needed)
## Log
```

### 5.2 The plan (written by `pm`, validated by code, not approved by you)

```yaml
tasks:
  - key: gate
    title: Day-0 accuracy gate: can one model call read a real notice?
    owner: coding            # must be an ACTIVE agent in charter.team
    lane: claude
    model: null              # null = profile default
    needs: []
    accept: "30 real notices, ≥90% correct dates; results in artifacts/gate.md"
  - key: build
    owner: coding
    needs: [gate]
    accept: "public URL; spec §6 bar met; rollback documented"
    outward: deploy          # an outward action: runs through the outbox (§9)
  - key: verify
    owner: qa
    needs: [build]
    accept: "12 numbered checks with evidence"
  - key: writeup
    owner: content
    needs: [verify]
    accept: "draft only; every claim traced to spec §13"
    outward: publish
```
`plan check` rejects: more than `max_tasks`, duplicate keys, cycles, an owner outside `charter.team`, a missing acceptance test, an
`outward` action the charter does not allow. `plan apply` is idempotent (`project:<id>:<key>`), so replans can be re-applied.

### 5.3 Where each fact lives

| Fact | Home | Written by |
|---|---|---|
| Objective, key results | `objectives.md` | Atlas drafts, **you approve** |
| Charter | `projects/<slug>.md` front-matter | `pm` drafts, **you approve** |
| Plan, log | same file | `pm`, system |
| Tasks, deps, comments, artifacts | Hermes kanban (tenant = project) | dispatcher, agents |
| Who serves which portfolio | `config/agents.json` | `agents` tool |
| Progress, risk, spend signals | Cockpit (derived, never stored) | — |

## 6. Lifecycle: what needs you, and what does not

```
 YOU ─ objective ──▶ Atlas drafts KRs ───────────(you approve)──────────▶ objectives.md
                          │
          Atlas/pm propose 1–3 projects, each a CHARTER ──(you approve ONE charter)──▶ status: active
                          │
        ═══════════ everything below runs without asking you ═══════════
   pm writes the plan → `plan check` → `plan apply` (tasks + deps + assignees + models)
   agents execute through lanes · qa verifies · Hermes retries and auto-blocks repeated failures
   replans inside the charter (same outcome, ≤ 9 tasks, same team, within budget): pm decides and logs
   small side-tasks: pm/Atlas drop them in triage → Hermes auto-decomposes (inherits the tenant) → runs
   outward actions: automatic if the charter allows them, otherwise queued in the outbox
        ═══════════════════════════════════════════════════════════════
                          │
   an ESCALATION trigger fires ──▶ one Needs-you item ──(you decide)──▶ continue / change charter / stop
                          │
   all tasks done + qa PASS ──▶ auto-close, retrospective to decisions.md, KR updated ──▶ weekly DIGEST to you
```

| State | Meaning | Moved by |
|---|---|---|
| proposed | charter waiting for you | you |
| active | tasks exist and run | system |
| paused | open tasks held | you or a guardrail |
| review | work done, `qa` verdict pending or failed | system; you only if escalated |
| done / cancelled | archived | system / you |

**What reaches you:** (1) new/changed objectives, (2) project charters, (3) escalations (§9), (4) a weekly digest (what shipped, what's at
risk, spend, next projects). **What does not:** plans, tasks, assignments, model/lane choices, retries, replans inside the charter, reviews.

**Small things without a project.** An ad-hoc task that is a single task, one agent, a free or cheap lane, no outward action and no
private data is created directly by Atlas or `pm` (no project, no approval). Anything bigger or outward-facing becomes a project proposal.

## 7. Orchestration patterns (task graphs)

| Pattern | Shape | Use for |
|---|---|---|
| Pipeline | spec → build → verify → write-up | MicroPace v1; a Udemy lesson |
| Fan-out / fan-in | N researchers → verifier → synthesizer (`kanban swarm`) | market scans, source checks |
| Review loop | implement → `qa` → changes → re-review | anything `qa` gates |
| Outbox action | task prepares the action; the outbox decides send/queue/escalate (§9) | publish, deploy, spend |
| Recurring | cron creates the next cycle from a template | weekly content calendar |

Rules: (1) **decide before you fan out**: `pm` settles shared choices once and stamps them into every task body, because workers cannot
see siblings; (2) every task body carries the project id, charter essentials, acceptance test and upstream artifacts; (3) explicit
hand-off evidence; (4) one agent may hold tasks in several projects, bounded by `max_in_progress_per_profile`; (5) cheap models do the
volume, the claude/codex lanes are pinned per task only where quality matters.

## 8. Guardrails enforced by code, not prompts

| Guardrail | Mechanism | Strength |
|---|---|---|
| Concurrency | `kanban.max_in_progress: 2`, `max_in_progress_per_profile: 1` | **hard** (Hermes) |
| Runaway task | `--max-runtime` on every task; `failure_limit` auto-blocks after repeated failures | **hard** (Hermes) |
| Quota/auth errors | Hermes respawn guard stops retry storms | **hard** (Hermes) |
| ≤ 9 tasks per project | `plan check`, plus a **watchdog** that counts tasks per tenant (the decomposer has no cap) and pauses the tenant + escalates when exceeded | **watchdog**, minutes of delay |
| Time box | watchdog compares project age with `timebox` | watchdog |
| Budget | tokens are **not** recorded per task, so the ceiling is expressed as lane-minutes (sum of task-run durations per tenant) and API spend recorded by `opencode stats`; breaching it pauses and escalates | **approximate** — stated honestly in Cockpit |
| Team limits | `plan check` rejects owners outside `charter.team`; the watchdog flags tasks assigned outside it | watchdog |
| Outward actions and spend | **capabilities**: agents hold no publish/deploy/payment credentials; only the **outbox executor** does, and it checks the charter | **hard** (by absence of access) |
| Private data | cloud lanes refuse `~/Private`; staffing never routes money questions to a cloud model | **hard** (existing) |

**`auto_decompose` stays on.** Consequences: a task parked in `triage` from *anywhere* (Telegram, the Hermes dashboard, an agent) is split,
assigned and started within about a minute, and its children inherit the tenant. This is acceptable because (a) the decomposer only
assigns to profiles that exist, (b) everything it starts is throttled by the hard limits above, (c) outward actions cannot execute
without the outbox, and (d) the watchdog surfaces **untracked work**: tasks with no tenant, or a tenant with no active charter, in the
digest. Settings: `auto_promote_children: true` (unchanged), `orchestrator_profile: pm` (so a decomposed root returns to `pm` to judge completion),
`auxiliary.kanban_decomposer.model`: a working model (not `auto`).

## 9. The outbox, escalation, and the fixed floor

**Outbox.** An agent never sends, posts, deploys or pays itself. It writes an *outward action* (type, target, payload, project, task) to
the outbox. The executor checks the charter:

| Charter says | Outbox does |
|---|---|
| `allowed: true` / `auto` within its limits (targets, counts per week) | executes, logs, includes it in the digest |
| `draft-only` | stores the artifact ready to send; nothing leaves; it appears in the digest as "ready" (you may release it in one click, or enable `auto` in the charter) |
| not mentioned, over a limit, or a new recipient/target | **escalates**: one Needs-you item |

**Escalation triggers** (the only per-event asks): over budget or time box, scope change (outcome or done-when), `qa` fails twice, an
outward action the charter does not cover, a new agent outside `team`/`new_agents`, a taste/product decision the plan cannot resolve,
two failed replans.

**Fixed floor** (never autonomous, whatever a charter says): moving money or trading; touching raw personal-finance data (local-only
agent only); deleting or overwriting data outside the project's workspace; changing Hermes configuration or credentials; sending to a
recipient you have not approved. *Confirm this list (§14, item 3).*

## 10. Cockpit changes

**Portfolio page** becomes: Objectives (key-result bars) → Projects → Team → board cards.
```
AI Thrival                                    rolling · reviewed 1 Nov
 O1 Grow the Udemy course audience                                    [Review objective]
   KR1.1 500 enrolments     ▓▓▓▓░░░░░░  212 / 500
 Projects                                      owner  tasks         flags          age/timebox  lane-min
  ● udemy-course-2           active            pm     6 / 9 done    —              4d / 7d      52 / 120
  ◐ app-store-listing        charter proposed  pm     —             [Approve charter]
  ○ apa7-tool-promotion      proposed          —      —             [Approve charter]
```
**Project page** `#/p/<portfolio>/<id>`: charter, status, task graph (dependencies, status colour, agent per node), team with open
tasks, burn vs ceilings, outbox items (sent / ready / escalated), log. **Needs you** shows only: objective changes, charters, escalations
and ready-to-release outbox items. A **weekly digest** card summarises everything else. No "approve plan", no per-task approvals.

Data: a `projects` source (objectives, charters, tenant task counts, outbox, run durations), rollup `objectives[]`, `projects[]`,
`outbox[]`; guarded writes `POST /api/projects` (propose), `…/approve` (charter), `…/pause`, `…/outbox/:id/release`.

## 11. Atlas, `pm` and the CLI

- **`npm run work -- …`** (dry run unless `--apply`): `objective add|show`, `project propose|show|list`, `plan check|apply|diff`,
  `status`, `watch` (the watchdog; also run by cron), `close`, `outbox list|release`.
- **Atlas skill `portfolio-planning`**: draft KRs; propose projects as charters; run the staffing check *while drafting the charter*
  (new agents and models are part of what you approve); never start work before the charter is approved; escalate only on §9 triggers.
- **`pm` persona addendum**: plans in the §5.2 format, ≤ 9 tasks, one acceptance test each, decisions stamped into bodies, cheapest
  adequate lane, mark outward tasks; replans inside the charter without asking; logs every decision.
- **`qa`** is the independent verifier at the end of each pipeline.

## 12. Safety, privacy, cost

Family/household-finance projects plan and run on the local model only. Plans, charters and imported files are data to agents, never
instructions from outside. `plan apply` is idempotent; removed tasks are archived, never deleted. The watchdog and outbox keep a log you
can read in Cockpit. Cost control is honest about its limits: Hermes does not record tokens per task, so ceilings are lane-minutes and
recorded API spend, not exact token counts.

## 13. Migration pilot

1. **MicroPace → `notice-to-calendar-v1`**: export the Paperclip `spec` (MIC-2) into the KB; charter allows `deploy` to a preview URL
   and `publish: draft-only`; plan = gate → build → verify → write-up (MIC-4…MIC-7) for `coding`, `coding`, `qa`, `content`.
2. **AI Thrival → `udemy-course-1-growth`** (from AIT-4) and a second project for the APA 7 tool (AIT-1): owner `pm`, tasks for `content`,
   `publish: draft-only` at first.
3. Film tasks stay parked unless you say the film continues.

## 14. Decisions, phasing and effort

**Decisions (2026-11-01)**

| # | Question | Decision |
|---|---|---|
| 1 | Objective cadence | **Rolling**, reviewed weekly |
| 2 | Project size | **About one week, ≤ 9 tasks** |
| 3 | Approvals | **Objectives and project charters only.** Plans, tasks, assignments, models, replans: Atlas / `pm` decide. Outward actions follow the charter; the fixed floor in §9 stays human-only (**please confirm the floor**) |
| 4 | `auto_decompose` | **Stays on** (guardrails in §8) |
| 5 | Project owner | **`pm` drafts and owns** |
| 6 | Budgets | Default: ceilings in lane-minutes and recorded API spend + throttles + visibility (token caps are not enforceable). Tell me if you want different |
| 7 | KR numbers | Default: manual KPI files first |

| Phase | Deliverable | Effort |
|---|---|---|
| 1 | File formats, `work` CLI (`plan check/apply`, `status`), tests, refreshed `kb-template`, Hermes settings (§8) | 2–3 days |
| 2 | Outbox + executor stub and `work watch` watchdog; Atlas `portfolio-planning`; `pm` addendum; pilot on MicroPace | 3–4 days |
| 3 | Cockpit: objectives/projects on portfolio pages, project page, charter approval, digest | 3–4 days |
| 4 | Task graph view, burn charts, recurring templates, retrospective automation | 2–3 days |

## 15. Risks

| Risk | Mitigation |
|---|---|
| Fewer approvals means mistakes surface later | charter limits (team, ≤ 9 tasks, time box, outward list), the fixed floor, the weekly digest, an easy "pause project" |
| The decomposer ignores the 9-task cap | watchdog pauses the tenant and escalates; the root task body states the cap |
| Budget enforcement is approximate | say so in Cockpit; use hard throttles for the real limits |
| Capability-based outbox needs agents to hold no credentials | agents never get publish/deploy/payment credentials; only the executor does |
| Untracked work via triage | digest lists tasks without a chartered tenant |
| Plans drift from the board | Cockpit diff: plan keys vs tenant tasks |
| Objectives go stale | weekly review prompt; flagged after 8 days |
