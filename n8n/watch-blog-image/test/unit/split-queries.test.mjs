import test from 'node:test';
import assert from 'node:assert/strict';
import { runCode, runBuild, llmText, SPLIT_CODE } from './harness.mjs';
import { post, Q_MODEL, Q_FAMILY, Q_BRAND, Q_GENERIC, W_SUB } from './step3-helpers.mjs';

const split = posts => runCode(SPLIT_CODE, { input: posts.map(json => ({ json })) });
const FIELDS = ['post_index', 'rank', 'q', 'level', 'brand', 'model_family', 'model', 'reference', 'prominence', 'watch_index'];

test('split: one item per (post, query), in order, paired to its post', async () => {
  const out = await split([post([Q_MODEL, Q_FAMILY, Q_BRAND, Q_GENERIC]), post([Q_BRAND, Q_GENERIC])]);
  assert.deepEqual(out.map(o => [o.json.post_index, o.json.rank, o.json.q, o.pairedItem.item]), [
    [0, 0, 'Rolex Submariner Date', 0], [0, 1, 'Rolex Submariner', 0], [0, 2, 'Rolex watch', 0], [0, 3, 'luxury wristwatch', 0],
    [1, 0, 'Rolex watch', 1], [1, 1, 'luxury wristwatch', 1],
  ]);
  for (const o of out) assert.deepEqual(Object.keys(o.json), FIELDS);
  assert.deepEqual(out[0].json, { post_index: 0, rank: 0, ...Object.fromEntries(Object.entries(Q_MODEL)) });
});

test('split: runs on the real "Image: build queries" output', async () => {
  const posts = await runBuild([llmText([W_SUB])], [{ post_title: 'T', post_text: 'The Rolex Submariner Date 126610LN led.', source: {} }]);
  const out = await runCode(SPLIT_CODE, { input: posts });
  assert.deepEqual(out.map(o => o.json.q), posts[0].json.image_queries.map(q => q.q));
  out.forEach((o, r) => assert.deepEqual(o.json, { post_index: 0, rank: r, ...posts[0].json.image_queries[r] }));
});

const SKIP_CASES = [
  ['no image_queries key', { source: {} }],
  ['empty image_queries', post([])],
  ['image_queries is a string', post('luxury wristwatch')],
  ['null json', null],
  ['a string item', 'oops'],
];
for (const [name, bad] of SKIP_CASES) {
  test(`split: a post with no usable queries emits nothing (${name}); other posts keep their post_index`, async () => {
    const out = await runCode(SPLIT_CODE, { input: [{ json: bad }, { json: post([Q_GENERIC]) }] });
    assert.deepEqual(out.map(o => [o.json.post_index, o.json.q, o.pairedItem.item]), [[1, 'luxury wristwatch', 1]]);
  });
}

test('split: blank or missing q is never emitted (Openverse would return unrelated popular images); rank keeps its index', async () => {
  const out = await split([post([{ ...Q_MODEL, q: '   ' }, null, { ...Q_FAMILY, q: undefined }, 'x', Q_BRAND, { ...Q_GENERIC, q: ' luxury \n wristwatch ' }])]);
  assert.deepEqual(out.map(o => [o.json.rank, o.json.q]), [[4, 'Rolex watch'], [5, 'luxury wristwatch']]);
});

test('split: field cleanup (unknown level -> generic, non-integer watch_index -> -1, non-strings -> "", q capped at 200)', async () => {
  const long = 'Rolex ' + 'x'.repeat(300);
  const out = await split([post([{ q: long, level: 'weird', brand: 7, model_family: null, watch_index: '0' }])]);
  assert.equal(out[0].json.q.length, 200);
  assert.deepEqual({ ...out[0].json, q: '' }, {
    post_index: 0, rank: 0, q: '', level: 'generic', brand: '', model_family: '', model: '', reference: '', prominence: '', watch_index: -1,
  });
});

test('split: no input items gives no output and never throws', async () => {
  assert.deepEqual(await runCode(SPLIT_CODE, { input: [] }), []);
});
