import { execFileSync, spawnSync } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join, relative, resolve } from 'node:path';
import { main as work } from '../cli.ts';
import { createApp, type AppDeps } from '../../apps/cockpit/src/app.ts';
import type { Person } from '../../apps/cockpit/src/identity.ts';
import { addFeedback, list as listFeedback } from '../../packages/work/feedback.ts';
import { decide, listProposals } from '../../packages/work/decide.ts';
import { readProposals } from '../../packages/work/digest.ts';
import { LABEL, NATIVE_BIN, REPO, createSandbox, defaultBase, findHermes, nativeRunner, profile, realKanbanHome, removeSandbox, type Sandbox } from './sandbox.ts';

// The feedback loop, end to end, on a disposable board: TEST DATA ONLY.  npm run feedback:e2e [-- --keep] [--out DIR] [--base DIR]
//
// Two fabricated notes saying the same thing (one through Cockpit's HTTP intake, one through the Telegram path, `work feedback add
// --source telegram`, which is what the Atlas skill runs) → `work feedback digest` merges them into one proposal → approved through
// Cockpit's real POST /api/feedback/decide → `work feedback approve --into` converts it, through the real plan apply, into a task on
// the sandbox board → read back, retried for idempotency, and checked that no dispatcher touched it.
//
// The outer process (not sandboxed) makes the sandbox, proves the real dispatcher cannot see its board, runs the inner process under
// sandbox-exec, writes the report outside the sandbox, and deletes the sandbox (unless --keep). Exit: 0 PASS, 1 FAIL, 2 BLOCKED.

interface Step { name: string; ok: boolean; detail: unknown }
interface Evidence { verdict?: 'PASS' | 'FAIL' | 'BLOCKED'; started: string; finished?: string; steps: Step[]; notRun: string[]; calls?: Sandbox['calls'] }
const STEPS = ['containment', 'board', 'project', 'cockpit-intake', 'telegram-intake', 'consolidate', 'approve', 'convert', 'readback', 'idempotent-retry', 'not-dispatched', 'adapter-refuses-real-board'] as const;

const flagOf = (argv: string[], k: string) => { const i = argv.indexOf(`--${k}`); return i === -1 ? undefined : argv[i + 1]; };

/* ---------------- outer: outside the jail ---------------- */

/** Positive proof the real dispatcher cannot see the sandbox board: where Hermes itself (and the running gateway) look for boards. */
export function dispatcherProof(s: Sandbox): { ok: boolean; detail: Record<string, unknown> } {
  const board = join(s.hermesHome, 'kanban', 'boards', s.board);
  const outside = (root: string) => { const r = relative(root, board); return r.startsWith('..') || resolve(root, r) !== board; };
  const roots: Record<string, string> = {};
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('FEEDBACK_E2E_')) delete env[k];
  try {
    // Hermes' own boards_root(), in this caller's environment: the function the dispatcher polls with.
    roots.callerBoardsRoot = execFileSync(s.python, ['-I', '-B', '-c', 'import sys; sys.path.insert(0, sys.argv[1]); from hermes_cli import kanban_db as kb; print(kb.boards_root().resolve())', s.agentDir], { env, encoding: 'utf8', timeout: 60_000 }).trim();
  } catch (e) { roots.callerBoardsRoot = `unreadable: ${(e as Error).message.slice(0, 120)}`; }
  roots.defaultBoardsRoot = join(s.realKanbanHome, 'kanban', 'boards');
  // The running gateway (the dispatcher's host): its HERMES_KANBAN_HOME, if it set one; ps shows a process's environment to its owner.
  try {
    const pid = readFileSync(join(homedir(), '.hermes', 'gateway.pid'), 'utf8').trim().match(/\d+/)?.[0];
    const ps = pid ? execFileSync('ps', ['eww', '-o', 'command=', '-p', pid], { encoding: 'utf8', timeout: 10_000 }) : '';
    const m = ps.match(/\bHERMES_KANBAN_HOME=(\S+)/);
    roots.gatewayBoardsRoot = m ? join(m[1], 'kanban', 'boards') : pid ? `${roots.defaultBoardsRoot} (gateway pid ${pid} sets no HERMES_KANBAN_HOME)` : 'no gateway pid file';
  } catch { roots.gatewayBoardsRoot = 'gateway not inspectable'; }
  const paths = Object.values(roots).map((r) => r.split(' ')[0]).filter((r) => r.startsWith('/'));
  const listed = existsSync(roots.defaultBoardsRoot) ? readdirSync(roots.defaultBoardsRoot) : [];
  const ok = paths.length > 0 && paths.every(outside) && !listed.includes(s.board);
  return { ok, detail: { sandboxBoard: board, ...roots, sandboxBoardOutsideEveryRoot: paths.every(outside), slugOnRealBoards: listed.includes(s.board), realBoards: listed.filter((b) => !b.startsWith('_')) } };
}

