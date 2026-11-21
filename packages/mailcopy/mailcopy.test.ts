import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GIVE_UP_AFTER, MAX_PER_RUN, emptyState, homeChannel, listJobs, loadConfig, pendingCopies, responseOf, runMailcopy, telegramChats, type Mail, type Sender } from './mailcopy.ts';

const DIANE = '1000000001', FRANK = '2000000002';
const cfg = { people: { Diane: { telegram: [DIANE], emails: ['diane@one.example', 'diane@two.example'] }, Frank: { telegram: [FRANK], emails: ['frank@one.example', 'frank@two.example'] } }, exclude: ['Muted job'] };
const NOW = Date.parse('2026-11-16T10:00:00Z');
const since = '2026-11-16T00:00:00Z';

function hermes() {
  const home = mkdtempSync(join(tmpdir(), 'mc-'));
  const job = (id: string, name: string, deliver: string, extra: Record<string, unknown> = {}) => ({ id, name, deliver, enabled: true, ...extra });
  const put = (h: string, jobs: unknown[]) => { mkdirSync(join(h, 'cron'), { recursive: true }); writeFileSync(join(h, 'cron', 'jobs.json'), JSON.stringify({ jobs })); };
  const output = (h: string, id: string, file: string, response: string, at = '2026-11-16T09:00:00Z') => {
    mkdirSync(join(h, 'cron', 'output', id), { recursive: true });
    const p = join(h, 'cron', 'output', id, file); writeFileSync(p, `# Cron Job: x\n\n## Prompt\n\nthe prompt text\n\n## Response\n\n${response}\n`); utimesSync(p, new Date(at), new Date(at));
  };
  const diane = join(home, 'profiles', 'diane'); mkdirSync(diane, { recursive: true });
  writeFileSync(join(home, 'config.yaml'), `TELEGRAM_HOME_CHANNEL: '${DIANE}'\n`);
  put(home, [job('j1', 'Weekly plan', `telegram:${DIANE}`), job('j2', 'Morning brief', 'telegram'), job('j3', 'Nightly', 'local'), job('j4', 'Mail only', 'email:a@b.example'), job('j5', 'Muted job', `telegram:${DIANE}`), job('j6', 'Frank digest', `telegram:${FRANK}`), job('j7', 'Both', `telegram:${DIANE},telegram:${FRANK}`), job('j8', 'Stranger', 'telegram:3000000003'), job('j9', 'Disabled', `telegram:${DIANE}`, { enabled: false })]);
  put(diane, [job('d1', 'Gold price', `telegram:${DIANE}`), job('j1', 'Profile collision', `telegram:${DIANE}`)]);
  return { home, diane, output };
}
const recorder = (ok = true): { send: Sender; sent: Mail[] } => { const sent: Mail[] = []; return { sent, send: (m) => { sent.push(m); return ok ? { ok: true } : { ok: false, error: 'SMTP down' }; } }; };

test('which Telegram chats a job delivers to: a chat id, the profile\'s home channel, thread suffixes; local and other platforms are not copied', () => {
  const { home } = hermes();
  const jobs = Object.fromEntries(listJobs(home).map((j) => [j.name, j]));
  assert.equal(homeChannel(home), DIANE);
  assert.deepEqual(telegramChats(jobs['Weekly plan']), [DIANE]);
  assert.deepEqual(telegramChats(jobs['Morning brief']), [DIANE]);                      // bare "telegram" = the home channel
  assert.deepEqual(telegramChats(jobs['Both']), [DIANE, FRANK]);
  assert.deepEqual(telegramChats({ ...jobs['Weekly plan'], deliver: `Telegram:${FRANK}:77` }), [FRANK]);   // case and thread id
  assert.deepEqual([telegramChats(jobs['Nightly']), telegramChats(jobs['Mail only'])], [[], []]);
  assert.deepEqual(listJobs(home).filter((j) => j.profile === 'diane').map((j) => j.name), ['Gold price', 'Profile collision']);
});

test('the response is what is sent; people need a chat and an address; a broken config means off', () => {
  assert.equal(responseOf('# Job\n\n## Prompt\n\nmy prompt\n\n## Response\n\nHello **world**\n\n- a\n'), 'Hello **world**\n\n- a');
  assert.equal(responseOf('no response section'), '');
  const dir = mkdtempSync(join(tmpdir(), 'mcc-'));
  writeFileSync(join(dir, 'ok.json'), JSON.stringify({ people: { A: { telegram: ['1234567'], emails: ['a@x.example', 'not an address'] }, B: { telegram: [], emails: ['b@x.example'] }, C: { telegram: ['abc'], emails: ['c@x.example'] } }, exclude: ['x'] }));
  assert.deepEqual(loadConfig(join(dir, 'ok.json')), { people: { A: { telegram: ['1234567'], emails: ['a@x.example'] } }, exclude: ['x'] });
  assert.equal(loadConfig(join(dir, 'missing.json')), null);
});

