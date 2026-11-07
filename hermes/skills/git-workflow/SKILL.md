---
name: git-workflow
description: For every agent that edits code (coding, and any lane that writes files). Use at the start and end of any task that changes a repository: work on a feature branch linked to the task, commit when tests pass, push, and raise a pull request into the default branch; resolve conflicts yourself.
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [git, pull-request, branches, coding]
    related_skills: [agent-lanes, project-planning]
---

# Git workflow for code tasks

Two rules, set by Frank on 2026-11-07. They apply to every task that changes files in a repository.

## 1. Feature branch, linked to the task; commit when it passes
- Never edit the checkout's current branch. Use a worktree and a branch named for the task: `wt/<task_id>` (the kanban worktree) or `feat/<project>-<key>`.
- Never carry or commit other people's uncommitted changes. If the main checkout is dirty, you are in the wrong place: use a worktree.
- When the acceptance test **and** the project's test command pass, commit. The message names the task id (`[t_xxxx] what changed`). Do not commit if tests fail; fix them or block the task.

## 2. Every repo has a remote; changes land through a pull request
- `git remote -v` must show an `origin`. If it does not, block the task: "repo has no remote" (creating a remote is Frank's decision).
- Push the branch (`git push -u origin <branch>`) and raise a PR into the default branch: `gh pr create --base <default> --title "[t_xxxx] …" --body "task id, what changed, test output"`.
- Do not merge your own PR. Frank merges. Mark the task done with the PR URL in the hand-off.
- **Conflicts:** merge or rebase the default branch into your branch, resolve every conflict carefully (keep both sides' intent), re-run the tests, push. Try hard before giving up. If a conflict cannot be resolved safely (two incompatible designs, unclear intent), block the task and list the files.

## When something fails
Push rejected, `gh` not logged in, no network: **block the task with the exact error**. Do not merge locally to the default branch as a workaround, and never force-push it.

## Never
Force-push, rewrite published history, change `origin`, or touch another repo's branches.
