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

const PAGE = `<html><body><h1>Demo</h1><button id="go" onclick="document.getElementById('out').textContent='Imported 2 transactions'">Upload</button><p id="out"></p><button id="news" onclick="fetch('/api/news').then(r=>r.json()).then(j=>document.getElementById('out').textContent='News: '+j.items.length).catch(()=>document.getElementById('out').textContent='News unavailable')">News</button></body></html>`;

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

test('ui-evidence.py: stubbed and failed network routes, and --attach puts every file on the kanban task from the terminal (exit 3 when one cannot be attached)', { skip: !hasPlaywright || !hasChrome ? 'needs python3 playwright and Chrome' : false }, async () => {
  const srv = createServer((_q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end(PAGE); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const dir = mkdtempSync(join(tmpdir(), 'uie-'));
  // a stand-in for the hermes CLI that records what it is asked to attach and can be told to refuse
  const fake = join(dir, 'hermes');
  writeFileSync(fake, ['#!/bin/sh', 'echo "$@" >> "$FAKE_LOG"', 'if [ -n "$FAKE_REFUSE" ] && [ "$FAKE_REFUSE" = "$(basename "$6")" ]; then echo refused >&2; exit 1; fi', 'exit 0', ''].join('\n'), { mode: 0o755 });
  const run = (spec: object, out: string, extra: string[] = [], env: Record<string, string> = {}) => new Promise<{ code: number; out: string }>((res) => {
    writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec));
    const c = spawn('python3', [HELPER, join(dir, 'spec.json'), out, ...extra], { env: { ...process.env, HERMES_BIN: fake, FAKE_LOG: join(dir, 'calls.log'), ...env } });
    let text = ''; c.stdout.on('data', (d) => { text += d; }); c.on('close', (code) => res({ code: code ?? -1, out: text }));
  });
  try {
    const spec = { base, checks: [
      { id: 'AC1', expect: 'a stubbed news service is shown', steps: [{ goto: '/' }, { click: '#news' }, { wait: 300 }], routes: [{ match: '**/api/news', status: 200, json: { items: [1, 2, 3] } }], assert: [{ text: 'News: 3' }], shot: 'ac1-stub.png' },
      { id: 'AC2', expect: 'network down shows a notice', steps: [{ goto: '/' }, { click: '#news' }, { wait: 300 }], routes: [{ match: '**/api/news', abort: true }], assert: [{ text: 'News unavailable' }], shot: 'ac2-down.png' },
    ] };
    const out = join(dir, 'out');
    const ok = await run(spec, out, ['--attach', 't_abc123', '--board', 'investments']);
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /2 of 2 checks passed/);
    const calls = readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n');
    assert.equal(calls.length, 4);                                                        // two screenshots, the report and results.json
    for (const c of calls) assert.match(c, /^kanban --board investments attach t_abc123 \//);
    assert.ok(calls.some((c) => c.endsWith('ui-report.md')) && calls.some((c) => c.endsWith('ac1-stub.png')));
    // one file refused: the checks passed but the evidence is not complete, so it says so with exit code 3
    writeFileSync(join(dir, 'calls.log'), '');
    const refused = await run(spec, join(dir, 'out2'), ['--attach', 't_abc123', '--board', 'investments'], { FAKE_REFUSE: 'ac2-down.png' });
    assert.equal(refused.code, 3);
    assert.match(refused.out, /NOT ATTACHED to t_abc123: ac2-down\.png/);
    // --attach needs --board
    const noBoard = await run(spec, join(dir, 'out3'), ['--attach', 't_abc123']);
    assert.equal(noBoard.code, 2);
  } finally { srv.close(); }
});
