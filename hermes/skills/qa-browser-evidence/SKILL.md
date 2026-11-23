---
name: qa-browser-evidence
description: Use when you verify a requirement in a browser (a task with role verify): drive real Chrome with Playwright, capture one screenshot per acceptance item, ATTACH the evidence to your task from the terminal, and give an honest verdict. Compile and unit tests are not evidence.
version: 1.0.0
license: MIT
metadata:
  hermes:
    tags: [qa, browser, playwright, evidence, verify]
    related_skills: [git-workflow, project-planning]
---

# Verify in a browser, with evidence

You are the independent tester. The release is judged on what you ATTACH to your task, so evidence that stays in your workspace does not exist.

## You can do this
You have a terminal, Python with Playwright and Chrome on this Mac. Check in one line: `python3 ~/services/personal-agent-platform/lanes/ui-evidence.py --check` (it prints what is missing, if anything). Do not tell Frank you cannot run a browser: run the check first, and if something really is missing say exactly what.

## Steps
1. Check out the branch `req/<requirement-key>` in your own worktree (never the live checkout). Note `git rev-parse HEAD`. If it is not the commit the build hand-off names, block the task and say so: you test exactly what will be released.
2. Run the test command; keep the output in `test.log`.
3. Start the app on **synthetic data only** (real statements, holdings and personal documents are never opened by you). For a login screen use the project's no-auth switch (see its README).
4. Write a spec (JSON) with one check per acceptance item and run:
   `python3 ~/services/personal-agent-platform/lanes/ui-evidence.py spec.json evidence/ --attach <your task id> --board <the board in your task>`
   - one screenshot per item, named `ac<N>-<what>.png`, showing what the user sees after the action;
   - assertions on visible text (`text`, `not_text`, `visible`, `count`);
   - **routes** to stub or fail the network: an external site that blocks automated traffic, an offline service, a slow API. That is a test limitation, not a defect: stub it, say so in the report, and do not block on it.
5. The helper writes `ui-report.md` (item, expected, observed, PASS/FAIL, screenshot) and attaches every file. If it prints `NOT ATTACHED`, attach by path, never by pasting bytes: (a) in the terminal `hermes kanban --board <board> attach <task id> <file>` (one call per file; allowed for QA, Frank 2026-11-23), confirm with `hermes kanban --board <board> attachments <task id>`; (b) if the terminal command is refused, list the ABSOLUTE PATHS of the report, screenshots and logs in `artifacts` when you complete the task with `kanban_complete` (the kernel copies them to the task's durable attachments), or for a FAIL put them in `~/PortfolioKB/<portfolio>/evidence/<task id>/` and name that folder in the block reason. **Never the URL tool** (it refuses localhost) and never the base64 route for more than a tiny file. Keep each check small enough to finish and attach in one run; do not carry evidence across runs in the workspace.
6. Add `test.log` and anything else the report refers to.

## Verdict
- Every item passed and each has an attached screenshot: complete the task, with the commit you tested in the hand-off.
- An item failed, or has no attached screenshot: do **not** pass it. Block the task with the failing items, observed versus expected, and the screenshot. A real defect goes back to coding (the planner routes it); fixes land on the same branch `req/<key>`.
- Never invent, reuse or edit evidence. Do not weaken an item to make it pass; if the requirement and the system disagree (for example a cache rule against a refresh button), say so as a question and leave the item failed.
