import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDelivery, repoFileUrl, DeliveryError } from './delivery.ts';

test('repo paths become GitHub links from https and ssh remotes; other hosts give nothing', () => {
  assert.equal(repoFileUrl('https://github.com/Frank-Tao/portfolio-tracker.git', 'docs/verify.md'), 'https://github.com/Frank-Tao/portfolio-tracker/blob/main/docs/verify.md');
  assert.equal(repoFileUrl('git@github.com:Frank-Tao/portfolio-tracker.git', '/README.md'), 'https://github.com/Frank-Tao/portfolio-tracker/blob/main/README.md');
  assert.equal(repoFileUrl('https://example.com/a/b.git', 'x'), null);
});

test('a delivery needs a real summary, an http(s) address and documents with titles; text that looks private is refused', () => {
  const ok = { summary: 'A local app that tracks ETF holdings.', at: '2026-11-22T00:00:00Z' };
  assert.equal(makeDelivery({ ...ok, url: 'http://localhost:8000', docs: [{ title: 'README', url: 'https://x.test/r' }] }).url, 'http://localhost:8000');
  assert.throws(() => makeDelivery({ ...ok, summary: 'short' }), DeliveryError);
  assert.throws(() => makeDelivery({ ...ok, url: 'localhost:8000' }), /http/);
  assert.throws(() => makeDelivery({ ...ok, docs: [{ title: '', url: 'https://x.test' }] }), DeliveryError);
  assert.throws(() => makeDelivery({ ...ok, summary: 'Account number 123456789012 holds the money for the app.' }), /private/);
});
