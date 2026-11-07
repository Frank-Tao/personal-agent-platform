import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addFeedback, feedbackPath, keyOf, list, normalise, readAll, FeedbackError } from './feedback.ts';

const tmp = () => ({ dir: mkdtempSync(join(tmpdir(), 'fb-')), now: () => new Date('2026-11-07T09:00:00Z') });

test('add appends one line with id, text, source, page, time, status', () => {
  const o = tmp();
  const { item, duplicate } = addFeedback({ text: '  Blocked tasks are hidden  ', page: '#/p/x', by: 'frank' }, o);
  assert.equal(duplicate, false);
  const lines = readFileSync(feedbackPath(o.dir), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const r = JSON.parse(lines[0]);
  assert.match(r.id, /^fb-20261107-[0-9a-f]{6}$/);
  assert.deepEqual([r.text, r.source, r.page, r.time, r.status], ['Blocked tasks are hidden', 'cockpit', '#/p/x', '2026-11-07T09:00:00.000Z', 'open']);
  assert.equal(item.id, r.id);
});

test('validation: short, long and unknown source are refused', () => {
  const o = tmp();
  assert.throws(() => addFeedback({ text: 'hi' }, o), (e: any) => e instanceof FeedbackError && e.status === 400);
  assert.throws(() => addFeedback({ text: 'x'.repeat(2001) }, o), (e: any) => e.status === 400);
  assert.throws(() => addFeedback({ text: 'fine text', source: 'email' }, o), (e: any) => e.status === 400);
  assert.throws(() => addFeedback({ text: 42 }, o), (e: any) => e.status === 400);
});

test('dedupe: same text by same person within 24h, or same source+ref, is a no-op; a day later it is stored again', () => {
  const o = tmp();
  const a = addFeedback({ text: 'Feedback: Too slow!', by: 'frank' }, o).item;
  const b = addFeedback({ text: 'too slow', by: 'frank' }, o);
  assert.equal(b.duplicate, true); assert.equal(b.item.id, a.id);
  assert.equal(addFeedback({ text: 'too slow', by: 'diane' }, o).duplicate, false);
  const t1 = addFeedback({ text: 'one', source: 'telegram', ref: '1:2', by: 'f' }, o).item;
  assert.equal(addFeedback({ text: 'different words', source: 'telegram', ref: '1:2', by: 'f' }, o).item.id, t1.id);
  const later = { dir: o.dir, now: () => new Date('2026-11-08T09:00:01Z') };
  assert.equal(addFeedback({ text: 'too slow', by: 'frank' }, later).duplicate, false);
});

test('rate limit: 30 per source per hour', () => {
  const o = tmp();
  for (let i = 0; i < 30; i++) addFeedback({ text: `note number ${i}`, by: 'f' }, o);
  assert.throws(() => addFeedback({ text: 'one too many', by: 'f' }, o), (e: any) => e.status === 429);
  assert.equal(addFeedback({ text: 'from the cli', source: 'cli', by: 'f' }, o).duplicate, false);
});

test('reader skips torn lines and the last line for an id wins', () => {
  const o = tmp();
  const a = addFeedback({ text: 'first note' }, o).item;
  appendFileSync(feedbackPath(o.dir), '{"v":1,"id":"torn\n' + JSON.stringify({ ...a, status: 'rejected' }) + '\n');
  assert.equal(readAll(o).skipped, 1);
  const l = list(o); assert.equal(l.length, 1); assert.equal(l[0].status, 'rejected');
});

test('normalise and key', () => {
  assert.equal(normalise('#feedback  Hello,  World!'), 'hello world');
  assert.equal(keyOf('Hello World'), keyOf('#feedback hello, world!'));
  assert.equal(keyOf('x').length, 12);
});
