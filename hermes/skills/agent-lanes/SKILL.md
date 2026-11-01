---
name: agent-lanes
description: Use when a kanban task (or a request from the user) should be executed by an external model — Claude Code or Codex for coding, OpenCode Zen / OpenRouter / OpenAI (API) for text work like writing and research, local Ollama for anything private. Hermes owns the task; the lane only produces input that Hermes verifies before completing or blocking the task.
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [kanban, lanes, claude-code, codex, opencode, openrouter, ollama, privacy]
    related_skills: [kanban-codex-lane, kanban-worker, cockpit, agent-roster]
---

# Agent lanes

One script runs every worker CLI with the same contract:

```
~/codes/personal-agent-platform/lanes/lane.sh <claude|codex|opencode-zen|openrouter|openai|ollama> <workdir> <prompt-file> <out-dir>
```

Outputs: `<out-dir>/result.md`, `<out-dir>/log.txt`, `<out-dir>/meta.json`. Exit code = the CLI's.
Exit 3 = refused by the privacy check (switch to `ollama`, never work around it). Exit 142 = timed out; an empty answer
is reported as a failed run (exit 1). Default model per lane: `lanes/models.conf`; `LANE_MODEL=…` overrides one run.

## Choosing a lane

| Task | Lane | Why |
|---|---|---|
| Code change, bug fix, refactor in a repo | `claude` | Claude Code subscription via the official CLI; may edit files (worktree) |
| Mechanical/bulk edits, second opinion on a diff | `codex` | Codex subscription via the official CLI; may edit files (worktree) |
| Drafts, rewrites, summaries, research notes | `openrouter` (cheap default), `opencode-zen` (free models) | Text only: runs in opencode's read-only `plan` agent, never edits files or runs commands |
| Same, when a specific OpenAI model is wanted | `openai` | Only after the user has set it up (`opencode auth login`); otherwise it is "not set up" |
| Anything touching personal finance, `~/Private`, statements, tax | `ollama` | Local only — the only lane allowed |
| Short answers, triage, status | none — answer directly | A lane run costs minutes |

Check a lane's health first if a task matters: the Cockpit chips show login, limits (claude, codex) and recorded
spend (API lanes). A subscription at its limit (codex at 100%) will fail — pick another lane.

If the user names a lane, use it unless the privacy rule forbids it.

## Procedure

1. `kanban_show` the task. If acceptance criteria are missing, ask (or `kanban_block` with the question).
2. Workspace: for code, use the task's worktree (`--workspace worktree`); never run a lane on `main`
   or in the user's working checkout.
3. Write the prompt file: goal, acceptance criteria, files that must not change, and
   "do not commit, push, deploy, send or post anything".
4. Run the lane with `<out-dir>` = the task workspace's `.lane/<lane>-<n>/`.
5. Verify yourself: read the diff, run the tests. The lane saying "done" is not evidence.
6. Then exactly one of: `kanban_complete` (summary + test result), `kanban request-review`
   (anything outward-facing: deploy, publish, send, spend — the user approves in Telegram), or
   `kanban_block` (with the precise question for the user).
7. Append durable learnings (decisions, preferences, gotchas) to the portfolio's knowledge repo
   `~/PortfolioKB/<portfolio>/decisions.md` — not to MEMORY.md, which is size-capped.

## Rules

- Outward-facing actions are never done by a lane. They go to `review` and wait for the user.
- Never pass raw financial documents, account numbers or `~/Private` paths to any lane but `ollama`.
  Summaries from `~/PrivateSummaries` are allowed.
- API lanes cost money per token: prefer `opencode-zen` (free) for throwaway drafts and keep prompts short.
- Never borrow CLI credentials for Hermes' own model calls; lanes run the official CLIs only.
- Two failed lane runs on the same task → stop and `kanban_block` with what was tried.
