import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The page scripts are plain JavaScript that no test runs, so a function that is called but never defined only shows up in the browser
// (20 Nov: autoTag and fmtWhen were used but not written, and every project page failed). TypeScript's checker finds such names
// without running anything; only "cannot find name" errors count here, not the many type complaints about untyped JS.
const ROOT = join(import.meta.dirname, '..', '..', '..');
const PUBLIC = join(ROOT, 'apps', 'cockpit', 'public');

test('page scripts: every name they use is defined', () => {
  const scripts = readdirSync(PUBLIC).filter((f) => f.endsWith('.js')).map((f) => join(PUBLIC, f));
  assert.ok(scripts.length > 0);
  const r = spawnSync(join(ROOT, 'node_modules', '.bin', 'tsc'), ['--ignoreConfig', '--allowJs', '--checkJs', '--noEmit', '--skipLibCheck', '--target', 'es2022', '--lib', 'es2022,dom,dom.iterable', ...scripts], { encoding: 'utf8' });
  assert.ok(/error TS/.test(r.stdout) || r.status === 0, `tsc did not run: ${r.stderr || r.stdout}`.slice(0, 300));
  const undefinedNames = r.stdout.split('\n').filter((l) => /error TS(2304|2552):/.test(l)).map((l) => l.replace(ROOT + '/', ''));
  assert.deepEqual(undefinedNames, []);
});

// The browser's own confirm/prompt/alert boxes look unprofessional and cannot be styled or tested (13 Nov: a click on a task popped one up).
// The page has in-page dialogs for this (askBox, confirmBox, promptBox); this keeps the native ones from coming back.
test('page scripts: no native confirm(), prompt() or alert() boxes', () => {
  const offenders: string[] = [];
  for (const f of readdirSync(PUBLIC).filter((n) => n.endsWith('.js'))) {
    readFileSync(join(PUBLIC, f), 'utf8').split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '').replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");
      if (/(^|[^\w.$])(window\.)?(confirm|prompt|alert)\(/.test(code)) offenders.push(`${f}:${i + 1}: ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(offenders, []);
});
