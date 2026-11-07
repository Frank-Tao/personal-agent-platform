import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../work/cli.ts';
import { runWeekly } from './weekly.ts';

const NOW = '2026-11-09T00:00:00Z';
async function seed() {
  const dir = await mkdtemp(join(tmpdir(), 'fb-weekly-'));
  const rows = ['The project page should show blocked tasks first', 'project page should show blocked tasks first please'].map((text, i) => ({
    v: 1, id: `fb-${i}`, time: `2026-11-0${i + 5}T00:00:00Z`, source: 'cockpit', by: 'frank', text, status: 'open', page: 'project', ref: null, proposal: null,
  }));
  writeFileSync(join(dir, 'feedback.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return dir;
}

test('weekly: dry run writes and sends nothing but shows the line', async () => {
  const dir = await seed();
  const sent: string[] = [];
  const r = runWeekly({ dir, now: () => new Date(NOW), enabled: false, send: (t) => sent.push(t) });
  assert.equal(r.pending, 1);
  assert.match(r.line!, /^Cockpit: 1 feedback proposal waiting/);
  assert.equal(sent.length, 0);
  assert.equal(existsSync(join(dir, 'feedback-proposals.jsonl')), false);
});

test('weekly: enabled writes proposals and sends exactly one line; nothing waiting sends nothing', async () => {
  const dir = await seed();
  const sent: string[] = [];
  const r = runWeekly({ dir, now: () => new Date(NOW), enabled: true, send: (t) => sent.push(t) });
  assert.equal(r.sent, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].includes('\n'), false);
  assert.match(readFileSync(join(dir, 'feedback-proposals.jsonl'), 'utf8'), /pending/);
  const empty = await mkdtemp(join(tmpdir(), 'fb-weekly-empty-'));
  const e = runWeekly({ dir: empty, now: () => new Date(NOW), enabled: true, send: (t) => sent.push(t) });
  assert.equal(e.line, null);
  assert.equal(sent.length, 1);
});

test('weekly: CLI needs --apply and FEEDBACK_WEEKLY=1; without Telegram settings it does not send', async () => {
  const dir = await seed();
  const out: string[] = [];
  assert.equal(main(['feedback', 'weekly', '--apply'], { FEEDBACK_DIR: dir, WORK_NOW: NOW }, (s) => out.push(s)), 0);
  assert.match(out.join('\n'), /dry run/);
  assert.equal(existsSync(join(dir, 'feedback-proposals.jsonl')), false);
  out.length = 0;
  assert.equal(main(['feedback', 'weekly', '--apply'], { FEEDBACK_DIR: dir, WORK_NOW: NOW, FEEDBACK_WEEKLY: '1' }, (s) => out.push(s)), 0);
  assert.match(out.join('\n'), /not set: not sent/);
  assert.equal(existsSync(join(dir, 'feedback-proposals.jsonl')), true);
});
