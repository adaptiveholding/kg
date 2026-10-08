#!/usr/bin/env node
// Builds the paste-able n8n fragment for step 2 of the image finder:
//   workflows/step2-extract-watches.json  =  {nodes, connections, pinData}
// from src/prep-post-text.js, src/extract-watches.prompt.txt and src/build-image-queries.js.
// Zero dependencies:  node build.mjs   (or: npm run build)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = new URL('./', import.meta.url);
const OUT = new URL('workflows/step2-extract-watches.json', ROOT);
const read = rel => readFileSync(new URL(rel, ROOT), 'utf8');

export const NAMES = {
  prep: 'Image: prep post text',
  llm: 'Image: extract watches (LLM)',
  model: 'Anthropic: image extract model',
  build: 'Image: build queries',
  sticky: 'Image finder (step 2)',
};

// Node names already used in the Watch Centro workflow; ours must not collide with them.
const WATCH_CENTRO_NAMES = [
  'Webhook: raw digest', 'Normalize input', 'Anthropic: sanitizer model', 'Sanitizer (LLM)',
  'Parse + code checks (sanitizer)', 'Sanitizer passed?', 'Anthropic: writer model', 'Writer (LLM)',
  'Parse writer output', 'Anthropic: reviewer model', 'Reviewer (LLM)', 'Parse review + code checks',
  'Review passed?', 'Render WP blocks', 'WordPress: create draft', 'Respond: draft created',
  'Respond: blocked', 'Notes', 'Not a duplicate?', 'Respond: duplicate', 'Live mode?',
  'Respond: test draft', 'Record run id',
];

// Same credential reference as the three model nodes in Watch Centro.
const ANTHROPIC_CREDENTIALS = { anthropicApi: { id: 'Fy3gBIA4bOXd96pw', name: 'Anthropic account' } };

const PLACEHOLDERS = {
  '{{POST_TITLE}}': '{{ $json.post_title }}',
  '{{POST_TEXT}}': '{{ $json.post_text }}',
};

const STICKY = `## Image finder (step 2): watch search queries

**Input:** the one item from **Render WP blocks** (title, slug, excerpt, content, seo_title, ...).

**Flow:** *prep post text* turns the block HTML into plain text -> *extract watches* (Claude Haiku, thinking off) lists the watches the post discusses -> *build queries* drops marketplaces and watches not in the post (a model it cannot find is kept as brand only), then orders up to 6 image search queries (most specific first, one slot kept for the main brand) and always adds "luxury wristwatch" last.

**Output:** \`{source, post_title, watches[], image_queries[{q, level, brand, model_family, model, reference, prominence, watch_index}], dropped_watches[], dropped_queries, extract_error}\`. \`source\` is the untouched Render WP blocks item.

**Placement:** do NOT put it inline yet (*WordPress: create draft* reads \`$json.title\` etc.). To try it on real runs, add a second link from *Render WP blocks* to *prep post text* and keep these nodes BELOW the main row, so the draft branch runs first. Pasting drops the nodes where you last clicked; the JSON positions only hold for a direct JSON merge. An LLM error never stops the run: you get the generic query and \`extract_error\` is set.`;

function fail(msg) {
  throw new Error(`build.mjs: ${msg}`);
}

export function promptExpression(prompt) {
  let text = prompt.replace(/\r\n/g, '\n').trimEnd();
  for (const [ph, expr] of Object.entries(PLACEHOLDERS)) {
    const n = text.split(ph).length - 1;
    if (n !== 1) fail(`prompt must contain ${ph} exactly once (found ${n})`);
    text = text.replace(ph, expr);
  }
  // Every '{{' opens an n8n expression; only our two may remain. Single braces are plain text.
  const opens = text.split('{{').length - 1;
  if (opens !== Object.keys(PLACEHOLDERS).length) fail(`prompt has a stray "{{" (found ${opens} in total)`);
  if (text.includes('\\')) fail('prompt contains a backslash (n8n expression text would unescape it)');
  return '=' + text;
}

// Compile a Code-node body the way the task runner wraps it, so syntax errors fail the build.
function checkCode(name, code) {
  if (code.startsWith('=')) fail(`${name}: jsCode must not start with "="`);
  try {
    new vm.Script(`(async function VmCodeWrapper() {\n${code}\n})`, { filename: name });
  } catch (e) {
    fail(`${name}: ${e.message}`);
  }
  return code;
}