function outer(argv: string[]): number {
  const keep = argv.includes('--keep');
  const hermes = findHermes();
  const base = flagOf(argv, 'base') ?? defaultBase(realKanbanHome());
  const s = createSandbox(base, { hermes });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = resolve(flagOf(argv, 'out') ?? join(process.cwd(), `TEST-DATA-ONLY-feedback-e2e-${stamp}`));
  mkdirSync(out, { recursive: true });
  const before = dispatcherProof(s);
  const sb = join(s.root, 'sandbox.sb');
  writeFileSync(sb, profile(s));
  writeFileSync(join(s.root, 'sandbox.json'), JSON.stringify({ ...s, env: undefined, calls: undefined, realUserHome: homedir() }, null, 2));
  let ev: Evidence = { started: new Date().toISOString(), steps: [], notRun: [...STEPS] };
  if (!before.ok) {
    ev.verdict = 'BLOCKED';
    ev.steps.push({ name: 'dispatcher-exclusion', ok: false, detail: before.detail });
  } else {
    const r = spawnSync('/usr/bin/sandbox-exec', ['-f', sb, process.execPath, import.meta.filename, '--inner', s.root], { env: s.env, encoding: 'utf8', timeout: 15 * 60_000 });
    process.stdout.write(r.stdout ?? '');
    const file = join(s.evidence, 'evidence.json');
    if (existsSync(file)) ev = JSON.parse(readFileSync(file, 'utf8'));
    else ev.steps.push({ name: 'inner', ok: false, detail: { status: r.status, signal: r.signal, stderr: (r.stderr ?? '').slice(-2000) } });
    ev.steps.unshift({ name: 'dispatcher-exclusion', ok: true, detail: before.detail });
    const after = dispatcherProof(s);
    ev.steps.push({ name: 'dispatcher-exclusion-after', ok: after.ok, detail: after.detail });
    const allOk = ev.steps.every((x) => x.ok) && !ev.notRun.length;
    ev.verdict = allOk ? 'PASS' : ev.steps.find((x) => x.name === 'containment')?.ok === false ? 'BLOCKED' : 'FAIL';
  }
  ev.finished = new Date().toISOString();
  copyFileSync(sb, join(out, 'sandbox.sb'));
  writeFileSync(join(out, 'evidence.json'), JSON.stringify(ev, null, 2));
  writeFileSync(join(out, 'report.md'), report(ev, s, keep));
  if (!keep) removeSandbox(s.root, base);
  const failed = ev.steps.find((x) => !x.ok);
  console.log(`${LABEL} feedback loop e2e: ${ev.verdict}${failed ? ` at ${failed.name}` : ''} — report ${join(out, 'report.md')}${keep ? `; sandbox kept at ${s.root}` : '; sandbox deleted'}`);
  return ev.verdict === 'PASS' ? 0 : ev.verdict === 'BLOCKED' ? 2 : 1;
}

