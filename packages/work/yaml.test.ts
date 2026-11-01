import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml, stringifyYaml, YamlError } from './yaml.ts';

test('maps, nested maps, scalars and comments', () => {
  const v = parseYaml(`# header
id: notice-to-calendar-v1   # trailing comment
count: 9
ratio: 0.5
on: true
nothing: null
quoted: "a: b # not a comment"
single: 'it''s'
nested:
  deep:
    x: 1
  y: two
`);
  assert.deepEqual(v, { id: 'notice-to-calendar-v1', count: 9, ratio: 0.5, on: true, nothing: null, quoted: 'a: b # not a comment', single: "it's", nested: { deep: { x: 1 }, y: 'two' } });
});

test('block lists, lists of maps, flow lists and flow maps', () => {
  const v = parseYaml(`team: [coding, qa, "content writer"]
done_when:
  - 12 checks pass
  - "rollback documented"
tasks:
  - key: gate
    title: Day-0 gate
    needs: []
    accept: "≥90% correct"
  - key: build
    needs: [gate]
    outward: deploy
budget: { usd: 5, lane_minutes: 120 }
same_indent:
- a
- b
`);
  assert.deepEqual(v, {
    team: ['coding', 'qa', 'content writer'],
    done_when: ['12 checks pass', 'rollback documented'],
    tasks: [{ key: 'gate', title: 'Day-0 gate', needs: [], accept: '≥90% correct' }, { key: 'build', needs: ['gate'], outward: 'deploy' }],
    budget: { usd: 5, lane_minutes: 120 },
    same_indent: ['a', 'b'],
  });
});

test('unsupported or malformed input is an error naming the line, never a guess', () => {
  assert.throws(() => parseYaml('a: |\n  text'), /multi-line scalars/);
  assert.throws(() => parseYaml('a: &x 1'), /anchors/);
  assert.throws(() => parseYaml('a: 1\na: 2'), /duplicate key "a"/);
  assert.throws(() => parseYaml('a:\n\tb: 1'), /tabs/);
  assert.throws(() => parseYaml('a: [1, 2'), YamlError);
  assert.throws(() => parseYaml('a: "open'), /unterminated/);
  assert.throws(() => parseYaml('just text'), /expected "key: value"/);
  assert.equal(parseYaml(''), null);
});

test('stringify → parse round-trips a charter-shaped document', () => {
  const doc = {
    id: 'notice-to-calendar-v1', status: 'proposed', timebox: '7d', max_tasks: 9, flag: true, empty: [], none: null,
    team: ['coding', 'qa'],
    charter: { outcome: 'v1 on a public URL: spec §6 bar met', done_when: ['12 checks # pass', 'rollback documented'], outward: { deploy: { allowed: true, targets: ['preview.example.com'] }, publish: { allowed: 'draft-only' } } },
    tasks: [{ key: 'gate', needs: [], accept: '≥90%' }, { key: 'build', needs: ['gate'], accept: 'true' }],
    tricky: ['123', 'true', 'null', ' padded ', '- dash', 'a: b', ''],
  };
  const text = stringifyYaml(doc);
  assert.deepEqual(parseYaml(text), doc);
  assert.match(text, /^team: \[coding, qa\]$/m); // short scalar lists stay on one line
  assert.match(text, /accept: "true"/); // strings that look like booleans are quoted
});

test('strings that start with YAML indicators are quoted and read back as strings (a bare * would be an alias)', () => {
  const v = { scope: '*', a: '&x', b: '!tag', c: '|pipe', d: '>fold', e: '%p', f: '@at', g: '`tick' };
  assert.deepEqual(parseYaml(stringifyYaml(v)), v);
});
