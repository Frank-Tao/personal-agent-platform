import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The QA helper: a real browser, a tiny local page, one passing and one failing check. Skipped where Chrome or the playwright package is not there.
const HELPER = join(import.meta.dirname, 'ui-evidence.py');
const hasPlaywright = spawnSync('python3', ['-c', 'import playwright'], { encoding: 'utf8' }).status === 0;
const hasChrome = existsSync('/Applications/Google Chrome.app') || existsSync('/usr/bin/google-chrome');

const PAGE = '<html><body><h1>Demo</h1><button id="go" onclick="document.getElementById(\'out\').textContent=\'Imported 2 transactions\'">Upload</button><p id="out"></p></body></html>';

test('ui-evidence.py: screenshots and a report for each check, exit 0 when all pass and 1 when one fails', { skip: !hasPlaywright || !hasChrome ? 'needs python3 playwright and Chrome' : false }, async () => {
  const srv = createServer((_q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end(PAGE); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const dir = mkdtempSync(join(tmpdir(), 'uie-'));
  const run = (spec: object, out: string) => new Promise<number>((res) => { writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec)); const c = spawn('python3', [HELPER, join(dir, 'spec.json'), out]); c.on('close', (code) => res(code ?? -1)); });
  try {
    const pass = join(dir, 'pass');
    const ok = await run({ base, requirement: 'dark', checks: [{ id: 'AC1', expect: 'Upload shows the result', steps: [{ goto: '/' }, { click: '#go' }], assert: [{ text: 'Imported 2 transactions' }, { visible: '#out' }], shot: 'ac1-upload.png' }] }, pass);
    assert.equal(ok, 0);
    assert.ok(existsSync(join(pass, 'ac1-upload.png')) && readFileSync(join(pass, 'ac1-upload.png')).length > 1000);
    assert.match(readFileSync(join(pass, 'ui-report.md'), 'utf8'), /Requirement: dark[\s\S]*\| AC1 \| Upload shows the result \| PASS \| \[ac1-upload\.png\]/);
    const bad = join(dir, 'bad');
    const code = await run({ base, checks: [{ id: 'AC2', expect: 'a table of holdings', steps: [{ goto: '/' }], assert: [{ text: 'Holdings table' }], shot: 'ac2.png' }] }, bad);
    assert.equal(code, 1);
    assert.match(readFileSync(join(bad, 'ui-report.md'), 'utf8'), /\| AC2 \| a table of holdings \| FAIL \|/);
    assert.ok(existsSync(join(bad, 'ac2.png')));            // a failure still has its screenshot
    const results = JSON.parse(readFileSync(join(bad, 'results.json'), 'utf8'));
    assert.equal(results.results[0].passed, false);
  } finally { srv.close(); }
});
