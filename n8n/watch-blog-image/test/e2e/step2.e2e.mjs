// Step 2 end to end, in a REAL local n8n 2.x with the Anthropic credential pointed at mock-anthropic.mjs.
//   N8N_BIN=/abs/path/n8n.sh E2E_N8N_HOME=/abs/scratch/n8n-e2e-home node --test test/e2e/step2.e2e.mjs
// Skipped when N8N_BIN is unset. One n8n execution per case (six cases); each takes about 10 s.
//
// Test workflow:
//   E2E: manual trigger
//   -> Parse + code checks (sanitizer)   fixture: {sanitized: {data_window}}, read by the Render code via $()
//   -> Fixture: writer output             fixture: the "Parse review + code checks" item {ok, stage, post, ...}
//   -> Fixture: Render WP blocks          the REAL Watch Centro "Render WP blocks" jsCode, verbatim
//   -> the fragment nodes from workflows/step2-extract-watches.json, verbatim (sticky note included)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWorkflow } from './run-workflow.mjs';
import { WRITER_POSTS } from '../fixtures/writer-posts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FRAGMENT_FILE = path.join(ROOT, 'workflows/step2-extract-watches.json');
const RENDERED = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/rendered-posts.json'), 'utf8'));
// The fixture file is the Watch Centro node code plus one header comment line.
const RENDER_FILE = fs.readFileSync(path.join(ROOT, 'test/fixtures/render-wp-blocks.js'), 'utf8');
const RENDER_CODE = RENDER_FILE.slice(RENDER_FILE.indexOf('\n') + 1).trimEnd();

const PREP = 'Image: prep post text';
const LLM = 'Image: extract watches (LLM)';
const BUILD = 'Image: build queries';
const RENDER = 'Fixture: Render WP blocks';
const GENERIC = { q: 'luxury wristwatch', level: 'generic', brand: '', model_family: '', model: '', reference: '', prominence: '', watch_index: -1 };
const skip = !process.env.N8N_BIN && 'N8N_BIN not set (see README, "End-to-end tests")';

const wordCount = p => [p.summary, p.takeaway, p.closing, ...(p.sections || []).flatMap(s => s.paragraphs || [])]
  .join(' ').split(/\s+/).filter(Boolean).length;

function code(id, name, x, jsCode) {
  return { id, name, type: 'n8n-nodes-base.code', typeVersion: 2, position: [x, 980], parameters: { jsCode } };
}

function testWorkflow(postName) {
  const fragment = JSON.parse(fs.readFileSync(FRAGMENT_FILE, 'utf8'));
  const { post, data_window } = WRITER_POSTS[postName];
  const reviewItem = { ok: true, stage: 'reviewer', reason: '', post, word_count: wordCount(post), run_date: '2026-10-07' };
  const entry = fragment.nodes.find(n => n.name === PREP);
  assert.ok(entry, `fragment has no "${PREP}" node`);
  return {
    name: `E2E step 2 (${postName})`,
    nodes: [
      { id: 'e2e2a000-0000-4000-8000-000000000001', name: 'E2E: manual trigger', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [1960, 980], parameters: {} },
      code('e2e2a000-0000-4000-8000-000000000002', 'Parse + code checks (sanitizer)', 2120,
        `return [{ json: ${JSON.stringify({ ok: true, sanitized: { data_window } })} }];`),
      code('e2e2a000-0000-4000-8000-000000000003', 'Fixture: writer output', 2280, `return [{ json: ${JSON.stringify(reviewItem)} }];`),
      code('e2e2a000-0000-4000-8000-000000000004', RENDER, 2440, RENDER_CODE),
      ...fragment.nodes,
    ],
    connections: {
      'E2E: manual trigger': { main: [[{ node: 'Parse + code checks (sanitizer)', type: 'main', index: 0 }]] },
      'Parse + code checks (sanitizer)': { main: [[{ node: 'Fixture: writer output', type: 'main', index: 0 }]] },
      'Fixture: writer output': { main: [[{ node: RENDER, type: 'main', index: 0 }]] },
      [RENDER]: { main: [[{ node: PREP, type: 'main', index: 0 }]] },
      ...fragment.connections,
    },
    settings: { executionOrder: 'v1', binaryMode: 'separate' },
  };
}

