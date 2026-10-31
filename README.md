# Personal AI Agent Platform

Paperclip (control plane) + Hermes (chief of staff / evolving workers) + **Portfolio HQ**
(this repo: rollup dashboard, brief, private local-model pipeline). See `requirement.md`,
`solution.md`, `implement_plan.md`.

```
npm run hq:demo     # dashboard with fake data  → http://127.0.0.1:3200 (HQ_PORT=… to change)
npm run hq          # real: Paperclip + private summaries + data/portfolio/*.json
npm run pipeline    # private pipeline (watches ~/Private/inbox, local Ollama only)
npm test            # 21 tests, zero dependencies (Node ≥ 24.11, built-in TS + sqlite)
```

## Connect Portfolio HQ to your running Paperclip

Paperclip here runs in `authenticated` mode, so HQ needs a board API key (`pcp_board_…`):

```
npx paperclipai auth login          # approve in the browser
npx paperclipai token board --help  # create a board key, then put it in infra/env
cp infra/env.example infra/env      # set PAPERCLIP_API_KEY=pcp_board_…
npm run hq                          # HTTP 403 "Board access required" disappears
```

## Privacy model (what is enforced today)

- The local model returns **numbers only**; code writes all summary text (`apps/private-pipeline/src/summarize.ts`).
- Every private summary passes a deterministic PII gate (`packages/redact`) before it is written
  *and* again before HQ reads it. Fails closed; error messages never echo content.
- **Not yet an OS boundary:** until `infra/bin/private-user.sh` is applied, the pipeline runs as your
  user, so other agents running as you could read `~/Private`. Do that before real statements go in.
- Drop files named `<account>-<anything>.txt|csv|md` (e.g. `checking-2026-09.txt`) into `~/Private/inbox`.
  PDFs: convert to text first (`pdftotext`) — not handled yet.

## Install order

`infra/bin/setup.sh` → `npm test` → `infra/bin/install-launchd.sh [--apply]` →
`hermes/install.sh [--apply]` → `infra/bin/private-user.sh [--apply]`.
All installers are dry-run unless you pass `--apply`.
