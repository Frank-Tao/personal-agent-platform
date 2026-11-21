---
name: git-workflow
description: For every agent that edits code (coding, and any lane that writes files). Use at the start and end of any task that changes a repository: work on a feature branch linked to the task, commit when tests pass, push, and raise a pull request into the default branch, and merge it yourself once the tests pass (or, where the project's merges are reviewed, request the merge through the outbox), with the test evidence in the PR; resolve conflicts yourself.
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [git, pull-request, branches, coding]
    related_skills: [agent-lanes, project-planning]
---

# Git workflow for code tasks

Two rules, set by Frank on 2026-11-07 (merge rule updated 2026-11-09). They apply to every task that changes files in a repository.

## 1. Feature branch, linked to the task; commit when it passes
- Never edit the checkout's current branch. Use a worktree and a branch named for the task: `wt/<task_id>` (the kanban worktree) or `feat/<project>-<key>`.
- Never carry or commit other people's uncommitted changes. If the main checkout is dirty, you are in the wrong place: use a worktree.
- When the acceptance test **and** the project's test command pass, commit. The message names the task id (`[t_xxxx] what changed`). Do not commit if tests fail; fix them or block the task.

## 2. Changes land through a pull request that you merge once the tests pass
- Pushing a branch and raising or merging a pull request on the project's own repository is part of this job. It is **not** an outward action (outward means email or messages to people outside the approved list, public posts, deploys, spending; commits, PRs, merges and KnowledgeBase writes are not); do not block a task on it, and do not ask for approval to do it. Frank has authorized it, as long as the evidence below exists.
- `git remote -v` should show an `origin`. New repos get a private GitHub twin when they are created. If there is no `origin`, do not block: commit on the branch, say the branch name and commit in the hand-off, and skip the push and PR.
- Push the branch (`git push -u origin <branch>`) and raise a PR into the default branch: `gh pr create --base <default> --title "[t_xxxx] …" --body "…"`.
- **The PR body must carry the evidence that testing passed:** the exact test command, the pass and fail counts, and the relevant output, plus the acceptance test result. A summary without the command and counts is not evidence.
- **Merge it yourself** (`gh pr merge --squash --delete-branch`) when, and only when, that evidence shows every test passing and any required checks on the PR are green. If tests fail, are missing, or the checks are red: do not merge; leave the PR open and block the task with the output.
- **Exception (rule from Frank, 2026-11-21): projects whose merges are reviewed.** If `npm run work -- project show <project>` prints `… approves merge …` (a merge to main deploys there), **do not merge yourself**. With the PR green, request it: `npm run work -- outbox submit <project> --kind merge --target <PR URL> --summary "<what it changes, test evidence>" --task <your task id> --apply`. The approver agent reviews it and the platform merges it once every check is green. Mark your task done with the PR URL and "merge requested (outbox <id>)".
- **Repository settings you cannot change:** a missing non-secret variable you know the value of: `npm run work -- outbox submit <project> --kind access --target github-variable:NAME --value "…" --summary "why" --apply`. A missing secret or an outside account: block the task, naming exactly which one; never guess or invent a value.
- Mark the task done with the PR URL, whether it was merged, and the evidence in the hand-off.
- **Conflicts:** merge or rebase the default branch into your branch, resolve every conflict carefully (keep both sides' intent), re-run the tests, push. Try hard before giving up. If a conflict cannot be resolved safely (two incompatible designs, unclear intent), block the task and list the files.

## When something fails
Push rejected, `gh` not logged in, no network: **block the task with the exact error**. Do not merge locally to the default branch as a workaround (only `gh pr merge` on a PR with passing evidence), and never force-push it.

## The platform repo is off limits except for `cockpit-improvement`
`personal-agent-platform` (Cockpit, the `work` CLI, skills, config) is the core app. Only tasks of the `cockpit-improvement` project may branch, edit or commit there. Any other project, and Atlas itself, files the change as Cockpit feedback instead. `work plan apply` refuses other projects whose repo or task workspace is inside it.

## Never
Force-push, rewrite published history, change `origin`, or touch another repo's branches.
