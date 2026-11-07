import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from './cli.ts';

test('feedback add records a telegram message, dedupes by ref, and refuses private text', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fb-cli-'));
  const out: string[] = [];
  const cli = (...a: string[]) => main(a, { FEEDBACK_DIR: dir }, (s) => out.push(s));
  const store = join(dir, 'feedback.jsonl');
  const rows = () => readFileSync(store, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const base = ['feedback', 'add', '--source', 'telegram', '--by', 'frank', '--ref', '1:2'];

  assert.equal(cli(...base, '--text', 'The project page should show blocked tasks first'), 0);
  assert.match(out.at(-1)!, /dry run/);
  assert.equal(existsSync(store), false);

  assert.equal(cli(...base, '--text', 'The project page should show blocked tasks first', '--apply'), 0);
  assert.match(out.at(-1)!, /recorded fb-/);
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].source, 'telegram');
  assert.equal(rows()[0].by, 'frank');
  assert.equal(rows()[0].ref, '1:2');

  assert.equal(cli(...base, '--text', 'a retry of the same message', '--apply'), 0);
  assert.match(out.at(-1)!, /already recorded/);
  assert.equal(rows().length, 1);

  assert.equal(cli('feedback', 'add', '--source', 'telegram', '--text', 'my card is 4111 1111 1111 1111 please note', '--apply'), 1);
  assert.match(out.at(-1)!, /looks private/);
  assert.equal(rows().length, 1);
  assert.doesNotMatch(readFileSync(join(dir, 'privacy.jsonl'), 'utf8'), /4111/);

  assert.equal(cli('feedback', 'add', '--source', 'fax', '--text', 'hello there'), 1);
});
