import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPanel, marketOf, readPanel } from './panel.ts';

const synthetic = JSON.parse(readFileSync(new URL('./synthetic.json', import.meta.url), 'utf8'));
const NOW = new Date('2099-01-01T01:00:00Z');

test('synthetic snapshot: total, allocation by market and top positions', () => {
  const p = buildPanel(synthetic, { now: NOW, top: 3 });
  assert.equal(p.state, 'ok');
  assert.equal(p.totalAud, 20000);
  assert.deepEqual(p.byMarket.map((m) => [m.market, m.valueAud]), [['ASX', 6000], ['US', 8000], ['China', 6000]].sort((a, b) => (b[1] as number) - (a[1] as number)));
  assert.ok(Math.abs(p.byMarket.reduce((n, m) => n + m.share, 0) - 1) < 1e-9);
  assert.deepEqual(p.topPositions.map((x) => x.symbol), ['BHP.AX', 'AAPL', '0700.HK']);
  assert.equal(p.topPositions[0].share, 0.3);
});

test('markets are told apart by symbol', () => {
  assert.deepEqual(['CBA.AX', 'AAPL', '0700.HK', '600519.SS', '000001.SZ'].map(marketOf), ['ASX', 'US', 'China', 'China', 'China']);
});

test('stale, old, non-AUD and malformed snapshots are flagged, never shown as current or as zero', () => {
  assert.equal(buildPanel({ ...synthetic, stale: true, warnings: ['missing FX'] }, { now: NOW }).state, 'stale');
  assert.deepEqual(buildPanel({ ...synthetic, stale: true, warnings: ['missing FX'] }, { now: NOW }).warnings, ['missing FX']);
  const old = buildPanel(synthetic, { now: new Date('2099-01-05T00:00:00Z') });
  assert.equal(old.state, 'stale'); assert.match(old.warnings.join(), /hours old/);
  assert.equal(buildPanel({ ...synthetic, base_currency: 'USD' }, { now: NOW }).state, 'stale');
  assert.equal(buildPanel({ ...synthetic, generated_at: undefined }, { now: NOW }).state, 'stale');
  for (const bad of [null, {}, { positions: [] }, { total_value_aud: 1, positions: [{ symbol: 'X' }] }]) {
    const p = buildPanel(bad as any); assert.equal(p.state, 'unavailable'); assert.equal(p.totalAud, undefined);
  }
});

test('readPanel: unset, missing and corrupt files are unavailable; a good file is read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-'));
  assert.equal(readPanel(undefined).state, 'unavailable');
  assert.equal(readPanel(join(dir, 'nope.json')).state, 'unavailable');
  writeFileSync(join(dir, 'bad.json'), '{oops'); assert.equal(readPanel(join(dir, 'bad.json')).state, 'unavailable');
  writeFileSync(join(dir, 'ok.json'), JSON.stringify(synthetic));
  assert.equal(readPanel(join(dir, 'ok.json'), { now: NOW }).totalAud, 20000);
});