test('config keeps legacy allow-all and validates per-person job tokens fail closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-'));
  const person = (extra: object = {}) => ({ telegram: [DIANE], emails: ['diane@one.example'], ...extra });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ people: {
    Legacy: person(), Valid: person({ allowedJobs: ['default/abc123', 'diane/def456', 'Profile_2/job-3'] }),
    Invalid: person({ allowedJobs: ['default/abc123', '*'] }), Empty: person({ allowedJobs: [] }), WrongType: person({ allowedJobs: 'default/abc123' }),
  } }));
  const loaded = loadConfig(join(dir, 'config.json'))!;
  assert.equal(loaded.people.Legacy.allowedJobs, undefined);
  assert.deepEqual(loaded.people.Valid.allowedJobs, ['default/abc123', 'diane/def456', 'Profile_2/job-3']);
  assert.deepEqual(loaded.people.Invalid.allowedJobs, []);
  assert.deepEqual(loaded.people.Empty.allowedJobs, []);
  assert.deepEqual(loaded.people.WrongType.allowedJobs, []);
});

test('job policies match exact profile/id, deny unknown jobs by default, and leave other recipients unaffected', () => {
  const { home, diane, output } = hermes();
  output(home, 'j1', '2026-11-16_06-00-00.md', 'default job');
  output(diane, 'j1', '2026-11-16_06-00-00.md', 'same id, other profile');
  output(home, 'j7', '2026-11-16_07-30-00.md', 'shared job');
  output(home, 'j2', '2026-11-16_08-00-00.md', 'new job');
  const policy = { people: {
    Diane: { ...cfg.people.Diane, allowedJobs: ['default/j1', 'default/j7'] },
    Frank: { ...cfg.people.Frank, allowedJobs: ['default/j7'] },
  }, exclude: cfg.exclude };
  const scan = pendingCopies(home, policy, emptyState(new Date(since)), NOW);
  assert.deepEqual(scan.copies.map((c) => [c.person, c.job.profile, c.job.id]).sort(), [
    ['Diane', 'default', 'j1'], ['Diane', 'default', 'j7'], ['Frank', 'default', 'j7'],
  ]);
  assert.equal(scan.copies.some((c) => c.job.profile === 'diane'), false, 'same id under a different profile is denied');
  assert.equal(scan.copies.some((c) => c.job.id === 'j2'), false, 'a new job is denied unless listed');
  const shared = pendingCopies(home, { people: {
    Diane: { ...cfg.people.Diane, allowedJobs: ['default/j1'] },
    Frank: cfg.people.Frank,
  } }, emptyState(new Date(since)), NOW);
  assert.deepEqual(shared.copies.filter((c) => c.job.id === 'j7').map((c) => c.person), ['Frank'], 'denying Diane does not deny the other recipient');
  const sentinel = join(home, 'cron', 'output', 'j2', '2026-11-16_09-01-00.md');
  mkdirSync(sentinel);
  utimesSync(sentinel, new Date('2026-11-16T09:01:00Z'), new Date('2026-11-16T09:01:00Z'));
  assert.doesNotThrow(() => pendingCopies(home, { people: { Diane: { ...cfg.people.Diane, allowedJobs: ['default/j1'] } } }, emptyState(new Date(since)), NOW), 'excluded output is never read (directory sentinel would throw EISDIR)');
});

test('an explicitly empty or malformed policy denies all recipients before output files are opened', () => {
  const { home, output } = hermes();
  output(home, 'j1', '2026-11-16_06-00-00.md', 'should not be copied');
  const people = {
    Diane: { ...cfg.people.Diane, allowedJobs: [] },
    Frank: { ...cfg.people.Frank, allowedJobs: [] },
  };
  const scan = pendingCopies(home, { people, exclude: [] }, emptyState(new Date(since)), NOW);
  assert.deepEqual(scan.copies, []);
  // Remove the output tree after confirming the same no-eligible path does not inspect it.
  rmSync(join(home, 'cron', 'output', 'j1'), { recursive: true });
  assert.deepEqual(pendingCopies(home, { people: { Diane: { ...cfg.people.Diane, allowedJobs: [] } }, exclude: [] }, emptyState(new Date(since)), NOW).copies, []);
});