export function buildFragment() {
  const prepCode = checkCode(NAMES.prep, read('src/prep-post-text.js').trimEnd());
  const buildCode = checkCode(NAMES.build, read('src/build-image-queries.js').trimEnd());
  const text = promptExpression(read('src/extract-watches.prompt.txt'));

  const nodes = [
    {
      id: '47dcc752-78d5-45ac-bb76-8f5d16de1e64',
      name: NAMES.prep,
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [2620, 1040],
      parameters: { mode: 'runOnceForAllItems', jsCode: prepCode },
    },
    {
      id: '5335e1dc-dee9-402e-aab4-79a05fabcfc4',
      name: NAMES.llm,
      type: '@n8n/n8n-nodes-langchain.chainLlm',
      typeVersion: 1.9,
      position: [2840, 1040],
      parameters: { promptType: 'define', text, batching: {} },
      retryOnFail: true,
      maxTries: 2,
      onError: 'continueRegularOutput',
    },
    {
      id: 'bbdff47e-dfd0-4c0c-9ac6-4bcd0f2e06cd',
      name: NAMES.model,
      type: '@n8n/n8n-nodes-langchain.lmChatAnthropic',
      typeVersion: 1.6,
      position: [2840, 1260],
      parameters: {
        model: { __rl: true, mode: 'list', value: 'claude-haiku-5-5', cachedResultName: 'Claude Haiku 5.5' },
        // Haiku 5.5 thinks by default and thinking counts toward max_tokens; this short extraction does not need it.
        options: { maxTokensToSample: 1000, thinkingMode: 'disabled' },
      },
      credentials: ANTHROPIC_CREDENTIALS,
    },
    {
      id: 'f3a427c9-b32c-4500-82a7-3be33759b411',
      name: NAMES.build,
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [3200, 1040],
      parameters: { mode: 'runOnceForAllItems', jsCode: buildCode },
    },
    {
      id: '9c5d6f0e-3b0a-4f43-9d8e-6a3f1b2c7d41',
      name: NAMES.sticky,
      type: 'n8n-nodes-base.stickyNote',
      typeVersion: 1,
      position: [2560, 660],
      parameters: { content: STICKY, height: 340, width: 960 },
    },
  ];

  const connections = {
    [NAMES.prep]: { main: [[{ node: NAMES.llm, type: 'main', index: 0 }]] },
    [NAMES.model]: { ai_languageModel: [[{ node: NAMES.llm, type: 'ai_languageModel', index: 0 }]] },
    [NAMES.llm]: { main: [[{ node: NAMES.build, type: 'main', index: 0 }]] },
  };

  const fragment = { nodes, connections, pinData: {} };
  validate(fragment);
  return fragment;
}

export function validate(fragment) {
  const names = new Set();
  const ids = new Set();
  for (const n of fragment.nodes) {
    if (names.has(n.name)) fail(`duplicate node name ${n.name}`);
    if (ids.has(n.id)) fail(`duplicate node id ${n.id}`);
    if (WATCH_CENTRO_NAMES.includes(n.name)) fail(`node name collides with Watch Centro: ${n.name}`);
    names.add(n.name);
    ids.add(n.id);
  }
  for (const [src, byType] of Object.entries(fragment.connections)) {
    if (!names.has(src)) fail(`connection source not in fragment: ${src}`);
    for (const [type, outputs] of Object.entries(byType)) {
      for (const out of outputs) {
        for (const c of out) {
          if (!names.has(c.node)) fail(`connection target not in fragment: ${src} -> ${c.node}`);
          if (c.type !== type) fail(`connection type mismatch: ${src} -> ${c.node}`);
        }
      }
    }
  }
  const json = JSON.stringify(fragment);
  if (json.includes('\u2014')) fail('em dash found (house rule: none)');
  JSON.parse(json);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const fragment = buildFragment();
  mkdirSync(new URL('workflows/', ROOT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(fragment, null, 2) + '\n');
  const counts = fragment.nodes.map(n => n.name).join(', ');
  console.log(`wrote ${fileURLToPath(OUT)} (${fragment.nodes.length} nodes: ${counts})`);
}
