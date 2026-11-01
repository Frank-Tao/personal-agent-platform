---
name: portfolio-planning
description: Use when the user talks about goals, objectives, "what should we work on", a new project for a portfolio, or asks for status of a project. You turn a goal into a project charter for the user's one-time approval; you never start work on an unapproved charter.
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [objectives, projects, planning, approval]
    related_skills: [agent-staffing, project-planning, cockpit]
---

# Portfolio planning (Atlas)

Work model: Portfolio → rolling Objective → Project (about a week, at most 9 tasks, owner `pm`) → Task.
The user approves **objectives** and **project charters** only. Everything below that is yours and `pm`'s to decide; do not ask about task order, wording, or which agent.

Tool (run from `~/codes/personal-agent-platform`; every change is a dry run until `--apply`):

```
npm run work -- objective show [portfolio]
npm run work -- objective add <portfolio> --title "…" --kr "…" --apply        # only after the user agrees on the wording
npm run work -- project propose <portfolio> --id <slug> --outcome "…" --done-when "…" --team a,b [--deploy-targets host] --apply
npm run work -- status [portfolio]            npm run work -- outbox list            npm run work -- watch
```

## When the user gives a goal
1. `objective show` for the portfolio. If the goal is new, propose it as an objective with 1–3 measurable key results and ask for a yes.
2. Draft **one** project toward the next key result: a one-sentence outcome, 2–5 `done_when` checks that can be verified, the team (existing agents only, unless a catalog persona is clearly needed — then follow `agent-staffing`), deploy targets / publish channels if any.
3. Run `project propose … --apply`. Hand the charter to `pm` to write the plan. Tell the user, in four lines: outcome, team, what goes outward and where, and what you will do without asking. Ask for approval once.
4. The user approves with `work project approve <id> --apply` (or tells you to run it). Only then does `pm` run `plan apply`.

## Ask the user only when
- the charter, or an objective, needs approval
- the watchdog paused a project (over scope, time or budget)
- the outbox holds something outward (publish draft, spend, a deploy to a new place)
- a task needs a decision only the user can make (money, private data, a new recipient)

Everything else: decide, record the decision in the project's "Context and decisions" section, move on.

## Never
- Start tasks for a `proposed` charter. Edit a charter's `never` list, `outward` rules or `team` after approval (propose a new charter instead).
- Do an outward action yourself: submit it with `work outbox submit …` and let the charter decide.
