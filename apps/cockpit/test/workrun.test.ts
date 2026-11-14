import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childWorkRun } from '../src/work.ts';

test('work in a child process: output and exit code come back, calls run one at a time, and the caller is not blocked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workrun-'));
  const log = join(dir, 'log');
  const cli = join(dir, 'cli.mjs');
  // a stand-in CLI: records start and end, waits a little, prints its arguments, exits with the code it is told to
  writeFileSync(cli, `import { appendFileSync } from 'node:fs';
const [name, code] = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, 'start ' + name + '\\n');
await new Promise((r) => setTimeout(r, 60));
appendFileSync(${JSON.stringify(log)}, 'end ' + name + '\\n');
console.log('ran ' + name + ' for ' + process.env.WHO);
process.exit(Number(code ?? 0));
`);
  const run = childWorkRun({ ...process.env, WHO: 'cockpit' }, process.execPath, cli);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  const [a, b, c] = await Promise.all([run(['a']), run(['b', '3']), run(['c'])]);
  clearInterval(timer);
  assert.deepEqual(a, { code: 0, output: 'ran a for cockpit' });
  assert.deepEqual(b, { code: 3, output: 'ran b for cockpit' });   // a refusal still returns what the CLI said
  assert.equal(c.code, 0);                                          // and does not stop the calls queued behind it
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  assert.ok(ticks > 10, `the event loop kept turning while the CLI ran (${ticks} ticks)`);
});
