import test from 'node:test';
import assert from 'node:assert/strict';
import { readText, PREP_CODE, BUILD_CODE } from './harness.mjs';
import { renderedPosts } from '../fixtures/generate.mjs';

const PROMPT = readText('src/extract-watches.prompt.txt');
const PLACEHOLDERS = ['{{POST_TITLE}}', '{{POST_TEXT}}'];

test('prompt has each placeholder exactly once', () => {
  for (const p of PLACEHOLDERS) assert.equal(PROMPT.split(p).length - 1, 1, p);
});

test('prompt is safe for n8n expressions and LangChain templates', () => {
  // build.mjs turns the placeholders into {{ $json.post_title }} / {{ $json.post_text }}; any other
  // '{{' would open an n8n expression. chainLlm 1.9 passes the whole text as the {query} variable
  // value, so single braces are not parsed by LangChain. n8n's splitter also turns '\\' into '\'.
  const rest = PLACEHOLDERS.reduce((s, p) => s.replace(p, ''), PROMPT);
  assert.ok(!rest.includes('{{'), 'stray {{');
  assert.ok(!rest.includes('}}'), 'stray }}');
  assert.ok(!rest.includes('\\'), 'backslash');
  assert.ok(!rest.includes('${'), 'template literal syntax');
});

test('prompt follows the house rules and names every output key and enum value', () => {
  assert.ok(!/[\u2014]/.test(PROMPT), 'no em dashes');
  for (const k of ['"watches"', '"brand"', '"model_family"', '"model"', '"reference"', '"mentioned_as"', '"prominence"', '"primary"', '"secondary"', '"passing"']) {
    assert.ok(PROMPT.includes(k), k);
  }
  for (const k of ['Chrono24', 'eBay', 'Audemars Piguet', 'Jaeger-LeCoultre', 'Vacheron Constantin', 'Grand Seiko', 'A. Lange & S\u00F6hne']) {
    assert.ok(PROMPT.includes(k), k);
  }
});

test('JSON examples in the prompt are valid and match the parser in "Image: build queries"', () => {
  const examples = PROMPT.split('\n').map(l => l.slice(l.indexOf('{'))).filter(l => l.startsWith('{"watches"'));
  assert.equal(examples.length, 2);
  const [full, empty] = examples.map(e => JSON.parse(e));
  assert.deepEqual(empty, { watches: [] });
  for (const w of full.watches) {
    assert.deepEqual(Object.keys(w), ['brand', 'model_family', 'model', 'reference', 'mentioned_as', 'prominence']);
  }
});

test('prompt example brands appear in no fixture post, so a copied example fails the guard', async () => {
  const examples = PROMPT.split('\n').map(l => l.slice(l.indexOf('{'))).filter(l => l.startsWith('{"watches"'));
  const brands = JSON.parse(examples[0]).watches.map(w => w.brand);
  assert.ok(brands.length >= 2);
  const posts = JSON.stringify(await renderedPosts()).toLowerCase();
  for (const b of brands) assert.ok(!posts.includes(b.split(' ')[0].toLowerCase()), b);
  for (const b of ['Rolex', 'Omega', 'Tudor', 'Patek', 'Audemars', 'Cartier']) assert.ok(!brands.some(x => x.includes(b)), b);
  // Rule 6: quotation marks inside mentioned_as would break the JSON, so the examples show none.
  for (const w of JSON.parse(examples[0]).watches) assert.doesNotMatch(w.mentioned_as, /["\u201C\u201D]/);
});

test('Code-node sources only use what the n8n task runner sandbox provides', () => {
  for (const [name, code] of [['prep', PREP_CODE], ['build', BUILD_CODE]]) {
    assert.doesNotMatch(code, /\brequire\s*\(|^\s*import\s|\bprocess\.|\bBuffer\b|\$json\b|\$getWorkflowStaticData/m, name);
    assert.match(code, /\$input\.all\(\)/, name);
    assert.ok(!/[\u2014]/.test(code), `${name}: no em dashes`);
  }
});

test('fixtures/rendered-posts.json is in sync with generate.mjs (run it to refresh)', async () => {
  assert.deepEqual(JSON.parse(readText('test/fixtures/rendered-posts.json')), await renderedPosts());
});
