import { main as workMain } from '../../../work/cli.ts';
import { SLUG, TASK_KEY } from '../../../packages/work/model.ts';

// Cockpit's window onto the work model. It never edits project files itself: every change goes through the same
// `work` CLI (and so the same checks) that agents use, with a fixed set of actions.

export class WorkError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

export type WorkRun = (argv: string[]) => { code: number; output: string };

export function defaultWorkRun(env: NodeJS.ProcessEnv = process.env): WorkRun {
  return (argv) => {
    const lines: string[] = [];
    const code = workMain(argv, env, (s) => lines.push(s));
    return { code, output: lines.join('\n') };
  };
}

const str = (v: unknown, max = 300): string => (typeof v === 'string' && v.length <= max ? v : '');

/** Turn a JSON request into fixed CLI arguments, or throw. Nothing from the request becomes a flag name. */
export function workArgs(body: Record<string, unknown>): string[] {
  const id = str(body.project, 48);
  if (!SLUG.test(id)) throw new WorkError('bad project id');
  const action = str(body.action, 20);
  switch (action) {
    case 'priority': {
      const n = Number(body.priority);
      if (!Number.isInteger(n) || n < 1 || n > 5) throw new WorkError('priority must be 1 to 5');
      return ['project', 'set', id, '--priority', String(n), '--apply'];
    }
    case 'repo': {
      const repo = str(body.repo, 120), test = str(body.test_cmd, 200);
      if (!repo && !test) throw new WorkError('give a repo, a test command, or both');
      if (repo && !/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(repo)) throw new WorkError('bad repo');
      if (/[\n\r]/.test(test)) throw new WorkError('bad test command');
      return ['project', 'set', id, ...(repo ? ['--repo', repo] : []), ...(test ? ['--test-cmd', test] : []), '--apply'];
    }
    case 'approve': {
      const note = str(body.comment, 1000).replace(/\s+/g, ' ').trim();
      return ['project', 'approve', id, ...(note ? ['--note', note] : []), '--apply'];
    }
    case 'close': return ['close', id, '--apply'];
    case 'pause': case 'resume': return ['project', action, id, '--apply'];
    case 'apply-plan': return ['plan', 'apply', id, '--apply'];
    case 'stop-task': {
      const key = str(body.key, 48);
      if (!TASK_KEY.test(key)) throw new WorkError('bad task key');
      return ['project', 'stop-task', id, key, '--apply'];
    }
    case 'step-done': {
      const key = str(body.key, 48);
      if (!TASK_KEY.test(key)) throw new WorkError('bad task key');
      const note = str(body.note, 500).trim();
      return ['project', 'step-done', id, key, ...(note ? ['--note', note] : []), '--apply'];
    }
    case 'plan': {
      const op = str(body.op, 10);
      const key = str(body.key, 48);
      if (!TASK_KEY.test(key)) throw new WorkError('bad task key');
      if (op === 'move') return ['plan', 'edit', id, '--op', 'move', '--key', key, '--to', String(Number(body.to)), '--apply'];
      if (op === 'remove') return ['plan', 'edit', id, '--op', 'remove', '--key', key, '--apply'];
      if (op === 'set') {
        const out = ['plan', 'edit', id, '--op', 'set', '--key', key];
        for (const f of ['title', 'owner', 'lane', 'accept'] as const) { const v = str((body.fields as Record<string, unknown> | undefined)?.[f]); if (v) out.push(`--${f}`, v); }
        if (out.length === 7) throw new WorkError('nothing to change');
        return [...out, '--apply'];
      }
      if (op === 'add') {
        const t = (body.task ?? {}) as Record<string, unknown>;
        const out = ['plan', 'edit', id, '--op', 'add', '--key', key, '--title', str(t.title), '--owner', str(t.owner), '--accept', str(t.accept)];
        const needs = str(t.needs); if (needs) out.push('--needs', needs);
        const parent = str(t.parent, 48); if (parent) { if (!TASK_KEY.test(parent)) throw new WorkError('bad parent key'); out.push('--parent', parent); }
        return [...out, '--apply'];
      }
      throw new WorkError('unknown plan operation');
    }
    default: throw new WorkError('unknown action');
  }
}

/** The Edit dialog: outcome/checks (only while the charter is still proposed), plus priority, repo and test command. One or more fixed commands. */
export function editCommands(body: Record<string, unknown>): string[][] {
  const id = str(body.project, 48);
  if (!SLUG.test(id)) throw new WorkError('bad project id');
  const cmds: string[][] = [];
  const outcome = str(body.outcome, 300).trim();
  const done = (Array.isArray(body.done_when) ? body.done_when : []).map((x) => str(x, 200).trim()).filter(Boolean).slice(0, 8);
  if (outcome || done.length) cmds.push(['project', 'edit', id, ...(outcome ? ['--outcome', outcome] : []), ...done.flatMap((d) => ['--done-when', d]), '--apply']);
  const set: string[] = [];
  if (typeof body.name === 'string') { const nm = str(body.name, 80).trim(); if (/[\n\r]/.test(nm)) throw new WorkError('bad name'); set.push('--name', nm); }
  if (body.priority !== undefined && body.priority !== null && body.priority !== '') {
    const n = Number(body.priority);
    if (!Number.isInteger(n) || n < 1 || n > 5) throw new WorkError('priority must be 1 to 5');
    set.push('--priority', String(n));
  }
  const repo = str(body.repo, 120), test = str(body.test_cmd, 300);
  if (repo) { if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(repo)) throw new WorkError('bad repo'); set.push('--repo', repo); }
  if (test) { if (/[\n\r]/.test(test)) throw new WorkError('bad test command'); set.push('--test-cmd', test.trim()); }
  if (Array.isArray(body.team)) {
    const team = body.team.map((x) => str(x, 32)).filter(Boolean);
    if (team.some((x) => !/^[a-z][a-z0-9-]{0,31}$/.test(x))) throw new WorkError('bad team member');
    set.push('--team', [...new Set(['pm', ...team])].join(','));
  }
  if (set.length) cmds.push(['project', 'set', id, ...set, '--apply']);
  if (!cmds.length) throw new WorkError('nothing to change');
  return cmds;
}

