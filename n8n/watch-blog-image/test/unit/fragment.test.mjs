import test from 'node:test';
import assert from 'node:assert/strict';
import { readText, PREP_CODE, BUILD_CODE } from './harness.mjs';
import { buildFragment, NAMES } from '../../build.mjs';

const FILE = 'workflows/step2-extract-watches.json';
const fragment = JSON.parse(readText(FILE));
const byName = Object.fromEntries(fragment.nodes.map(n => [n.name, n]));

test(`${FILE} is in sync with build.mjs (run "npm run build" to refresh)`, () => {
  assert.deepEqual(fragment, buildFragment());
});

test('fragment is in n8n paste format with the expected nodes and type versions', () => {
  assert.deepEqual(Object.keys(fragment), ['nodes', 'connections', 'pinData']);
  assert.deepEqual(fragment.nodes.map(n => [n.name, n.type, n.typeVersion]), [
    [NAMES.prep, 'n8n-nodes-base.code', 2],
    [NAMES.llm, '@n8n/n8n-nodes-langchain.chainLlm', 1.9],
    [NAMES.model, '@n8n/n8n-nodes-langchain.lmChatAnthropic', 1.6],
    [NAMES.build, 'n8n-nodes-base.code', 2],
    [NAMES.sticky, 'n8n-nodes-base.stickyNote', 1],
  ]);
  for (const n of fragment.nodes) {
    assert.match(n.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, n.name);
    assert.ok(n.position.every(v => Number.isInteger(v) && v % 20 === 0), n.name);
    assert.ok(n.position[1] >= 660, `${n.name} sits below the existing Watch Centro flow (Respond: blocked label ends near y 660)`);
  }
});

test('connections: prep -> LLM -> build, model sub-node -> LLM, all inside the fragment', () => {
  assert.deepEqual(fragment.connections, {
    [NAMES.prep]: { main: [[{ node: NAMES.llm, type: 'main', index: 0 }]] },
    [NAMES.model]: { ai_languageModel: [[{ node: NAMES.llm, type: 'ai_languageModel', index: 0 }]] },
    [NAMES.llm]: { main: [[{ node: NAMES.build, type: 'main', index: 0 }]] },
  });
});

test('Code nodes carry the src files verbatim', () => {
  assert.equal(byName[NAMES.prep].parameters.jsCode, PREP_CODE.trimEnd());
  assert.equal(byName[NAMES.build].parameters.jsCode, BUILD_CODE.trimEnd());
  for (const name of [NAMES.prep, NAMES.build]) assert.equal(byName[name].parameters.mode, 'runOnceForAllItems');
});

test('LLM node: define prompt with the two n8n expressions, continue on error, one retry', () => {
  const llm = byName[NAMES.llm];
  assert.equal(llm.parameters.promptType, 'define');
  const text = llm.parameters.text;
  assert.ok(text.startsWith('=# Task\n'));
  assert.deepEqual(text.match(/\{\{[\s\S]*?\}\}/g), ['{{ $json.post_title }}', '{{ $json.post_text }}']);
  assert.equal(text.split('{{').length - 1, 2);
  assert.equal(text.slice(1).replace('{{ $json.post_title }}', '{{POST_TITLE}}').replace('{{ $json.post_text }}', '{{POST_TEXT}}'),
    readText('src/extract-watches.prompt.txt').trimEnd());
  assert.equal(llm.onError, 'continueRegularOutput');
  assert.equal(llm.retryOnFail, true);
  assert.equal(llm.maxTries, 2);
  assert.equal(llm.parameters.hasOutputParser, undefined, 'no output parser: output stays {text}');
});

test('model sub-node: Claude Haiku 5.5, 1000 tokens, thinking off, the Watch Centro Anthropic credential', () => {
  const m = byName[NAMES.model];
  // Haiku 5.5 thinks by default when the request has no "thinking" field, and thinking tokens count
  // toward max_tokens, so an unset thinkingMode could spend the 1000 tokens before any JSON is written.
  assert.deepEqual(m.parameters, {
    model: { __rl: true, mode: 'list', value: 'claude-haiku-5-5', cachedResultName: 'Claude Haiku 5.5' },
    options: { maxTokensToSample: 1000, thinkingMode: 'disabled' },
  });
  assert.deepEqual(m.credentials, { anthropicApi: { id: 'Fy3gBIA4bOXd96pw', name: 'Anthropic account' } });
});

test('no em dashes anywhere in the fragment (house rule)', () => {
  assert.ok(!JSON.stringify(fragment).includes('\u2014'));
});
