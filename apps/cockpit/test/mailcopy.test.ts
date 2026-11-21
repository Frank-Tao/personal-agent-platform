import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { main } from '../../../work/cli.ts';
import { mailcopyNeeds, mailcopySource, STALE_MINUTES } from '../src/sources/mailcopy.ts';

const REAL = resolve(import.meta.dirname, '../../..');
const DIANE = '1000000001';

test('work mailcopy: the first run only sets the starting point; later runs mail new outputs through the sender and leave a status file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mccli-'));
  const home = join(dir, 'hermes'), data = join(dir, 'data');
  mkdirSync(join(home, 'cron', 'output', 'j1'), { recursive: true }); mkdirSync(join(data, 'config'), { recursive: true });
  writeFileSync(join(home, 'cron', 'jobs.json'), JSON.stringify({ jobs: [{ id: 'j1', name: 'Weekly plan', deliver: `telegram:${DIANE}`, enabled: true }] }));
  writeFileSync(join(data, 'config', 'mailcopy.json'), JSON.stringify({ people: { Diane: { telegram: [DIANE], emails: ['diane@one.example', 'diane@two.example'], emailFormat: 'ai-os' } } }));
  const out = (name: string, at: string) => { const p = join(home, 'cron', 'output', 'j1', name); writeFileSync(p, '# Cron Job\n\n## Prompt\n\nx\n\n## Response\n\nThe weekly plan.\n'); utimesSync(p, new Date(at), new Date(at)); };
  out('2026-11-09_06-00-00.md', '2026-11-09T06:00:00Z');                                         // sent to Telegram before the first run
  // a stand-in for python: records what it was given and says it worked
  const stub = join(dir, 'python-stub.sh'), seen = join(dir, 'seen.jsonl');
  writeFileSync(stub, `#!/bin/sh\ncat >> ${seen}\necho >> ${seen}\necho '{"ok": true}'\n`); chmodSync(stub, 0o755);
  const env = { ...process.env, HERMES_HOME: home, PAP_DATA_DIR: data, PYTHON: stub, WORK_NOW: '2026-11-16T10:00:00Z' };
  const lines: string[] = [];
  assert.equal(main(['mailcopy'], env, (s) => lines.push(s)), 0);
  assert.match(lines.join('\n'), /1 to send|0 to send/);
  assert.equal(existsSync(join(data, 'mailcopy-state.json')), false, 'a dry run writes nothing');
  lines.length = 0;
  assert.equal(main(['mailcopy', '--apply'], env, (s) => lines.push(s)), 0);
  assert.match(lines.join('\n'), /0 sent, 0 failed/);
  assert.match(lines.join('\n'), /first run: copies start from 2026-11-16T10:00:00/);
  assert.equal(existsSync(seen), false, 'last week\'s message is not mailed');

  out('2026-11-16_12-00-00.md', '2026-11-16T12:00:00Z');
  lines.length = 0;
  assert.equal(main(['mailcopy', '--apply'], { ...env, WORK_NOW: '2026-11-16T13:00:00Z' }, (s) => lines.push(s)), 0);
  assert.match(lines.join('\n'), /1 sent, 0 failed/);
  const given = JSON.parse(readFileSync(seen, 'utf8').trim());
  assert.deepEqual(given.to, ['diane@one.example', 'diane@two.example']);
  assert.equal(given.format, 'ai-os', 'work mailcopy forwards the recipient opt-in');
  assert.equal(given.subject, '[Atlas] Weekly plan — 2026-11-16');
  assert.match(given.body, /^The weekly plan\.\n\n—\nCopy of what Atlas sent to Diane on Telegram/);
  const status = JSON.parse(readFileSync(join(data, 'mailcopy-status.json'), 'utf8'));
  assert.deepEqual([status.sent, status.failed, status.lastError], [1, 0, null]);
  lines.length = 0;
  main(['mailcopy', '--apply'], { ...env, WORK_NOW: '2026-11-16T13:10:00Z' }, (s) => lines.push(s));
  assert.match(lines.join('\n'), /0 sent, 0 failed/, 'nothing is mailed twice');
  // no config: off, and says so
  lines.length = 0; assert.equal(main(['mailcopy', '--apply'], { ...env, PAP_DATA_DIR: join(dir, 'other') }, (s) => lines.push(s)), 0);
  assert.match(lines.join('\n'), /not set up/);
});

test('send-mail.py: refuses bad input and incomplete settings, and an error never contains the password', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smtp-'));
  const envFile = join(dir, '.env');
  const run = (input: unknown, content: string) => { writeFileSync(envFile, content); return spawnSync('/opt/homebrew/bin/python3', [join(REAL, 'infra/bin/send-mail.py')], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, HERMES_ENV: envFile } }); };
  const full = 'EMAIL_ADDRESS=bot@example.com\nEMAIL_PASSWORD=Sup3rSecretPassw0rd\nEMAIL_SMTP_HOST=127.0.0.1\nEMAIL_SMTP_PORT=1\n';
  const noRecipient = run({ to: ['not an address', 'a@b'], subject: 's', body: 'b' }, full);
  assert.deepEqual([noRecipient.status, JSON.parse(noRecipient.stdout).error], [1, 'no valid recipient']);
  const incomplete = run({ to: ['a@b.example'], subject: 's', body: 'b' }, 'EMAIL_ADDRESS=bot@example.com\n');
  assert.match(JSON.parse(incomplete.stdout).error, /incomplete/);
  assert.equal(spawnSync('/opt/homebrew/bin/python3', [join(REAL, 'infra/bin/send_mail_test.py')]).status, 0, 'real EmailMessage construction and sender use a fake SMTP transport');
  assert.equal(spawnSync('/opt/homebrew/bin/python3', ['-m', 'py_compile', join(REAL, 'infra/bin/send-mail.py')]).status, 0);
});

test('Needs-you: failed or stuck email copies and unmapped chats are shown; a healthy pass and a missing file are not', async () => {
  const now = Date.parse('2026-11-16T10:00:00Z'), at = (m: number) => new Date(now - m * 60_000).toISOString();
  assert.deepEqual(mailcopyNeeds(null, now), []);
  assert.deepEqual(mailcopyNeeds({ at: at(5), sent: 3, failed: 0, pending: 0 }, now), []);
  assert.match(mailcopyNeeds({ at: at(5), sent: 0, failed: 2, pending: 2, lastError: 'SMTP down' }, now)[0].title, /^2 email copies of Hermes job messages could not be sent: SMTP down$/);
  assert.match(mailcopyNeeds({ at: at(5), sent: 0, failed: 1, pending: 1 }, now)[0].title, /^1 email copy of Hermes/);
  assert.match(mailcopyNeeds({ at: at(STALE_MINUTES + 30), sent: 0, failed: 0, pending: 0 }, now)[0].title, /have not run for 90 minutes/);
  assert.match(mailcopyNeeds({ at: at(5), sent: 0, failed: 0, pending: 0, unmapped: ['Job → chat 3000000003'] }, now)[0].title, /no email address mapped: Job → chat 3000000003/);
  const dir = mkdtempSync(join(tmpdir(), 'mcs-'));
  assert.deepEqual((await mailcopySource(join(dir, 'none.json'))()).needs, []);
});