function report(ev: Evidence, s: Sandbox, keep: boolean): string {
  const short = (d: unknown) => '```json\n' + JSON.stringify(d, null, 2).slice(0, 3000) + '\n```';
  return [
    `# ${LABEL} Feedback loop end-to-end: ${ev.verdict}`, '',
    `Run ${ev.started} → ${ev.finished}. Sandbox ${s.root} (${keep ? 'kept' : 'deleted after the run'}); board \`${s.board}\` under its own kanban home; project \`${s.project}\`.`,
    'Every input, proposal, decision and task here is fabricated test data. No real board, KB, feedback store, credential or network was used.', '',
    '| # | Step | Result |', '|---|---|---|',
    ...ev.steps.map((x, i) => `| ${i + 1} | ${x.name} | ${x.ok ? 'PASS' : 'FAIL'} |`),
    ...ev.notRun.map((n) => `| – | ${n} | NOT RUN |`), '',
    ...ev.steps.flatMap((x) => [`## ${x.name}: ${x.ok ? 'PASS' : 'FAIL'}`, short(x.detail), '']),
    '## Board calls made by the converter (adapter audit)', short(ev.calls ?? []), '',
  ].join('\n');
}

/* ---------------- inner: inside sandbox-exec ---------------- */

const denied = (e: unknown) => /EPERM|EACCES|not permitted|ENOTFOUND|EAI_|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|timed out/i.test(String((e as Error)?.message ?? e) + String((e as { code?: string })?.code ?? ''));

async function probe(name: string, fn: () => Promise<unknown> | unknown): Promise<{ name: string; denied: boolean; result: string }> {
  try { const r = await fn(); return { name, denied: false, result: `ALLOWED: ${String(r).slice(0, 80)}` }; }
  catch (e) { return { name, denied: denied(e), result: String((e as Error).message ?? e).slice(0, 160) }; }
}

function tcp(host: string, port: number, ms = 3000): Promise<string> {
  return new Promise((ok, no) => {
    const sock = connect({ host, port });
    const t = setTimeout(() => { sock.destroy(); no(new Error('timed out')); }, ms);
    sock.once('connect', () => { clearTimeout(t); sock.destroy(); ok('connected'); });
    sock.once('error', (e) => { clearTimeout(t); no(e); });
  });
}