// Runs one case and returns the pieces the assertions need; the full result is saved next to the n8n log.
async function runCase(caseName, postName, fixtures) {
  const r = await runWorkflow({ workflow: testWorkflow(postName), fixtures });
  fs.writeFileSync(path.join(path.dirname(r.logs.n8n), `step2-${caseName}.result.json`), JSON.stringify(r, null, 2));
  assert.equal(r.ok, true, `workflow failed: ${JSON.stringify(r.error)}; see ${r.logs.n8n}`);
  for (const name of [RENDER, PREP, LLM, BUILD]) assert.ok(r.nodes[name], `node did not run: ${name}`);
  const rendered = r.nodes[RENDER][0].items;
  assert.equal(rendered.length, 1);
  const buildRun = r.nodes[BUILD][0];
  assert.equal(buildRun.items.length, 1);
  const calls = r.mock_requests.filter(q => q.method === 'POST' && q.path === '/v1/messages');
  return { r, rendered: rendered[0], llm: r.nodes[LLM][0], out: buildRun.items[0], outItem: buildRun.outputs.main[0][0], calls };
}

// What the API saw: the model, max_tokens, and a prompt built from the cleaned post text.
function assertPromptSent(call, rendered, mustContain) {
  assert.equal(call.body.model, 'claude-haiku-5-5');
  assert.equal(call.body.max_tokens, 1000);
  assert.deepEqual(call.body.thinking, { type: 'disabled' }, 'thinking is off, so the 1000 tokens are all for the JSON');
  assert.equal(call.body.messages.length, 1);
  assert.equal(call.body.messages[0].role, 'user');
  const prompt = call.body.messages[0].content;
  assert.equal(typeof prompt, 'string');
  assert.ok(prompt.startsWith('# Task\n'), 'prompt starts with the template text (no leading "=")');
  assert.ok(!prompt.includes('{{') && !prompt.includes('$json'), 'all n8n expressions were resolved');
  assert.ok(prompt.includes('{"watches": []}'), 'literal JSON braces in the prompt reach the API unchanged');
  const title = prompt.match(/<post_title>\n([\s\S]*?)\n<\/post_title>/);
  const text = prompt.match(/<post_text>\n([\s\S]*?)\n<\/post_text>/);
  assert.ok(title && text, 'prompt has the post_title and post_text sections');
  assert.equal(title[1], rendered.title);
  const body = text[1];
  assert.ok(body.length > 200, 'post text is not empty');
  assert.doesNotMatch(body, /<\/?[a-z][^>]*>/i, 'no HTML tags in the post text');
  assert.ok(!body.includes('wp:') && !body.includes('<!--'), 'no WordPress block comments in the post text');
  assert.doesNotMatch(body, /&(amp|lt|gt|quot|nbsp);/, 'entities are decoded');
  for (const s of mustContain) assert.ok(body.includes(s), `post text contains ${JSON.stringify(s)}`);
}

const qs = out => out.image_queries.map(q => q.q);

