import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dirname, 'bin', 'sync-skills.sh');
const run = (home: string, ...args: string[]) => spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, HERMES_HOME: home } });

test('sync-skills: a dry run only reports; --apply copies the skill into the profile that uses it; a second run finds nothing to do; missing profiles are skipped', () => {
  const home = mkdtempSync(join(tmpdir(), 'hh-'));
  mkdirSync(join(home, 'profiles', 'qa', 'skills'), { recursive: true });          // qa exists, pm does not
  const dry = run(home);
  assert.match(dry.stdout, /\+ qa-browser-evidence -> .*profiles\/qa\/skills\/qa-browser-evidence\/SKILL\.md/);
  assert.match(dry.stdout, /no .*profiles\/pm\/skills \(profile not created\), skipped/);
  assert.equal(existsSync(join(home, 'profiles', 'qa', 'skills', 'qa-browser-evidence', 'SKILL.md')), false);   // dry run wrote nothing
  assert.match(run(home, '--apply').stdout, /✓ qa-browser-evidence/);
  const copied = readFileSync(join(home, 'profiles', 'qa', 'skills', 'qa-browser-evidence', 'SKILL.md'), 'utf8');
  assert.match(copied, /name: qa-browser-evidence/);
  assert.match(run(home).stdout, /= qa-browser-evidence is current/);
});
