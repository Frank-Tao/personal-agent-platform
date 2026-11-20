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

Work model: Portfolio → rolling Objective → Project (about a week, at most 20 active tasks at a time, owner `pm`) → Task.
The user approves **objectives** and **project charters** only. Everything below that is yours and `pm`'s to decide; do not ask about task order, wording, or which agent.

Tool (run from `~/services/personal-agent-platform`; every change is a dry run until `--apply`):

```
npm run work -- objective show [portfolio]
npm run work -- objective add <portfolio> --title "…" --kr "…" --apply        # only after the user agrees on the wording
npm run work -- project propose <portfolio> --id <slug> --outcome "…" --done-when "…" --team a,b [--deploy-targets host] [--autonomy full] --apply
npm run work -- project set <id> --autonomy semi|full --apply
npm run work -- status [portfolio]            npm run work -- outbox list            npm run work -- watch
```

## When the user gives a goal
1. `objective show` for the portfolio. If the goal is new, propose it as an objective with 1–3 measurable key results and ask for a yes.
2. Draft **one** project toward the next key result: a one-sentence outcome, 2–5 `done_when` checks that can be verified, the team (existing agents only, unless a catalog persona is clearly needed — then follow `agent-staffing`), deploy targets / publish channels if any.
3. Run `project propose … --apply`. Hand the charter to `pm` to write the plan. Tell the user, in four lines: outcome, team, what goes outward and where, and what you will do without asking. Ask for approval once.
4. The user approves with `work project approve <id> --apply` (or tells you to run it). Only then does `pm` run `plan apply`.

## Automation level (per project; rule from Frank, 2026-11-20)
Every project is **semi** (default) or **full**:
- **semi:** Frank approves the charter, reviews the finished project, and confirms agents' proposed decisions. As before.
- **full:** the charter starts by itself 4 hours after it is proposed unless Frank stops it; when every task is done and the plan had a **QA step**, the project closes by itself; agents' proposed decisions are confirmed the next day unless he rejects them. Open questions still need an answer.
- Full never covers deploys, auto-publishing, spending or new agents: a charter with any of those waits for Frank even on full (`project show` says why). Publishing as a draft is fine.
- Use full only when Frank asks for it ("run it yourself", "fully automate", "don't ask me") or set it as his standing rule for that kind of work: `project propose … --autonomy full`. Tell him in one line: "Starts by itself at HH:MM unless you say stop." If he says stop: `project set <id> --autonomy semi --apply`.
- On full, plan a QA verification task (owner `qa`) that checks every done-when item; without it the project stops at review for Frank.

## Ask the user only when
- the charter (semi, or full with a deploy/spend/new agent), or an objective, needs approval
- the watchdog paused a project (over scope, time or budget)
- the outbox holds something outward (publish draft, spend, a deploy to a new place)
- a task needs a decision only the user can make (money, private data, a new recipient)

Everything else: decide, record the decision in the project's "Context and decisions" section, move on.

## Task limit when you create tasks (rule from Frank, 2026-11-07; changed 2026-11-18)
A project has at most `max_tasks` **active** top-level tasks (usually 20); more makes the watchdog pause it. Finished tasks (done or archived) and subtasks do not count, so a project whose tasks are done has room again. Before you create a task for a project, check its active count (`npm run work -- status <portfolio>`). If this one would go over the limit, first try `npm run work -- plan regroup <project>` (a dry run: it shows tasks that can become subtasks of the one that needs them; `--apply` does it), or **merge it into an existing task or make it a subtask** of the closest one (say so in that task's comment). If it still cannot fit, it is a scope change: propose splitting the project and ask.

## Never
- Start tasks for a `proposed` charter. Edit a charter's `never` list, `outward` rules or `team` after approval (propose a new charter instead).
- Do an outward action yourself: submit it with `work outbox submit …` and let the charter decide.
