import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gatherEvidence, readAttachment } from '../src/evidence.ts';

// 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function fakeHermes() {
  const home = mkdtempSync(join(tmpdir(), 'hh-'));
  const board = join(home, 'kanban', 'boards', 'investments');
  mkdirSync(join(board, 'attachments', 't_aaaa1111'), { recursive: true });
  mkdirSync(join(board, 'attachments', 't_bbbb2222'), { recursive: true });
  const db = new DatabaseSync(join(board, 'kanban.db'));
  db.exec('CREATE TABLE tasks (id TEXT, title TEXT, tenant TEXT)');
  db.prepare('INSERT INTO tasks VALUES (?,?,?)').run('t_aaaa1111', 'QA evidence', 'proj-a');
  db.prepare('INSERT INTO tasks VALUES (?,?,?)').run('t_bbbb2222', 'Other project task', 'proj-b');
  db.close();
  const work = mkdtempSync(join(tmpdir(), 'ev-'));
  mkdirSync(join(work, 'shots'));
  writeFileSync(join(work, 'shots', 'dashboard.png'), PNG);
  writeFileSync(join(work, 'shots', 'notes.txt'), 'hello');
  execFileSync('zip', ['-qr', join(board, 'attachments', 't_aaaa1111', 'evidence.zip'), 'shots'], { cwd: work });
  execFileSync('tar', ['-czf', join(board, 'attachments', 't_aaaa1111', 'bundle.tar.gz'), 'shots'], { cwd: work });
  writeFileSync(join(board, 'attachments', 't_aaaa1111', 'report.md'), '# Report');
  writeFileSync(join(board, 'attachments', 't_aaaa1111', 'direct.png'), PNG);
  writeFileSync(join(board, 'attachments', 't_bbbb2222', 'secret.md'), 'other project');
  return home;
}

test('evidence: a project\'s attachments are found by tenant, screenshots inside zip and tar bundles are listed, other projects are left out', async () => {
  const home = fakeHermes();
  const ev = await gatherEvidence(home, 'proj-a', () => true);
  assert.deepEqual(ev.map((e) => [e.name, e.kind]).sort(), [['bundle.tar.gz', 'archive'], ['direct.png', 'image'], ['evidence.zip', 'archive'], ['report.md', 'file']]);
  for (const a of ev.filter((e) => e.kind === 'archive')) assert.deepEqual(a.images.map((i) => i.entry), ['shots/dashboard.png']);
  assert.equal(ev.some((e) => e.name === 'secret.md'), false);
  assert.deepEqual(await gatherEvidence(home, 'proj-a', () => false), []);          // a board this person may not see contributes nothing
});

test('attachments are served only when they are really in the task folder; screenshots come out of bundles; nothing else does', async () => {
  const home = fakeHermes();
  const direct = await readAttachment(home, 'investments', 't_aaaa1111', 'direct.png');
  assert.deepEqual([direct?.type, direct?.inline, direct?.body.equals(PNG)], ['image/png', true, true]);
  const rep = await readAttachment(home, 'investments', 't_aaaa1111', 'report.md');
  assert.deepEqual([rep?.type.startsWith('text/plain'), rep?.inline], [true, false]);        // documents download, they are not rendered as a page
  for (const f of ['evidence.zip', 'bundle.tar.gz']) {
    const shot = await readAttachment(home, 'investments', 't_aaaa1111', f, 'shots/dashboard.png');
    assert.equal(shot?.body.equals(PNG), true, f);
    assert.equal(await readAttachment(home, 'investments', 't_aaaa1111', f, 'shots/notes.txt'), null);       // only images come out of a bundle
    assert.equal(await readAttachment(home, 'investments', 't_aaaa1111', f, '../../etc/passwd.png'), null);
  }
  for (const bad of ['../t_bbbb2222/secret.md', 'nope.md', '/etc/passwd', '.hidden', '..']) assert.equal(await readAttachment(home, 'investments', 't_aaaa1111', bad), null, bad);
  assert.equal(await readAttachment(home, 'investments', 't_zzzz0000', 'report.md'), null);
  assert.equal(await readAttachment(home, '../investments', 't_aaaa1111', 'report.md'), null);
});
