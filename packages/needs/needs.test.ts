import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CodeError, cleanAct, decideNow, issueCode, needKey, readSnoozes, redeemCode, snooze } from './needs.ts';
import { composeDigest } from '../../work/commands/digest.ts';
import { main } from '../../work/cli.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'needs-'));

test('reply codes: work once, for one item, expire, are stored only as a slow hash, and lock out after five wrong tries', () => {
  const data = tmp(), t0 = Date.parse('2026-11-20T07:30:00Z');
  const code = issueCode(data, { kind: 'approve-charter', project: 'notice-v1' }, 'Approve notice-v1', t0);
  assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.ok(!readFileSync(join(data, 'reply-codes.json'), 'utf8').includes(code), 'the code itself is never written down');
  assert.deepEqual(redeemCode(data, code.toLowerCase() + ' ', t0 + 1000), { act: { kind: 'approve-charter', project: 'notice-v1' }, label: 'Approve notice-v1' });
  assert.throws(() => redeemCode(data, code, t0 + 2000), /already used/);
  const old = issueCode(data, { kind: 'mail', id: 'm-20261120-073000-ab12' }, 'Send mail', t0);
  assert.throws(() => redeemCode(data, old, t0 + 49 * 3_600_000), /expired/);
  const fresh = issueCode(data, { kind: 'close-project', project: 'x-y' }, 'Close', t0);
  for (let i = 0; i < 5; i++) assert.throws(() => redeemCode(data, 'ZZZZZZ', t0 + 3000), CodeError);
  assert.throws(() => redeemCode(data, fresh, t0 + 4000), /locked/);
  assert.equal(redeemCode(data, fresh, t0 + 3_700_000).act.kind, 'close-project', 'the lock lifts after an hour');
});

test('acts from outside are cleaned; keys are stable across refreshes; snoozes expire', () => {
  assert.equal(cleanAct({ kind: 'approve-charter', project: '../etc' }), null);
  assert.equal(cleanAct({ kind: 'rm-rf', project: 'a-b' }), null);
  assert.deepEqual(cleanAct({ kind: 'decisions', refs: ['micropace/notice-v1/D2', 'bad ref'] }), { kind: 'decisions', refs: ['micropace/notice-v1/D2'] });
  assert.equal(needKey({ act: { kind: 'decisions', refs: ['micropace/notice-v1/D2', 'micropace/notice-v1/D5'] }, kind: 'approval', portfolioId: 'micropace', title: 'x' }), 'decisions:micropace:notice-v1');
  assert.equal(needKey({ kind: 'alert', portfolioId: 'atlas', title: 'job failed 3 times' }), needKey({ kind: 'alert', portfolioId: 'atlas', title: 'job failed 4 times' }));
  const data = tmp(), now = Date.parse('2026-11-20T00:00:00Z');
  snooze(data, 'approve-charter:notice-v1', 1, now);
  assert.ok(readSnoozes(data, now + 3_600_000)['approve-charter:notice-v1']);
  assert.deepEqual(readSnoozes(data, now + 25 * 3_600_000), {});
  assert.ok(decideNow({ kind: 'approval', severity: 'info' }) && !decideNow({ kind: 'blocker', severity: 'warn' }));
});

const NEEDS = [
  { portfolioId: 'micropace', kind: 'approval', severity: 'warn', title: 'Approve project charter: notice-v1 — Calendar v1 (work project approve notice-v1 --apply)', act: { kind: 'approve-charter' as const, project: 'notice-v1' } },
  { portfolioId: 'atlas', kind: 'blocker', severity: 'warn', title: 'Gateway restarted twice' },
  { portfolioId: 'research', kind: 'approval', severity: 'info', title: 'Review finished project: r1 — every task is done', act: { kind: 'close-project' as const, project: 'r1' } },
  { portfolioId: 'family', kind: 'staffing', severity: 'warn', title: 'Task t_1 has no owner', task: { id: 't_1' } },
];