async function inner(rootArg: string): Promise<number> {
  const meta = JSON.parse(readFileSync(join(rootArg, 'sandbox.json'), 'utf8')) as Sandbox & { realUserHome: string };
  const s: Sandbox = { ...meta, env: process.env, calls: [] };
  const run = nativeRunner(s);
  const ev: Evidence = { started: new Date().toISOString(), steps: [], notRun: [...STEPS] };
  const save = () => { ev.calls = s.calls; writeFileSync(join(s.evidence, 'evidence.json'), JSON.stringify(ev, null, 2)); };
  const lines: string[] = [];
  const cli = (...argv: string[]) => { lines.length = 0; const code = work(argv, { ...process.env }, (x) => lines.push(x), run); return { code, out: lines.join('\n') }; };
  const kb = (...a: string[]) => run(NATIVE_BIN, ['kanban', '--board', s.board, ...a]);
  let srv: Server | undefined;
  const step = async (name: string, fn: () => Promise<unknown> | unknown) => {
    try {
      const detail = await fn();
      ev.steps.push({ name, ok: true, detail });
      ev.notRun = ev.notRun.filter((n) => n !== name);
      return true;
    } catch (e) {
      ev.steps.push({ name, ok: false, detail: { error: (e as Error).message, cli: lines.slice(-20) } });
      ev.notRun = ev.notRun.filter((n) => n !== name);
      return false;
    } finally { save(); }
  };
  const must = (cond: unknown, why: string) => { if (!cond) throw new Error(why); };
  const cockpitText = `${LABEL} Blocked tasks are hidden on the project page`;
  const telegramText = `${LABEL} Project page hides blocked tasks, please show them`;
  let base = '', fbCockpit = '', fbTelegram = '', proposalId = '', taskId = '', key = '';
  const post = (path: string, body: unknown, actor: string) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'x-test-actor': actor }, body: JSON.stringify(body) });

  try {
    if (!await step('containment', async () => {
      const probes = [
        await probe('outbound TCP 1.1.1.1:443', () => tcp('1.1.1.1', 443)),
        await probe('DNS lookup example.com', () => lookup('example.com')),
        await probe('read real kanban.db', () => readFileSync(join(s.realKanbanHome, 'kanban.db')).length),
        await probe('read real Hermes auth.json', () => readFileSync(join(s.realKanbanHome, 'auth.json')).length),
        await probe('read real Hermes config.yaml', () => readFileSync(join(s.realKanbanHome, 'config.yaml')).length),
        // infra/env holds the platform's secrets; a working copy may not have one (it is not tracked). existsSync only stats it.
        ...(existsSync(join(REPO, 'infra', 'env')) ? [await probe('read repo infra/env', () => readFileSync(join(REPO, 'infra', 'env')).length)] : []),
        await probe('write in real home', () => writeFileSync(join(meta.realUserHome, '.feedback-e2e-probe'), 'x')),
        await probe('run /bin/sh', () => execFileSync('/bin/sh', ['-c', 'true'])),
        await probe('run git', () => execFileSync('/usr/bin/git', ['--version'])),
      ];
      // A file that does not exist proves nothing about permissions, so ENOENT on a read counts as not proven.
      const bad = probes.filter((p) => !p.denied || /ENOENT/.test(p.result));
      const loop = await new Promise<string>((ok, no) => { const t = createServer(); t.listen(0, '127.0.0.1', () => tcp('127.0.0.1', (t.address() as AddressInfo).port).then((r) => { t.close(); ok(r); }, no)); });
      const secrets = Object.keys(process.env).filter((k) => /TOKEN|SECRET|PASSWORD|API_KEY|TELEGRAM|ANTHROPIC|OPENAI|AWS_/i.test(k));
      must(!bad.length, `not contained: ${bad.map((p) => `${p.name} → ${p.result}`).join('; ')}`);
      must(!secrets.length, `credential variables present: ${secrets.join(', ')}`);
      must(loop === 'connected', 'loopback does not work');
      return { probes, loopback: loop, envKeys: Object.keys(process.env).sort(), fence: process.env.HERMES_DELEGATED_CHILD_CONTEXT ?? 'not set (not running under a worker)' };
    })) return 1;

    if (!await step('board', () => {
      run(NATIVE_BIN, ['kanban', 'boards', 'create', s.board]);
      const tasks = JSON.parse(kb('list', '--json'));
      must(Array.isArray(tasks) && tasks.length === 0, 'the new board is not empty');
      return { board: s.board, db: join(s.hermesHome, 'kanban', 'boards', s.board, 'kanban.db'), tasks: tasks.length };
    })) return 1;

    if (!await step('project', () => {
      let r = cli('project', 'propose', 'micropace', '--id', s.project, '--outcome', `${LABEL} sandbox project that receives converted feedback`, '--done-when', `${LABEL} the converted task exists`, '--team', 'coding,qa', '--publish', 'no', '--apply');
      must(r.code === 0, `propose failed: ${r.out}`);
      r = cli('project', 'approve', s.project, '--apply');
      must(r.code === 0, `approve failed: ${r.out}`);
      return { project: s.project, approve: r.out.split('\n').slice(-6) };
    })) return 1;

    const person = (name: string): Person => ({ name, hide: [], device: 'feedback-e2e-sandbox', system: true });
    const no = (what: string) => () => { throw new Error(`${what} is not wired in the feedback sandbox`); };
    const pub = join(s.root, 'public'); mkdirSync(pub, { recursive: true }); writeFileSync(join(pub, 'index.html'), '<html>sandbox</html>');
    const o = { dir: s.data };
    const deps = {
      publicDir: pub, guard: { allowedHosts: [] }, chat: { apiUrl: 'http://127.0.0.1:1', apiKey: '' },
      tasks: { run: async () => { throw new Error('tasks are not wired in the feedback sandbox'); }, boardFor: () => undefined },
      getRollup: async () => { throw new Error('rollup is not wired in the feedback sandbox'); }, history: () => [], agentDetail: () => null, catalog: () => [],
      privacyAsk: async () => { throw new Error('privacy is not wired in the feedback sandbox'); }, growthRun: no('growth'), agentsRun: no('agents'), work: no('work'),
      modelsPath: join(REPO, 'config', 'models.json'), invalidate: () => {},
      identify: (req: import('node:http').IncomingMessage) => person(String(req.headers['x-test-actor'] ?? 'test-anonymous')),
      addFeedback: (i: Parameters<typeof addFeedback>[0]) => addFeedback(i, o), feedbackProposals: () => listProposals(o), feedbackNotes: () => listFeedback(o), decideProposal: (i: Parameters<typeof decide>[0]) => decide(i, o),
    } as unknown as AppDeps;
    srv = createServer((q, r) => void createApp(deps)(q, r));
    await new Promise<void>((ok) => srv!.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

    if (!await step('cockpit-intake', async () => {
      const r = await post('/api/feedback', { text: cockpitText, page: '#/project/e2e-feedback-test' }, 'test-cockpit');
      const j = await r.json() as { id: string };
      must(r.status === 201, `POST /api/feedback answered ${r.status} ${JSON.stringify(j)}`);
      fbCockpit = j.id;
      return { http: `POST ${base}/api/feedback → ${r.status}`, item: listFeedback(o).find((i) => i.id === fbCockpit) };
    })) return 1;

    if (!await step('telegram-intake', () => {
      const r = cli('feedback', 'add', '--source', 'telegram', '--by', 'test-telegram', '--ref', 'test-chat:0001', '--text', telegramText, '--apply');
      must(r.code === 0 && /recorded fb-/.test(r.out), `feedback add: ${r.out}`);
      fbTelegram = r.out.match(/fb-[\w-]+/)![0];
      return { cli: r.out, item: listFeedback(o).find((i) => i.id === fbTelegram) };
    })) return 1;

    if (!await step('consolidate', () => {
      const r = cli('feedback', 'digest', '--apply');
      must(r.code === 0, `digest: ${r.out}`);
      const p = readProposals(s.data).find((x) => x.evidence.some((e) => e.id === fbCockpit) && x.evidence.some((e) => e.id === fbTelegram));
      must(p, `no single proposal holds both ${fbCockpit} and ${fbTelegram}: ${r.out}`);
      must(p!.sources.includes('cockpit') && p!.sources.includes('telegram'), `sources ${p!.sources}`);
      proposalId = p!.id;
      return { digest: r.out, proposal: p };
    })) return 1;

    if (!await step('approve', async () => {
      const listed = await (await fetch(base + '/api/feedback', { headers: { 'x-test-actor': 'test-owner' } })).json() as { proposals: Array<{ id: string }> };
      must(listed.proposals.some((p) => p.id === proposalId), 'the proposal is not in Cockpit\'s Feedback list');
      const r = await post('/api/feedback/decide', { id: proposalId, action: 'approve' }, 'test-owner');
      const j = await r.json() as { proposal: { status: string; decision: unknown } };
      must(r.status === 200 && j.proposal.status === 'approved', `decide answered ${r.status} ${JSON.stringify(j)}`);
      return { http: `POST ${base}/api/feedback/decide → ${r.status}`, status: j.proposal.status, decision: j.proposal.decision };
    })) return 1;

    if (!await step('convert', () => {
      const r = cli('feedback', 'approve', proposalId, '--into', s.project, '--by', 'test-owner', '--apply');
      must(r.code === 0, `work feedback approve: ${r.out}`);
      const p = readProposals(s.data).find((x) => x.id === proposalId)!;
      must(p.status === 'converted' && p.tasks.length === 1, `proposal is ${p.status} with ${p.tasks.length} task(s)`);
      key = (p.tasks[0] as { key: string }).key;
      return { cli: r.out, proposal: { id: p.id, status: p.status, tasks: p.tasks } };
    })) return 1;

    if (!await step('readback', () => {
      const listed = JSON.parse(kb('list', '--tenant', s.project, '--json')) as Array<{ id: string; title: string; body: string | null }>;
      const t = listed.find((x) => (x.body ?? '').includes(`[work:${s.project}:${key}]`));
      must(t, `no task on ${s.board} carries [work:${s.project}:${key}]`);
      taskId = t!.id;
      const shown = JSON.parse(kb('show', '--json', taskId)) as { task: Record<string, unknown> };
      // `show --json` leaves the idempotency key out; read it from the sandbox board's own database, read-only (as recoverMarkers does).
      const db = new DatabaseSync(join(s.hermesHome, 'kanban', 'boards', s.board, 'kanban.db'), { readOnly: true });
      try { shown.task.idempotency_key = (db.prepare('SELECT idempotency_key k FROM tasks WHERE id = ?').get(taskId) as { k: string | null } | undefined)?.k; } finally { db.close(); }
      must(shown.task.idempotency_key === `project:${s.project}:${key}`, `idempotency key is ${shown.task.idempotency_key}`);
      must(shown.task.tenant === s.project, `tenant is ${shown.task.tenant}`);
      return { tasksOnBoard: listed.length, task: { id: taskId, title: shown.task.title, status: shown.task.status, assignee: shown.task.assignee, tenant: shown.task.tenant, idempotency_key: shown.task.idempotency_key, created_by: shown.task.created_by, body: String(shown.task.body ?? '').slice(0, 600) } };
    })) return 1;

    await step('idempotent-retry', () => {
      const before = (JSON.parse(kb('list', '--json')) as unknown[]).length;
      const r = cli('feedback', 'approve', proposalId, '--into', s.project, '--by', 'test-owner', '--apply');
      const after = (JSON.parse(kb('list', '--json')) as unknown[]).length;
      must(r.code === 0 && /already a task/.test(r.out), `retry said: ${r.out}`);
      must(before === after, `the board went from ${before} to ${after} tasks`);
      return { cli: r.out, tasksBefore: before, tasksAfter: after };
    });

    await step('not-dispatched', () => {
      const j = JSON.parse(kb('show', '--json', taskId)) as { task: Record<string, unknown>; runs?: unknown[] };
      must(!(j.runs ?? []).length, `${(j.runs ?? []).length} run(s) were started`);
      must(!j.task.claim_lock && !j.task.worker_pid && !j.task.started_at, 'the task was claimed or started');
      return { status: j.task.status, runs: (j.runs ?? []).length, claim_lock: j.task.claim_lock ?? null, worker_pid: j.task.worker_pid ?? null, started_at: j.task.started_at ?? null };
    });

    await step('adapter-refuses-real-board', () => {
      const tries = [['kanban', '--board', 'micropace-labs', 'list', '--json'], ['kanban', '--board', s.board, 'complete', taskId], ['kanban', '--board', s.board, 'create', '--tenant', 'cockpit-improvement', '--', 'x']];
      const results = tries.map((a) => { try { run(NATIVE_BIN, a); return { args: a.slice(1, 4), refused: false }; } catch (e) { return { args: a.slice(1, 4), refused: /refused/.test((e as Error).message), error: (e as Error).message }; } });
      let shell = 'not refused';
      try { run(join(meta.realUserHome, '.local', 'bin', 'hermes'), ['kanban', 'list']); } catch (e) { shell = (e as Error).message; }
      must(results.every((r) => r.refused) && /refused/.test(shell), 'the adapter let a call outside the sandbox through');
      return { results, hermesLauncher: shell };
    });
    return 0;
  } finally {
    srv?.closeAllConnections(); srv?.close();
    ev.finished = new Date().toISOString();
    save();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const argv = process.argv.slice(2);
  const root = flagOf(argv, 'inner');
  if (root) inner(root).then((c) => { process.exitCode = c; }, (e) => { console.error(e); process.exitCode = 1; });
  else { try { process.exitCode = outer(argv); } catch (e) { console.error(`${LABEL} feedback loop e2e: BLOCKED — ${(e as Error).message}`); process.exitCode = 2; } }
}

