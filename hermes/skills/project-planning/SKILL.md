---
name: project-planning
description: For the pm agent. Use when a project charter has been approved and needs a plan, when a project's tasks need re-ordering, or when asked for project status. Writes a plan within the charter's limit of active tasks (usually 20), checks it with the work tool, applies it, and reports by exception.
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
npm run work -- plan check <id>               # ≤ 20 active tasks, owners in the team, acceptance tests, no cycles, outward actions allowed
npm run work -- plan apply <id> --apply       # idempotent: creates the Hermes kanban tasks (tenant = project id)
npm run work -- plan diff <id>                # what is in Hermes vs the plan; stray tasks the decomposer made
npm run work -- status                        # progress and flags
npm run work -- project deliver <id> --summary "what it is" --url http://… --start "how to run it" --doc "Title|docs/file.md" --apply   # BEFORE closing
npm run work -- close <id> --apply            # when every task is done (refused until a delivery is recorded)
```

## Writing a plan
The plan is a `## Plan` block inside the project file (`~/PortfolioKB/<portfolio>/projects/<id>.md`). Each task has: `key`, `title`, `owner` (a team member), optional `lane` (`claude` for edits, `codex`, `opencode-zen`/`openrouter`/`openai` for read-only text, `ollama` for private), `needs` (keys), `accept` (one verifiable sentence), `outward` (`deploy|publish|spend` or none), `max_runtime`, and **`why`: one line on why this owner** (what in the task matches the agent's strength or record, e.g. "coding: Swift change with tests; 37 done, 76% first time"). Check the record first with `npm run work -- scorecard`; prefer an agent marked trusted or steady for this kind of work, and say so in `why` when you pick one marked watch or new. The reason is shown next to how the task went, so it is how your choices earn trust.

Shape that works: **gate** (cheapest check that the idea can work) → **build** → **verify** (a different agent, `qa`, on the real output) → **write-up**. Keep to the charter's `max_tasks` active tasks; if the work does not fit, regroup or cut scope, do not just add tasks.

## Staying inside the limit of active tasks (rule from Frank, 2026-11-07; changed 2026-11-18)
The charter allows at most `max_tasks` **active** top-level tasks (usually 20). **Active means not done and not archived: finished tasks no longer count, so when work is done its slot is free again and you may add new tasks.** Subtasks never count. **Before you add a task, count the active ones** (`npm run work -- plan check <id>` says if the plan is over).

If the plan would go over the limit, do not ask for more room and do not drop work:
1. **Regroup:** `npm run work -- plan regroup <id>` (a dry run) shows which tasks can become subtasks of the one that needs them; add `--apply` to do it (it also updates the Hermes tasks). Only tasks that are a prerequisite of exactly one other task, and are not running, are moved.
2. **Merge** steps that one agent can do in one sitting into one task, and turn the remaining small steps into **subtasks** of the closest top-level task (a nested `subtasks:` list; one level only, at most 9 per parent; they run in their own workspaces). Keep the parent's `accept` as the wrap-up check of its subtasks.
3. Only when the work truly cannot fit even after that is it a scope change: tell Atlas to split the project in two.

## Steps only the human can do
Some steps are not agent work: filling in App Store Connect, submitting a build, waiting for App Review, buying something, signing in to an account. Give such a step `owner: you` (no lane, no outward) and an `accept` that says how Frank confirms it. Then make **every task that depends on that outcome `needs` it**: e.g. launch posts, ads and the post-listing marketing plan `needs` the "App Review approved and live" step, so they cannot start before it. Frank marks the step done in Cockpit and the dependents start by themselves. Never invent a human step for something an agent can do.

## Rules
- Run `plan check` until it passes, then `plan apply`. Never create kanban tasks by hand for a project.
- Outward actions go through `work outbox submit`; you never publish, deploy or spend directly.
- If a task fails twice, or `qa` fails twice, stop and report to Atlas with the evidence. Do not retry forever.
- A scope change (new deliverable, new recipient, new agent) means a new charter: tell Atlas.
- **Record what was delivered** before the project closes (`project deliver`): one or two sentences on what it is, the address to open it (if it has one) and how to start it, and the documents to read. Cockpit's "Delivered" panel shows that next to the screenshots and reports the tasks attached, and it is how Frank checks that "done" is real. Have the verify/write-up task attach its screenshots (`hermes kanban attach <task> <file>`), not only describe them. `close` is refused without a delivery.
- After the project closes, add the lessons to `decisions.md` and the key-result progress to `objectives.md`.

