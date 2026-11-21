import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LANE = join(import.meta.dirname, 'lane.sh');

/** A fake `claude` and `ollama` that echo the prompt they were given, so the test sees exactly what the lane sent. */
async function world() {
  const dir = await mkdtemp(join(tmpdir(), 'lane-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  for (const name of ['claude', 'ollama']) { writeFileSync(join(bin, name), '#!/bin/sh\ncat\n'); chmodSync(join(bin, name), 0o755); }
  const work = join(dir, 'work'); mkdirSync(work);
  const prompt = join(dir, 'prompt.md'); writeFileSync(prompt, 'Goal: rename foo to bar.\n');
  const run = (lane: string, out: string, env: Record<string, string> = {}) => {
    execFileSync('bash', [LANE, lane, work, prompt, join(dir, out)], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LANE_LEDGER: join(dir, 'lanes.jsonl'), LANE_MODEL: 'm', ...env } });
    return { result: readFileSync(join(dir, out, 'result.md'), 'utf8'), meta: JSON.parse(readFileSync(join(dir, out, 'meta.json'), 'utf8')) };
  };
  return { run, dir };
}

test('editing lanes get the worker preamble before the task, and the sent prompt is kept', async () => {
  const w = await world();
  const { result, meta } = w.run('claude', 'o1');
  assert.match(result, /^# How to work[\s\S]*## Result[\s\S]*Goal: rename foo to bar\./);
  assert.equal(meta.preamble, true);
  assert.equal(readFileSync(join(w.dir, 'o1', 'prompt.md'), 'utf8'), result);
});

test('the local lane and LANE_PREAMBLE=0 send the prompt as written', async () => {
  const w = await world();
  const local = w.run('ollama', 'o2');
  assert.equal(local.result, 'Goal: rename foo to bar.\n');
  assert.equal(local.meta.preamble, false);
  const off = w.run('claude', 'o3', { LANE_PREAMBLE: '0' });
  assert.equal(off.result, 'Goal: rename foo to bar.\n');
});
