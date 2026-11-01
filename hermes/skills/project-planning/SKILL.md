---
name: project-planning
description: For the pm agent. Use when a project charter has been approved and needs a plan, when a project's tasks need re-ordering, or when asked for project status. Writes a plan of at most 9 tasks inside the charter, checks it with the work tool, applies it, and reports by exception.
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [pm, planning, kanban, projects]
    related_skills: [portfolio-planning, agent-lanes]
---

# Project planning (pm)

You own approved projects. The charter is your boundary; the `work` tool enforces it.

```
npm run work -- project show <id>             # the approved charter (read it first)
npm run work -- plan check <id>               # ≤ 9 tasks, owners in the team, acceptance tests, no cycles, outward actions allowed
npm run work -- plan apply <id> --apply       # idempotent: creates the Hermes kanban tasks (tenant = project id)
npm run work -- plan diff <id>                # what is in Hermes vs the plan; stray tasks the decomposer made
npm run work -- status                        # progress and flags
npm run work -- close <id> --apply            # when every task is done
```

## Writing a plan
The plan is a `## Plan` block inside the project file (`~/PortfolioKB/<portfolio>/projects/<id>.md`). Each task has: `key`, `title`, `owner` (a team member), optional `lane` (`claude` for edits, `codex`, `opencode-zen`/`openrouter`/`openai` for read-only text, `ollama` for private), `needs` (keys), `accept` (one verifiable sentence), `outward` (`deploy|publish|spend` or none), `max_runtime`.

Shape that works: **gate** (cheapest check that the idea can work) → **build** → **verify** (a different agent, `qa`, on the real output) → **write-up**. Keep to the charter's `max_tasks`; if the work does not fit, cut scope, do not add tasks.

## Steps only the human can do
Some steps are not agent work: filling in App Store Connect, submitting a build, waiting for App Review, buying something, signing in to an account. Give such a step `owner: you` (no lane, no outward) and an `accept` that says how Frank confirms it. Then make **every task that depends on that outcome `needs` it**: e.g. launch posts, ads and the post-listing marketing plan `needs` the "App Review approved and live" step, so they cannot start before it. Frank marks the step done in Cockpit and the dependents start by themselves. Never invent a human step for something an agent can do.

## Rules
- Run `plan check` until it passes, then `plan apply`. Never create kanban tasks by hand for a project.
- Outward actions go through `work outbox submit`; you never publish, deploy or spend directly.
- If a task fails twice, or `qa` fails twice, stop and report to Atlas with the evidence. Do not retry forever.
- A scope change (new deliverable, new recipient, new agent) means a new charter: tell Atlas.
- After the project closes, add the lessons to `decisions.md` and the key-result progress to `objectives.md`.
