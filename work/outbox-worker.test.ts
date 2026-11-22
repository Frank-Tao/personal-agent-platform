import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { requirementEvidence } from './commands/outbox.ts';
import { writePlan, type PlanTask, type Project } from '../packages/work/model.ts';
import type { Ctx } from './shared.ts';

// Inside a kanban worker the hermes CLI refuses every kanban call; the release evidence check must read the board database instead.

function setup(shots: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'outbox-worker-'));
  const boardDir = join(dir, 'elsewhere', 'boards', 'inv'); // not under hermesHome: found through HERMES_KANBAN_DB only
  mkdirSync(join(boardDir, 'attachments', 't_v1'), { recursive: true });
  for (const f of shots) writeFileSync(join(boardDir, 'attachments', 't_v1', f), 'x');
  const db = new DatabaseSync(join(boardDir, 'kanban.db'));
  db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, body TEXT, assignee TEXT, status TEXT, created_by TEXT, created_at INTEGER, started_at INTEGER, completed_at INTEGER, tenant TEXT, idempotency_key TEXT)');
  db.prepare('INSERT INTO tasks (id, title, body, status, created_by, created_at, tenant) VALUES (?,?,?,?,?,?,?)').run('t_v1', 'verify', '[work:proj:x-verify]\n\nprove it', 'done', 'work', 1, 'proj');
  db.close();
  const pt = (key: string, role: string): PlanTask => ({ key, title: key, owner: 'qa', lane: null, model: null, provider: null, needs: [], accept: 'a', outward: null, workspace: null, max_runtime: '2h', goal: false, req: 'x', role } as PlanTask);
  const body = writePlan('\n## Plan\n', [pt('x', 'build'), pt('x-verify', 'verify')]);
  const p = { id: 'proj', tenant: 'proj', portfolio: 'inv', board: 'inv' } as Project;
  const c = {
    hermesBin: 'hermes-not-installed', hermesHome: join(dir, 'profile-home'), layoutPath: join(dir, 'none.json'),
    run: () => { throw new Error('delegate_task child contexts cannot mutate Kanban tasks or boards'); },
    env: { HERMES_DELEGATED_CHILD_CONTEXT: '1', HERMES_KANBAN_BOARD: 'inv', HERMES_KANBAN_DB: join(boardDir, 'kanban.db') },
  } as unknown as Ctx;
  return { c, p, body };
}

test('requirement evidence is read from the board database when the CLI refuses (kanban worker)', () => {
  const { c, p, body } = setup(['a.png', 'b.png']);
  const e = requirementEvidence(c, p, body, 'x');
  assert.deepEqual({ ok: e.ok, why: e.why, screenshots: e.screenshots, verified: e.verified }, { ok: true, why: '', screenshots: 2, verified: 1 });
});

test('requirement evidence in a worker still demands screenshots', () => {
  const { c, p, body } = setup([]);
  const e = requirementEvidence(c, p, body, 'x');
  assert.equal(e.ok, false);
  assert.match(e.why, /no screenshots attached/);
});
