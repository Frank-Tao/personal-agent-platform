import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.ts';
import { jobHistories } from '../src/sources/atlas.ts';

// An item that was open and then disappears has been resolved; the time between is how long it waited for a human.
test('needs log: median hours to resolve per kind, open counts per portfolio', () => {
  const s = new Store(':memory:');
  const a = { portfolioId: 'x', kind: 'approval' as const, title: 'Approve A', severity: 'warn' as const };
  const b = { portfolioId: 'x', kind: 'blocker' as const, title: 'Blocked B', severity: 'warn' as const };
  s.trackNeeds([a, b], () => 'micropace', '2026-11-01T00:00:00.000Z');
  s.trackNeeds([b], () => 'micropace', '2026-11-01T06:00:00.000Z');
  const st = s.needsStats('2026-11-01T10:00:00.000Z');
  assert.deepEqual(st.openByPortfolio, { micropace: 1 });
  assert.equal(st.resolveHours.approval.medianHours, 6);
  assert.equal(st.oldestOpenHours, 10);
  assert.equal(st.resolved, 1);
});

test('job history: completed is green, failed is red, a delivery failure or unfinished run is amber', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cron-'));
  const db = new DatabaseSync(join(dir, 'executions.db'));
  db.exec(`CREATE TABLE executions (id TEXT, job_id TEXT, status TEXT, delivery_outcome TEXT, claimed_at TEXT, started_at TEXT, error TEXT);
    INSERT INTO executions VALUES ('1','j','completed','delivered','2026-11-07T01:00:00Z','2026-11-07T01:00:01Z',NULL),
      ('2','j','failed',NULL,'2026-11-07T02:00:00Z','2026-11-07T02:00:01Z','boom'),
      ('3','j','completed','failed','2026-11-07T03:00:00Z','2026-11-07T03:00:01Z',NULL),
      ('4','j','unknown',NULL,'2026-11-07T04:00:00Z',NULL,NULL),
      ('5','j','completed','delivered','2026-10-01T00:00:00Z','2026-10-01T00:00:01Z',NULL);`);
  db.close();
  const h = jobHistories(join(dir, 'executions.db'), Date.parse('2026-11-08T00:00:00Z')).get('j')!;
  assert.deepEqual(h.map((x) => x.status), ['ok', 'alert', 'warn', 'warn']);
});

import { workArgs } from '../src/work.ts';
test('retry-task maps to fixed CLI arguments; the note is one argument, never a flag', () => {
  assert.deepEqual(workArgs({ project: 'p1', action: 'retry-task', key: 'gate', note: '--apply rm -rf' }), ['project', 'retry-task', 'p1', 'gate', '--note', '--apply rm -rf', '--apply']);
  assert.throws(() => workArgs({ project: 'p1', action: 'retry-task', key: 'bad key!' }));
});

test('retry-task by task id (a step Hermes created): the id is checked, the key is not needed', () => {
  assert.deepEqual(workArgs({ project: 'p1', action: 'retry-task', task: 't_219fc91e', note: 'go' }), ['project', 'retry-task', 'p1', '-', '--task', 't_219fc91e', '--note', 'go', '--apply']);
  assert.throws(() => workArgs({ project: 'p1', action: 'retry-task', task: 't_1; rm' }));
});
