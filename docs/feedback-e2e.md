# Feedback loop end-to-end check (sandboxed, TEST DATA ONLY)

`npm run feedback:e2e` runs the whole feedback loop for real on a disposable board and prints one line: `PASS`, `FAIL at <step>` or
`BLOCKED`. Exit code 0 / 1 / 2. Evidence (`report.md`, `evidence.json`, the `sandbox.sb` profile used) goes to
`./TEST-DATA-ONLY-feedback-e2e-<time>/` (or `--out DIR`). The sandbox is deleted afterwards unless `--keep`. macOS only (sandbox-exec).

This is the sanctioned way for an agent (qa included) to prove the loop. It answers the four prerequisites qa asked for on t_bf8c5607:

| Prerequisite | How it is met | Checked by |
|---|---|---|
| An empty disposable board, exact slug and path | `feedback-e2e-sandbox`, created fresh in `<sandbox>/hermes/kanban/boards/` on every run | step `board` (list is empty) |
| An authorized native converter adapter | `work/e2e/hermes_native.py` calls Hermes' own kanban handler in-process for that one board; `nativeRunner` (sandbox.ts) is the converter's injected `run`. Both allow only `list show create edit link block` on that board, tasks of tenant `e2e-feedback-test` with its idempotency key, no workspace. The `hermes` launcher, git and every other program are refused | `adapter-refuses-real-board`, `sandbox.test.ts` |
| Positive dispatcher-exclusion proof | The dispatcher polls only `kanban_home()/kanban/boards`. The run asks Hermes' own `boards_root()` in the caller's environment and reads the running gateway's `HERMES_KANBAN_HOME`; the sandbox board must be outside every one and its slug absent from the real boards, before and after. The created task must end with 0 runs, no claim, no worker | `dispatcher-exclusion`, `-after`, `not-dispatched` |
| Verified real-data and egress containment | The run executes under `sandbox-exec`: writes only in the sandbox, no reads in the home folder except this repo's code (not `data/`, `infra/env`, `.git`) and Hermes' source and Python, network only on loopback, only node and the Hermes Python may run. Environment built from nothing: no tokens or keys, `FEEDBACK_WEEKLY=0`, empty outbox handlers. Probes must be refused: outbound TCP, DNS, reading `~/.hermes/kanban.db`, `auth.json`, `config.yaml`, writing in `~`, running `/bin/sh` and git | `containment` |

The worker write fence (`HERMES_DELEGATED_CHILD_CONTEXT`) is passed through unchanged. It guards the real board root; the sandbox board
is outside it, so nothing is bypassed and the real boards stay protected.

## What runs

1. `[TEST DATA ONLY]` note through Cockpit's real `POST /api/feedback` (createApp on 127.0.0.1, feedback dependencies only; actor `test-cockpit`).
2. A differently worded note through the Telegram path, `work feedback add --source telegram --by test-telegram` (what the Atlas skill runs; nothing is sent).
3. `work feedback digest --apply`: one proposal holding both notes, sources cockpit + telegram.
4. Cockpit's real `POST /api/feedback/decide` approves it (actor `test-owner`).
5. `work feedback approve <proposal> --into e2e-feedback-test --apply`: plan edit and the real `plan apply`, through the adapter.
6. The task is read back from the board (marker, tenant, idempotency key); a second approve is a no-op; the task was never dispatched.

## Not covered

- Cockpit's Approve records the decision only; conversion is the separate `work feedback approve --into` (design §7 says it should follow at once). The check runs both, as they exist today.
- The weekly Telegram notice (`feedback weekly`) is never run: it would send.