test('digest: decisions first, answerable ones with a code, command hints removed, the rest counted; snoozed items left out', () => {
  const codes: string[] = [];
  const m = composeDigest({ needs: NEEDS, snoozed: { 'close-project:r1': '2099-01-01' }, max: 5, url: 'https://cockpit.example:8443', day: new Date('2026-11-20T07:30:00'), snapshotAt: '2026-11-20T07:25:00Z', now: Date.parse('2026-11-20T07:30:00Z'),
    code: (act) => { codes.push(act.kind); return 'K7Q2P4'; } });
  assert.equal(m.count, 2);
  assert.deepEqual(codes, ['approve-charter']);
  assert.match(m.text, /^Atlas · 2 things need you/);
  assert.match(m.text, /1\. Approve project charter: notice-v1 — Calendar v1\n   → reply "yes K7Q2P4" to approve · "no K7Q2P4" to not now/);
  assert.match(m.text, /2\. Task t_1 has no owner\n   → open Cockpit/);
  assert.match(m.text, /1 more for your information/);
  assert.match(m.text, /Cockpit: https:\/\/cockpit.example:8443\/#\/needs/);
  assert.ok(!m.text.includes('--apply') && !m.text.includes('r1'));
  const none = composeDigest({ needs: [], snoozed: {}, max: 5, url: null, day: new Date(), snapshotAt: new Date().toISOString(), now: Date.now(), code: () => 'X' });
  assert.match(none.text, /nothing needs you today/);
});

test('work digest --due: once a day after the set time, on Telegram and by email; a failed channel is retried with the same text', () => {
  const dir = tmp(), data = join(dir, 'data');
  mkdirSync(join(data, 'config'), { recursive: true });
  writeFileSync(join(data, 'config', 'mailcopy.json'), JSON.stringify({ people: { Frank: { telegram: ['2000000002'], emails: ['frank@one.example', 'frank@two.example'] } } }));
  writeFileSync(join(data, 'config', 'digest.json'), JSON.stringify({ person: 'Frank', at: '07:30' }));
  const db = new DatabaseSync(join(data, 'cockpit.sqlite'));
  db.exec('CREATE TABLE snapshots (ts INTEGER, body TEXT)');
  db.prepare('INSERT INTO snapshots VALUES (?, ?)').run(1, JSON.stringify({ generatedAt: new Date().toISOString(), needsYou: NEEDS }));
  db.close();
  const log = join(dir, 'sent'), flag = join(dir, 'tg-fails');
  const fake = join(dir, 'fake-python');
  writeFileSync(fake, `#!/bin/sh\nn=$(basename "$1")\nif [ "$n" = send-telegram.py ] && [ -f '${flag}' ]; then cat >/dev/null; echo '{"ok": false, "error": "Telegram down"}'; exit 1; fi\nprintf '%s ' "$n" >> '${log}'; cat >> '${log}'; echo >> '${log}'; echo '{"ok": true}'\n`);
  chmodSync(fake, 0o755);
  const out: string[] = [];
  const run = (now: string, ...a: string[]) => main(['digest', ...a], { PAP_DATA_DIR: data, PYTHON: fake, WORK_NOW: now, PATH: process.env.PATH, TZ: process.env.TZ } as NodeJS.ProcessEnv, (s) => out.push(s));
  const local = (hm: string) => { const d = new Date(); const [h, m] = hm.split(':').map(Number); d.setHours(h, m, 0, 0); return d.toISOString(); };
  writeFileSync(flag, '');
  assert.equal(run(local('07:00'), '--due', '--apply'), 0); assert.ok(!existsSync(log), 'quiet before 07:30');
  assert.equal(run(local('07:40'), '--due', '--apply'), 0);
  const first = readFileSync(log, 'utf8');
  assert.match(first, /^send-mail.py \{"to":\["frank@one.example","frank@two.example"\],"subject":"\[Atlas\] 3 things need you/);
  assert.match(out.join('\n'), /Telegram down/);
  const code = first.match(/yes ([A-Z2-9]{6})/)![1];
  rmFlag(flag);
  run(local('07:50'), '--due', '--apply');
  const tg = readFileSync(log, 'utf8').split('\n').find((l) => l.startsWith('send-telegram.py'))!;
  assert.ok(tg.includes(code) && tg.includes('"chat":"2000000002"'), 'the retry sends the same message, codes included');
  const lines = readFileSync(log, 'utf8').trim().split('\n').length;
  run(local('09:00'), '--due', '--apply');
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, lines, 'once a day');
  out.length = 0; run(local('09:00'), '--preview');
  assert.match(out.join('\n'), /yes XXXXXX/);
});
function rmFlag(p: string) { try { unlinkSync(p); } catch { /* gone */ } }
