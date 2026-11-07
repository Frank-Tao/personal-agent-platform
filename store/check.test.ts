import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkStorefronts, formatResults, main, type Fetcher } from './check.ts';

const app = { trackId: 6829698460, trackName: 'APA 7 Review', bundleId: 'com.aithrival.apa7review', version: '1.0', price: 0, currency: 'USD', trackViewUrl: 'https://apps.apple.com/us/app/apa-7-review/id6829698460?uo=4', releaseDate: '2026-11-06T08:00:00Z', minimumOsVersion: '18.0', sellerName: 'X' };
const fake = (live: string[]): Fetcher => async (url) => ({ ok: true, status: 200, json: async () => ({ results: live.includes(new URL(url).searchParams.get('country')!) ? [app] : [] }) });

test('store check: found and not found per country, URL without tracking query, exit code 1 when any is missing', async () => {
  const rs = await checkStorefronts({ bundle: 'com.aithrival.apa7review' }, ['US', 'au', 'cn'], fake(['us', 'au']));
  assert.deepEqual(rs.map((r) => [r.country, r.found]), [['us', true], ['au', true], ['cn', false]]);
  assert.equal(rs[0].url, 'https://apps.apple.com/us/app/apa-7-review/id6829698460');
  assert.match(formatResults(rs), /✗ CN  not found[\s\S]*not proof/);
  const lines: string[] = [];
  assert.equal(await main(['check', '--bundle', 'com.aithrival.apa7review', '--countries', 'us,au'], fake(['us', 'au']), (s) => lines.push(s)), 0);
  assert.equal(await main(['check', '--id', '6829698460'], fake(['us']), (s) => lines.push(s)), 1);
});

test('store check: bad input is refused before any request; a network error is reported per country', async () => {
  let calls = 0;
  const f: Fetcher = async () => { calls++; throw new Error('offline'); };
  await assert.rejects(checkStorefronts({}, ['us'], f), /--bundle/);
  await assert.rejects(checkStorefronts({ id: 'abc' }, ['us'], f), /numeric/);
  await assert.rejects(checkStorefronts({ bundle: 'a.b.c' }, ['usa'], f), /two-letter/);
  assert.equal(calls, 0);
  const rs = await checkStorefronts({ bundle: 'a.b.c' }, ['us'], f);
  assert.deepEqual([rs[0].found, rs[0].error], [false, 'offline']);
});