test('copies: each person gets their own addresses, in every profile; silent, old, fresh, excluded, disabled and unmapped outputs are left out', () => {
  const { home, diane, output } = hermes();
  output(home, 'j1', '2026-11-16_06-00-00.md', '[AI-OS · Weekly] Week of 16 November\n- item');
  output(home, 'j2', '2026-11-16_08-00-00.md', '**Atlas brief**');
  output(home, 'j3', '2026-11-16_01-00-00.md', 'local job: never copied');
  output(home, 'j5', '2026-11-16_06-00-00.md', 'excluded job');
  output(home, 'j6', '2026-11-16_07-00-00.md', 'Frank only');
  output(home, 'j7', '2026-11-16_07-30-00.md', 'for both people');
  output(home, 'j8', '2026-11-16_07-40-00.md', 'someone nobody is mapped to');
  output(home, 'j9', '2026-11-16_07-50-00.md', 'disabled job');
  output(diane, 'd1', '2026-11-16_09-00-00.md', 'Gold is up.');
  output(home, 'j1', '2026-11-16_09-30-00.md', '[SILENT]');
  output(home, 'j1', '2026-11-10_06-00-00.md', 'last week', '2026-11-10T06:00:00Z');                       // before the first run
  output(home, 'j1', '2026-11-16_10-00-00.md', 'still being written', '2026-11-16T09:59:55Z');             // written 5 s ago
  const scan = pendingCopies(home, cfg, { ...emptyState(new Date(since)) }, NOW);
  const by = (n: string) => scan.copies.filter((c) => c.job.name === n);
  assert.deepEqual(by('Weekly plan').map((c) => [c.person, c.to]), [['Diane', ['diane@one.example', 'diane@two.example']]]);
  assert.equal(by('Weekly plan')[0].subject, '[Atlas] Weekly plan — 2026-11-16');
  assert.match(by('Weekly plan')[0].body, /^\[AI-OS · Weekly\] Week of 16 November\n- item\n\n—\nCopy of what Atlas sent to Diane on Telegram \(job "Weekly plan", 2026-11-16 06-00-00\)\.$/);
  assert.deepEqual(by('Morning brief').map((c) => c.person), ['Diane']);
  assert.deepEqual(by('Frank digest').map((c) => [c.person, c.to]), [['Frank', ['frank@one.example', 'frank@two.example']]]);
  assert.deepEqual(by('Both').map((c) => c.person).sort(), ['Diane', 'Frank']);
  assert.deepEqual(by('Gold price').map((c) => c.person), ['Diane'], 'a job under another profile is copied too');
  assert.deepEqual(scan.copies.filter((c) => ['Nightly', 'Muted job', 'Disabled'].includes(c.job.name)), []);
  assert.deepEqual(scan.unmapped, ['Stranger → chat 3000000003']);
  assert.equal(scan.skipped, 1, 'the [SILENT] run');
  assert.equal(scan.copies.length, 6, 'nothing from before the first run, nothing still being written');
});

test('a failed run is flagged; a send is recorded per output and person, so a pass never mails the same copy twice', () => {
  const { home, output } = hermes();
  output(home, 'j7', '2026-11-16_07-30-00.md', '[CRON_FAILURE]\nthe child failed');
  const state = emptyState(new Date(since));
  const rec = recorder();
  const first = runMailcopy({ hermesHome: home, cfg, state, now: new Date(NOW), send: rec.send, apply: true });
  assert.deepEqual([first.sent, first.failed, first.pending], [2, 0, 0]);
  assert.deepEqual(rec.sent.map((m) => m.to[0]).sort(), ['diane@one.example', 'frank@one.example']);
  assert.match(rec.sent[0].subject, /^\[Atlas\] FAILED: Both — 2026-11-16$/);
  const again = runMailcopy({ hermesHome: home, cfg, state, now: new Date(NOW + 600_000), send: rec.send, apply: true });
  assert.deepEqual([again.sent, rec.sent.length], [0, 2]);
});

test('a dry run sends and records nothing; a failing sender is retried and then given up on; a pass sends at most 12', () => {
  const { home, output } = hermes();
  output(home, 'j1', '2026-11-16_06-00-00.md', 'hello');
  const rec = recorder(); const state = emptyState(new Date(since));
  const dry = runMailcopy({ hermesHome: home, cfg, state, now: new Date(NOW), send: rec.send, apply: false });
  assert.deepEqual([dry.pending, rec.sent.length, Object.keys(state.sent).length], [1, 0, 0]);
  const bad = recorder(false);
  for (let i = 0; i < GIVE_UP_AFTER; i++) { const r = runMailcopy({ hermesHome: home, cfg, state, now: new Date(NOW + i * 600_000), send: bad.send, apply: true }); assert.deepEqual([r.failed, r.lastError], [1, 'SMTP down']); }
  assert.equal(bad.sent.length, GIVE_UP_AFTER);
  assert.equal(runMailcopy({ hermesHome: home, cfg, state, now: new Date(NOW), send: bad.send, apply: true }).failed, 0, 'given up after five tries');
  for (let i = 0; i < 20; i++) output(home, 'j1', `2026-11-16_08-${String(i).padStart(2, '0')}-00.md`, `report ${i}`);
  const s2 = emptyState(new Date(since)); const many = recorder();
  const r = runMailcopy({ hermesHome: home, cfg, state: s2, now: new Date(NOW), send: many.send, apply: true });
  assert.deepEqual([r.sent, r.pending], [MAX_PER_RUN, 9]);
});