test('(a) multi-brand post: ordering, guard, denylist, generic last, source passed through', { skip, timeout: 300000 }, async () => {
  const title = WRITER_POSTS.steel.post.title;
  const watches = [
    // LLM order is deliberately not by prominence.
    { brand: 'Omega', model_family: 'Speedmaster', model: 'Speedmaster Professional', reference: '', mentioned_as: 'Speedmaster Professional', prominence: 'passing' },
    { brand: 'Rolex', model_family: 'Submariner', model: 'Rolex Submariner Date', reference: '126610LN', mentioned_as: 'Rolex Submariner Date 126610LN', prominence: 'primary' },
    { brand: 'Chrono24', model_family: '', model: '', reference: '', mentioned_as: 'Chrono24', prominence: 'passing' },
    { brand: 'Audemars Piguet', model_family: 'Royal Oak', model: 'Royal Oak Jumbo', reference: '', mentioned_as: 'AP Royal Oak', prominence: 'primary' },
    { brand: 'Breitling', model_family: 'Navitimer', model: 'Navitimer B01 Chronograph', reference: 'AB0138', mentioned_as: 'Breitling Navitimer', prominence: 'secondary' },
    { brand: 'Tudor', model_family: 'Black Bay', model: 'Black Bay 58', reference: '', mentioned_as: 'Tudor Black Bay 58', prominence: 'Secondary' },
    // The post never names a Daytona, but it does name Rolex: kept as a brand-only entry.
    { brand: 'Rolex', model_family: 'Daytona', model: 'Cosmograph Daytona', reference: '', mentioned_as: 'Rolex', prominence: 'passing' },
  ];
  const { rendered, llm, out, outItem, calls } = await runCase('a-multi-brand', 'steel', {
    [title]: { json: { watches } },
    __default__: { status: 400, message: 'E2E: prompt did not contain the expected post title' },
  });

  // The Render node ran in n8n and produced the same item as the unit-test fixture.
  assert.deepEqual(rendered, RENDERED.steel);
  assert.equal(llm.status, 'success');
  assert.equal(typeof llm.items[0].text, 'string');

  assert.equal(calls.length, 1);
  assertPromptSent(calls[0], rendered, ['Rolex Submariner Date 126610LN', 'AP Royal Oak', 'Buyers & sellers', 'Chrono24', 'Rank Model Brand Mentions']);

  assert.equal(out.extract_error, '');
  assert.deepEqual(out.source, rendered, 'source is the untouched Render WP blocks item');
  assert.equal(out.post_title, rendered.title);
  assert.deepEqual(out.watches.map(w => [w.brand, w.model, w.prominence]), [
    ['Rolex', 'Submariner Date', 'primary'],
    ['Audemars Piguet', 'Royal Oak Jumbo', 'primary'],
    ['Tudor', 'Black Bay 58', 'secondary'],
    ['Omega', 'Speedmaster Professional', 'passing'],
    ['Rolex', '', 'passing'],
  ]);
  assert.deepEqual(out.dropped_watches.map(w => [w.brand, w.reason]), [
    ['Chrono24', 'not a watch manufacturer (denylist)'],
    ['Breitling', 'not found in post text'],
    ['Rolex', 'model not found in post text (kept brand only)'],
  ]);
  // The last slot before the generic query is kept for the main brand.
  assert.deepEqual(qs(out), [
    'Rolex Submariner Date', 'Rolex Submariner', 'Audemars Piguet Royal Oak Jumbo', 'Audemars Piguet Royal Oak',
    'Tudor Black Bay 58', 'Rolex watch', 'luxury wristwatch',
  ]);
  assert.deepEqual(out.image_queries.map(q => q.level), ['model', 'family', 'model', 'family', 'model', 'brand', 'generic']);
  assert.deepEqual(out.image_queries[0], {
    q: 'Rolex Submariner Date', level: 'model', brand: 'Rolex', model_family: 'Submariner', model: 'Submariner Date', reference: '126610LN',
    prominence: 'primary', watch_index: 0,
  });
  assert.deepEqual(out.image_queries.at(-1), GENERIC);
  // Cut: Tudor Black Bay, Audemars Piguet watch, Omega Speedmaster Professional, Omega Speedmaster, Tudor watch, Omega watch.
  assert.equal(out.dropped_queries, 6);
  assert.deepEqual(outItem.pairedItem, { item: 0 });
});

test('(b) post with no watches: only the generic query', { skip, timeout: 300000 }, async () => {
  const title = WRITER_POSTS.quiet.post.title;
  const { rendered, out, calls } = await runCase('b-no-watches', 'quiet', {
    [title]: { json: { watches: [] } },
    __default__: { status: 400, message: 'E2E: prompt did not contain the expected post title' },
  });
  assert.equal(calls.length, 1);
  assertPromptSent(calls[0], rendered, ['insured shipping', 'buyer protection']);
  assert.deepEqual(out, {
    source: rendered, post_title: rendered.title, watches: [], image_queries: [GENERIC],
    dropped_watches: [], dropped_queries: 0, extract_error: '',
  });
});

test('(c) Anthropic API returns HTTP 500: the run still completes with the generic query', { skip, timeout: 300000 }, async () => {
  const title = WRITER_POSTS.dress.post.title;
  const { rendered, llm, out, calls } = await runCase('c-http-500', 'dress', {
    [title]: { status: 500, message: 'E2E: simulated outage' },
    __default__: { status: 400, message: 'E2E: prompt did not contain the expected post title' },
  });
  // onError continueRegularOutput turns the failure into an {error} item instead of stopping the workflow.
  assert.equal(llm.items.length, 1);
  assert.equal(typeof llm.items[0].error, 'string');
  assert.equal(llm.items[0].text, undefined);
  // retryOnFail with maxTries 2: the node ran twice, one request each time.
  assert.equal(calls.length, 2);
  assertPromptSent(calls[0], rendered, ['JLC Reverso Tribute', 'A. Lange & Söhne']);

  assert.match(out.extract_error, /^LLM error: /);
  assert.deepEqual(out.image_queries, [GENERIC]);
  assert.deepEqual(out.watches, []);
  assert.deepEqual(out.source, rendered);
  assert.equal(out.post_title, rendered.title);
});