## Full-automation projects
If `project show` says `automation: full`, nobody reviews the result: include a final QA task (owner `qa`) whose acceptance is "every done-when item checked, with evidence". The project closes by itself when it is done. Record decisions as proposed; they are confirmed the next day unless Frank rejects them.

## A new requirement: a small chain, linked, proved in a browser

When a task of yours carries a **Requirement** (what the owner asked, after the project was planned), you do not build it. Turn it into **at most three top-level tasks, one of each kind**, every task linked with `--req <requirement-key>`:

1. **build** (owner coding): works on the branch `req/<key>`, commits and pushes, opens no pull request and does not merge. Every fix goes on the same branch.
2. **verify** (owner qa, `--needs` the build): tests that branch and proves **every** acceptance item by driving a real browser, one report and one set of screenshots attached to its task (`python3 ~/services/personal-agent-platform/lanes/ui-evidence.py <spec.json> <out-dir> --attach <task id> --board <board>`; skill qa-browser-evidence). One verify task for the whole requirement, not one per feature.
3. **release** (owner coding, `--needs` the verify): raises the pull request with the requirement, the plan and the evidence in its body, then `work outbox submit … --kind merge --req <key>`. Full automation: released to merge once the checks are green. Semi: it waits for Frank. The outbox refuses it without screenshots from a passing verify task. Deploy only where the charter allows it.

### Slice the build and check each slice in parallel (rule from Frank, 2026-11-23)
A single worker given a whole requirement timed out twice at the 2-hour limit and produced almost nothing; the same build cut into 11 slices finished in about an hour. So **a build is never one task of one worker**. The build task is the wrap-up; its subtasks are:
- **Slices** (`--role build --parent <build> --req <key>`, 45-minute cap by default): small pieces in the design's coding order, each with its own tests. Slice N+1 `--needs` only slice N. A slice that cannot finish in 45 minutes is too big: cut it. **A slice commits and pushes only after its own tests, the full suite of every package it touched and the type check all pass**; if they fail it commits nothing and reports what failed.
- **Checks** (`--role verify --owner qa --parent <build> --req <key> --needs <that slice only>`): one per slice a person can see or use. QA tests exactly the commit that slice's hand-off names, in its own detached worktree, on its own port, while the next slice is being built. Slices with no visible behaviour (types, schema, pure functions) need no check; their tests gate their commit.
- **A slice never `--needs` a check** (the system refuses it), so building never waits for testing. A failed check blocks with the failing items; the fix is a new build subtask (`--needs` the slice that failed) on the same branch, then the check is retried.
- The top-level **verify** still runs last as the final integration pass over the whole acceptance matrix, but by then each slice has been proved, so it should find integration gaps, not first-time defects. QA attaches evidence to the task (screenshots, report, test and build logs); evidence left in a workspace does not count.

**Anything else is a subtask**, not a fourth top-level task (`--parent <the task it belongs to>`): another agent's part (a local-model study by `personal`, a UI part), a separate piece of work, a step for Frank (owner `you`, under the release). A parent runs after its subtasks and wraps them up. The system refuses a second top-level task of the same kind and a fourth top-level task for one requirement.

```
npm run work -- plan edit <id> --op add --key <k> --title "…" --owner coding --accept "…" --req <requirement-key> --role build --apply
npm run work -- plan edit <id> --op add --key <k2> --title "…" --owner personal --accept "…" --req <requirement-key> --parent <k> --apply
```

Cockpit's "Requirements and releases" panel shows each requirement's chain (plan, build, browser test, pull request, merge, deploy) with the screenshots. If a verify task fails, the fix is a subtask of the build (same branch), and the verify task is retried.
