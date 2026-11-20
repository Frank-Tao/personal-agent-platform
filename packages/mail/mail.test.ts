import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideMail, insideAgent, isAllowed, listHeld, loadPolicy, readLog, validate, type MailRequest } from './mail.ts';
import { main } from '../../work/cli.ts';

function setup(mailJson: unknown = { allowed_domains: ['team.example'], max_per_hour: 3 }) {
  const dir = mkdtempSync(join(tmpdir(), 'mail-'));
  mkdirSync(join(dir, 'data', 'config'), { recursive: true });
  writeFileSync(join(dir, '.env'), 'EMAIL_ADDRESS=bot@team.example\nEMAIL_PASSWORD=secret-never-read\nEMAIL_ALLOWED_USERS=Owner@Home.example, other@home.example\n');
  writeFileSync(join(dir, 'data', 'config', 'mailcopy.json'), JSON.stringify({ people: { Diane: { telegram: ['1000000001'], emails: ['diane@home.example'] } } }));
  writeFileSync(join(dir, 'data', 'config', 'mail.json'), JSON.stringify(mailJson));
  return { dir, policy: () => loadPolicy({ hermesEnv: join(dir, '.env'), mailcopy: join(dir, 'data', 'config', 'mailcopy.json'), mailConfig: join(dir, 'data', 'config', 'mail.json') }) };
}
const req = (o: Partial<MailRequest> = {}): MailRequest => ({ to: ['owner@home.example'], subject: 'Weekly packet', body: 'Three bullets.', by: 'growth', project: 'ai-os-setup', ...o });

test('the allow-list: Hermes allowed senders, the mail-copy people and config domains; only EMAIL_ALLOWED_USERS is read from the env file', () => {
  const p = setup().policy();
  assert.deepEqual(p.emails, ['diane@home.example', 'other@home.example', 'owner@home.example']);
  assert.deepEqual(p.domains, ['team.example']);
  assert.equal(p.maxPerHour, 3);
  assert.ok(!JSON.stringify(p).includes('secret'));
  assert.ok(isAllowed('OWNER@home.example', p) && isAllowed('anyone@team.example', p) && isAllowed('x@sub.team.example', p));
  assert.ok(!isAllowed('owner@evil.example', p) && !isAllowed('a@notteam.example', p));
});

test('decide: allowed and plain → send; outsider, private text or over the hourly limit → held, with every reason', () => {
  const p = setup().policy();
  assert.deepEqual(decideMail(req(), p, 0), { status: 'send', reasons: [] });
  assert.match(decideMail(req({ to: ['owner@home.example', 'client@else.example'] }), p, 0).reasons.join(), /not on the allow-list: client@else.example/);
  assert.match(decideMail(req({ body: 'My tax file number is 123 456 789' }), p, 0).reasons.join(), /looks private/);
  assert.equal(decideMail(req({ body: 'Write to owner@home.example' }), p, 0).status, 'send');   // an allowed address is not private
  assert.match(decideMail(req(), p, 3).reasons.join(), /3 sent in the last hour \(limit 3\)/);
});

test('validate refuses bad input before anything is decided', () => {
  assert.throws(() => validate(req({ to: [] })), /at least one/);
  assert.throws(() => validate(req({ to: ['not-an-address'] })), /not an email address/);
  assert.throws(() => validate(req({ subject: 'a\nBcc: x@y.z' })), /one line/);
  assert.throws(() => validate(req({ body: ' ' })), /empty/);
  assert.throws(() => validate(req({ by: 'Frank Tao' })), /roster id/);
  assert.ok(insideAgent({ HERMES_SESSION_KEY: 'x' }) && !insideAgent({ HERMES_HOME: '/h' }));
});

test('work mail: sends to allowed people, holds the rest, and only a person releases or denies', () => {
  const { dir } = setup();
  const sent = join(dir, 'sent.jsonl');
  const fake = join(dir, 'fake-python'); writeFileSync(fake, `#!/bin/sh\ncat >> '${sent}'; echo >> '${sent}'; echo '{"ok": true}'\n`); chmodSync(fake, 0o755);
  const env = { PAP_DATA_DIR: join(dir, 'data'), HERMES_HOME: dir, PYTHON: fake, WORK_NOW: '2026-11-20T01:00:00Z', PATH: process.env.PATH } as NodeJS.ProcessEnv;
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}) => { const out: string[] = []; const code = main(args, { ...env, ...extra }, (s) => out.push(s)); return { code, out: out.join('\n') }; };
  const data = join(dir, 'data');

  let r = run(['mail', 'send', '--to', 'owner@home.example', '--subject', 'Hi', '--body', 'Plan ready.', '--by', 'growth']);
  assert.equal(r.code, 0); assert.match(r.out, /dry run/); assert.ok(!existsSync(sent));
  r = run(['mail', 'send', '--to', 'owner@home.example', '--subject', 'Hi', '--body', 'Plan ready.', '--by', 'growth', '--project', 'ai-os-setup', '--apply']);
  assert.equal(r.code, 0, r.out); assert.match(r.out, /sent \(m-20261120-010000-/);
  const mail = JSON.parse(readFileSync(sent, 'utf8').trim());
  assert.deepEqual(mail.to, ['owner@home.example']); assert.match(mail.body, /Plan ready\.\n\n—\nSent by the growth agent, through Atlas \(project ai-os-setup\)/);

  r = run(['mail', 'send', '--to', 'client@else.example', '--subject', 'Proposal', '--body', 'Draft for the client.', '--by', 'growth', '--apply']);
  assert.equal(r.code, 0); assert.match(r.out, /held for a person to release: not on the allow-list/);
  const [held] = listHeld(data); assert.equal(held.subject, 'Proposal');
  assert.equal(readFileSync(sent, 'utf8').trim().split('\n').length, 1);           // not sent

  r = run(['mail', 'release', held.id, '--by', 'Frank', '--apply'], { HERMES_SESSION_KEY: 'agent-session' });
  assert.equal(r.code, 1); assert.match(r.out, /for a person/);
  r = run(['mail', 'release', held.id, '--by', 'Frank', '--apply']);
  assert.equal(r.code, 0, r.out);
  assert.equal(readFileSync(sent, 'utf8').trim().split('\n').length, 2);
  assert.equal(listHeld(data).length, 0);
  r = run(['mail', 'release', held.id, '--by', 'Frank', '--apply']); assert.match(r.out, /is sent, not held/);

  run(['mail', 'send', '--to', 'client@else.example', '--subject', 'Again', '--body', 'x', '--by', 'pm', '--apply']);
  const [h2] = listHeld(data);
  r = run(['mail', 'deny', h2.id, '--by', 'Frank', '--reason', 'not now', '--apply']); assert.equal(r.code, 0);
  assert.deepEqual(readLog(data).map((e) => e.status), ['sent', 'held', 'released', 'held', 'denied']);

  // the hourly limit (3 in this config) holds the next one
  run(['mail', 'send', '--to', 'owner@home.example', '--subject', 'S', '--body', 'x', '--by', 'pm', '--apply']);
  r = run(['mail', 'send', '--to', 'owner@home.example', '--subject', 'S', '--body', 'x', '--by', 'pm', '--apply']);
  assert.match(r.out, /3 sent in the last hour/);
});