test('(d) prose-wrapped, fenced JSON from the LLM is still parsed', { skip, timeout: 300000 }, async () => {
  const title = WRITER_POSTS.dress.post.title;
  const watches = [
    { brand: 'Jaeger-LeCoultre', model_family: 'Reverso', model: 'Reverso Tribute', reference: '', mentioned_as: 'JLC Reverso Tribute', prominence: 'primary' },
    { brand: 'A. Lange & Söhne', model_family: 'Lange 1', model: 'Lange 1', reference: '', mentioned_as: 'Lange 1', prominence: 'primary' },
    { brand: 'Grand Seiko', model_family: 'Heritage', model: 'Snowflake', reference: '', mentioned_as: 'GS Snowflake', prominence: 'secondary' },
    { brand: 'Patek Philippe', model_family: 'Nautilus', model: 'Nautilus', reference: '5711/1A', mentioned_as: 'Patek Philippe Nautilus 5711/1A', prominence: 'passing' },
    { brand: 'eBay', model_family: '', model: '', reference: '', mentioned_as: 'eBay auction', prominence: 'passing' },
  ];
  const reply = 'Here are the watches this post discusses:\n\n```json\n' + JSON.stringify({ watches }, null, 2) +
    '\n```\n\nLet me know if you need anything else.';
  const { rendered, out, calls } = await runCase('d-fenced-json', 'dress', {
    [title]: { text: reply },
    __default__: { status: 400, message: 'E2E: prompt did not contain the expected post title' },
  });
  assert.equal(calls.length, 1);
  assertPromptSent(calls[0], rendered, ['JLC Reverso Tribute', 'Lange 1', 'GS Snowflake']);

  assert.equal(out.extract_error, '');
  assert.deepEqual(out.source, rendered);
  assert.deepEqual(out.watches.map(w => w.brand), ['Jaeger-LeCoultre', 'A. Lange & Söhne', 'Grand Seiko', 'Patek Philippe']);
  assert.deepEqual(out.dropped_watches.map(w => [w.brand, w.reason]), [['eBay', 'not a watch manufacturer (denylist)']]);
  // '&' is dropped from queries; a model without its line ("Snowflake") is searched with it.
  assert.deepEqual(qs(out), [
    'Jaeger-LeCoultre Reverso Tribute', 'Jaeger-LeCoultre Reverso', 'A. Lange Söhne Lange 1',
    'Grand Seiko Heritage Snowflake', 'Grand Seiko Heritage', 'Jaeger-LeCoultre watch', 'luxury wristwatch',
  ]);
  // Cut: A. Lange Sohne watch, Patek Philippe Nautilus, Grand Seiko watch, Patek Philippe watch.
  assert.equal(out.dropped_queries, 4);
});

// A full Messages API body, for replies the text fixtures cannot express (thinking blocks).
const apiMessage = (content, stop_reason) => JSON.stringify({
  id: 'msg_e2e', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content, stop_reason, stop_sequence: null,
  usage: { input_tokens: 3000, output_tokens: 900 },
});
const SUB = { brand: 'Rolex', model_family: 'Submariner', model: 'Submariner Date', reference: '126610LN', mentioned_as: 'Rolex Submariner Date 126610LN', prominence: 'primary' };

test('(e) a reply that starts with a thinking block: the chain keeps only the text', { skip, timeout: 300000 }, async () => {
  const title = WRITER_POSTS.steel.post.title;
  const raw = apiMessage([{ type: 'thinking', thinking: '', signature: 'sig-e2e' }, { type: 'text', text: JSON.stringify({ watches: [SUB] }) }], 'end_turn');
  const { llm, out, calls } = await runCase('e-thinking-block', 'steel', {
    [title]: { raw, status: 200, contentType: 'application/json' },
    __default__: { status: 400, message: 'E2E: prompt did not contain the expected post title' },
  });
  assert.equal(calls.length, 1);
  assert.equal(llm.items[0].text, JSON.stringify({ watches: [SUB] }));
  assert.equal(out.extract_error, '');
  assert.deepEqual(qs(out), ['Rolex Submariner Date', 'Rolex Submariner', 'Rolex watch', 'luxury wristwatch']);
});

test('(f) reply cut off at max_tokens mid-JSON: the complete entries are kept', { skip, timeout: 300000 }, async () => {
  const title = WRITER_POSTS.steel.post.title;
  const cut = '{"watches": [' + JSON.stringify(SUB) + ', {"brand": "Audemars Piguet", "model_family": "Royal Oak", "model": "Roy';
  const { llm, out, calls } = await runCase('f-max-tokens', 'steel', {
    [title]: { text: cut, stop_reason: 'max_tokens' },
    __default__: { status: 400, message: 'E2E: prompt did not contain the expected post title' },
  });
  assert.equal(calls.length, 1, 'a cut-off reply is not an error item, so retryOnFail does not fire');
  assert.equal(llm.items[0].text, cut);
  assert.equal(out.extract_error, 'LLM JSON was invalid or cut off; kept 1 complete watch entry');
  assert.deepEqual(out.watches.map(w => w.model), ['Submariner Date']);
  assert.deepEqual(qs(out), ['Rolex Submariner Date', 'Rolex Submariner', 'Rolex watch', 'luxury wristwatch']);
});
