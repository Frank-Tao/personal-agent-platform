import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
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