export function listProjects(run: WorkRun, id?: string): unknown[] {
  const r = run(id ? ['projects', '--id', id] : ['projects']);
  if (r.code !== 0) throw new WorkError(r.output.split('\n')[0] || 'could not read projects', 500);
  const line = r.output.split('\n').find((l) => l.startsWith('['));
  return line ? JSON.parse(line) : [];
}

export function listRepos(run: WorkRun): unknown[] {
  const r = run(['repos', '--json']);
  const line = r.output.split('\n').find((l) => l.startsWith('['));
  return r.code === 0 && line ? JSON.parse(line) : [];
}

export function actOnProject(run: WorkRun, body: Record<string, unknown>): { ok: true; output: string } {
  if (body.action === 'edit') {
    let out = '';
    for (const argv of editCommands(body)) {
      const r = run(argv);
      if (r.code !== 0) throw new WorkError(r.output.split('\n').filter((l) => l.startsWith('error:') || l.includes('✗')).join('; ') || 'the change was refused', 422);
      out += r.output + '\n';
    }
    return { ok: true, output: out };
  }
  const r = run(workArgs(body));
  if (r.code !== 0) throw new WorkError(r.output.split('\n').filter((l) => l.startsWith('error:') || l.includes('✗')).join('; ') || 'the change was refused', 422);
  return { ok: true, output: r.output };
}

const slugOf = (text: string): string => {
  const words = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((w) => w && !['a', 'an', 'the', 'of', 'to', 'for', 'and', 'in', 'on', 'with'].includes(w)).slice(0, 4);
  const slug = words.join('-').replace(/^[^a-z]+/, 'p-').slice(0, 40).replace(/-+$/, '');
  return SLUG.test(slug) ? slug : 'new-project';
};

/** A new project from the form: the human gives outcome, checks and (optionally) repo and priority; the team is chosen by code. */
export function proposeArgs(body: Record<string, unknown>): { id: string; argv: string[] } {
  const portfolio = str(body.portfolio, 32);
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(portfolio)) throw new WorkError('bad portfolio');
  const outcome = str(body.outcome, 300).trim();
  if (!outcome) throw new WorkError('say what the project should achieve');
  const done = (Array.isArray(body.done_when) ? body.done_when : []).map((x) => str(x, 200).trim()).filter(Boolean).slice(0, 8);
  if (!done.length) throw new WorkError('add at least one check that shows the project is done');
  const id = str(body.id, 48) || slugOf(outcome);
  if (!SLUG.test(id)) throw new WorkError('bad project id');
  const argv = ['project', 'propose', portfolio, '--id', id, '--outcome', outcome, ...done.flatMap((d) => ['--done-when', d])];
  const repo = str(body.repo, 120);
  if (repo) { if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(repo)) throw new WorkError('bad repo'); argv.push('--repo', repo); }
  const test = str(body.test_cmd, 300).trim();
  if (/[\n\r]/.test(test)) throw new WorkError('bad test command');
  if (test) argv.push('--test-cmd', test);
  const prio = Number(body.priority ?? 3);
  if (!Number.isInteger(prio) || prio < 1 || prio > 5) throw new WorkError('priority must be 1 to 5');
  argv.push('--priority', String(prio));
  const targets = str(body.deploy_targets, 200).split(',').map((x) => x.trim()).filter(Boolean);
  if (targets.some((t) => !/^[A-Za-z0-9.-]+$/.test(t))) throw new WorkError('bad deploy target');
  if (targets.length) argv.push('--deploy-targets', targets.join(','));
  return { id, argv: [...argv, '--apply'] };
}

export function proposeProject(run: WorkRun, body: Record<string, unknown>): { id: string; output: string } {
  // No repo yet? Create it first from what the human typed (README, agent notes, git), then link it.
  const nr = (body.new_repo ?? null) as Record<string, unknown> | null;
  if (nr && typeof nr === 'object') {
    const repoId = str(nr.id, 48);
    if (!SLUG.test(repoId)) throw new WorkError('the new repo needs a name made of lowercase letters, digits and dashes');
    const pre = proposeArgs({ ...body, repo: '' });
    const cargs = ['repo', 'create', str(body.portfolio, 32), '--id', repoId];
    for (let i = 0; i < pre.argv.length; i++) if (['--outcome', '--done-when', '--test-cmd'].includes(pre.argv[i])) cargs.push(pre.argv[i], pre.argv[i + 1]);
    const made = run([...cargs, '--apply']);
    if (made.code !== 0) throw new WorkError(made.output.split('\n').filter((l) => l.startsWith('error:')).join('; ') || 'could not create the repo', 422);
    body = { ...body, repo: repoId, new_repo: null };
  }
  const { id, argv } = proposeArgs(body);
  const r = run(argv);
  if (r.code !== 0) throw new WorkError(r.output.split('\n').filter((l) => l.startsWith('error:') || l.includes('✗')).join('; ') || 'the charter was refused', 422);
  return { id, output: r.output };
}
