import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataDir, envFileValue, envName, liveConfig } from './paths.ts';

const repo = () => {
  const r = mkdtempSync(join(tmpdir(), 'paths-'));
  mkdirSync(join(r, 'config')); mkdirSync(join(r, 'infra'));
  writeFileSync(join(r, 'config', 'agents.json'), '{"agents":["shipped"]}');
  return r;
};

test('dev: no setting means data/ and config/ in the repo, exactly as before', () => {
  const r = repo();
  assert.equal(dataDir({}, r), join(r, 'data'));
  assert.equal(liveConfig('agents.json', {}, r), join(r, 'config', 'agents.json'));
  assert.equal(envName({}, r), 'dev');
  assert.equal(envName({ COCKPIT_DEMO: '1' }, r), 'demo');
});

test('prod: PAP_DATA_DIR from the environment, or from infra/env when a plain shell has none; the environment wins', () => {
  const r = repo(), d = mkdtempSync(join(tmpdir(), 'data-'));
  writeFileSync(join(r, 'infra', 'env'), `COCKPIT_ADMIN_TOKEN=secret\nPAP_DATA_DIR="${d}"\n# PAP_DATA_DIR=/ignored\n`);
  assert.equal(dataDir({}, r), d);
  assert.equal(envFileValue(join(r, 'infra', 'env'), 'PAP_DATA_DIR'), d);
  assert.equal(dataDir({ PAP_DATA_DIR: '/elsewhere' }, r), '/elsewhere');
  assert.equal(envName({}, r), 'prod');
  writeFileSync(join(r, 'infra', 'env'), `PAP_DATA_DIR=~/pap-data\nPAP_ENV=dev\n`);
  assert.equal(dataDir({}, r), join(homedir(), 'pap-data'));   // ~ is expanded
  assert.equal(envName({}, r), 'dev');
});

test('prod: a rewritten config file lives in the data folder, is seeded once from the tracked copy and never overwritten by it', () => {
  const r = repo(), d = mkdtempSync(join(tmpdir(), 'data-'));
  const env = { PAP_DATA_DIR: d };
  const live = liveConfig('agents.json', env, r);
  assert.equal(live, join(d, 'config', 'agents.json'));
  assert.equal(readFileSync(live, 'utf8'), '{"agents":["shipped"]}');            // seeded
  writeFileSync(live, '{"agents":["edited at runtime"]}');
  writeFileSync(join(r, 'config', 'agents.json'), '{"agents":["new shipped version"]}');   // a deploy replaces the tracked file
  assert.equal(readFileSync(liveConfig('agents.json', env, r), 'utf8'), '{"agents":["edited at runtime"]}');
  assert.equal(existsSync(liveConfig('nothing.json', env, r)), false);           // no tracked copy, nothing invented
});
