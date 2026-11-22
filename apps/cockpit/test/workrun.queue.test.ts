import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childWorkRun } from '../src/work.ts';

// A stand-in for the work CLI: `slow` sleeps 1.2 s, `projects` answers at once, and every call is appended to a log.
function fake() {
  const dir = mkdtempSync(join(tmpdir(), 'wq-')), log = join(dir, 'calls.log'), cli = join(dir, 'cli.mjs');
  writeFileSync(log, '');
  writeFileSync(cli, `import { appendFileSync } from 'node:fs'; const [cmd] = process.argv.slice(2); appendFileSync(${JSON.stringify(log)}, cmd + '\\n');
    if (cmd === 'slow') await new Promise((r) => setTimeout(r, 1200)); console.log(cmd === 'projects' ? '[{"id":"p"}]' : 'ok ' + cmd);`);
  return { run: childWorkRun(process.env, process.execPath, cli), calls: () => readFileSync(log, 'utf8').split('\n').filter(Boolean) };
}

test('work runner: a read is not held up by a slow write, overlapping identical reads run once, and a write clears the reuse', async () => {
  const w = fake();
  const write = w.run(['slow']);
  const t = Date.now();
  const [a, b] = await Promise.all([w.run(['projects']), w.run(['projects'])]);
  assert.ok(Date.now() - t < 1100, 'the read waited for the write');
  assert.deepEqual([a.output, b.output], ['[{"id":"p"}]', '[{"id":"p"}]']);
  assert.equal(w.calls().filter((c) => c === 'projects').length, 1);              // shared
  await w.run(['projects']);
  assert.equal(w.calls().filter((c) => c === 'projects').length, 1);              // reused for 5 s
  assert.equal((await write).output, 'ok slow');
  await w.run(['other-write']);                                                    // a write forgets what was read before it
  await w.run(['projects']);
  assert.equal(w.calls().filter((c) => c === 'projects').length, 2);
});

test('work runner: writes still run strictly one at a time, in order', async () => {
  const w = fake();
  const first = w.run(['slow']), second = w.run(['quick-write']);
  await Promise.all([first, second]);
  assert.deepEqual(w.calls(), ['slow', 'quick-write']);
});
