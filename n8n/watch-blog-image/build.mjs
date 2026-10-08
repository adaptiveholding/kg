#!/usr/bin/env node
// Builds the paste-able n8n fragments of the image finder (n8n paste format {nodes, connections, pinData}):
//   workflows/step2-extract-watches.json  step 2 only (prep post text -> extract watches -> build queries)
//   workflows/step3-search-photos.json    step 3 only (split queries -> search Openverse -> search Commons -> pick photo)
//   workflows/image-finder.json           steps 2 + 3 wired together: THE file to hand over
// from src/*.js and src/extract-watches.prompt.txt.
// Zero dependencies:  node build.mjs   (or: npm run build)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = new URL('./', import.meta.url);
export const OUTPUTS = {
  step2: 'workflows/step2-extract-watches.json',
  step3: 'workflows/step3-search-photos.json',
  cumulative: 'workflows/image-finder.json',
};
const read = rel => readFileSync(new URL(rel, ROOT), 'utf8');

export const NAMES = {
  prep: 'Image: prep post text',
  llm: 'Image: extract watches (LLM)',
  model: 'Anthropic: image extract model',
  build: 'Image: build queries',
  sticky: 'Image finder (step 2)',
  split: 'Image: split queries',
  openverse: 'Image: search Openverse',
  commons: 'Image: search Commons',
  pick: 'Image: pick photo',
  sticky3: 'Image finder (step 3)',
};

// Newest node type versions Watch Centro uses; the fragment must not need anything newer.
const MAX_TYPE_VERSIONS = {
  'n8n-nodes-base.code': 2,
  'n8n-nodes-base.httpRequest': 4.2,
  '@n8n/n8n-nodes-langchain.chainLlm': 1.9,
  '@n8n/n8n-nodes-langchain.lmChatAnthropic': 1.6,
  'n8n-nodes-base.stickyNote': 1,
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

// --- Step 3: search Openverse and Wikimedia Commons, pick one photo per post ----------------------------
// Wikimedia's User-Agent policy wants an app name/version plus contact (URL or e-mail); the edge answers
// 403 to library default agents. Openverse has no UA rule, but a descriptive one is polite.
export const USER_AGENT = 'WatchCentroImageFinder/1.0 (+https://watchcentro.com)';
// Openverse anonymous limits seen in production: 20/minute burst, 200/day. 3500 ms keeps under 20/min.
export const OPENVERSE_INTERVAL_MS = 3500;
// Commons: the edge allows 100 uncached requests per 10 s per contact; one per second is polite.
export const COMMONS_INTERVAL_MS = 1000;
export const HTTP_TIMEOUT_MS = 20000;
// Commons extmetadata fields the pick reads (names are case-sensitive).
export const COMMONS_EXTMETADATA = [
  'LicenseShortName', 'License', 'LicenseUrl', 'UsageTerms', 'AttributionRequired', 'Copyrighted', 'Restrictions',
  'Artist', 'Credit', 'ObjectName', 'ImageDescription', 'Attribution', 'NonFree', 'Categories',
];

const kv = (name, value) => ({ name, value });

const STICKY3 = `## Image finder (step 3): search and pick a photo

**Flow:** *split queries* makes one item per image query -> *search Openverse* (licences CC BY, BY-SA, CC0, PDM only; jpg/png/webp; 20 results; one request every 3.5 s) -> *search Commons* (same query, bitmap files only; one request per second) -> *pick photo* drops anything that is not CC0, public domain, CC BY or CC BY-SA, smaller than 1000 px, the wrong shape or file type, a replica, a logo or off topic, then takes the best photo of the most specific query that has one.

**Output (one item per post):** \`{source, post_title, watches, image_queries, image, image_error, alternates, search_log}\`. \`image\` has file_url, landing_url, licence, creator, alt_text, credit_text, download_filename. When nothing passes, \`image\` is null and \`image_error\` says why. A 429, a timeout or an API error never stops the run; it shows in \`search_log\`.

**Optional, higher Openverse limits:** register a free app (README, "Openverse registration"), click the e-mailed link, then Credentials > Create > **OAuth2 API**: Grant Type *Client Credentials*, Access Token URL \`https://api.openverse.org/v1/auth_tokens/token/\`, Client ID and Secret from the registration, Scope empty, Authentication *Body*. In *search Openverse* set Authentication *Generic Credential Type* > *OAuth2 API* > that credential; the batch interval can then go down to 700 ms.

**Placement:** same as step 2 (not inline yet). Recently chosen photos are remembered in the workflow static data, which n8n does not save for editor test runs.`;

export function buildStep3Fragment() {
  const splitCode = checkCode(NAMES.split, read('src/split-queries.js').trimEnd());
  const pickCode = checkCode(NAMES.pick, read('src/pick-photo.js').trimEnd());
  const robust = { onError: 'continueRegularOutput' }; // a 429 / 5xx / timeout becomes an {error} item, in place
  const nodes = [
    {
      id: '25ffc2ce-b372-408a-8532-9637abae7efc',
      name: NAMES.split,
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [3420, 1040],
      parameters: { mode: 'runOnceForAllItems', jsCode: splitCode },
    },
    {
      id: '8f4a8ba1-5671-41d7-b568-bf0c0c1cdf90',
      name: NAMES.openverse,
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [3640, 1040],
      parameters: {
        url: 'https://api.openverse.org/v1/images/',
        sendQuery: true,
        queryParameters: {
          parameters: [
            kv('q', '={{ $json.q }}'),
            kv('license', 'by,by-sa,cc0,pdm'),
            kv('page_size', '20'),
            // Not "mature": the API reads ANY mature value, "false" included, as "include sensitive results".
            kv('extension', 'jpg,jpeg,png,webp'),
          ],
        },
        sendHeaders: true,
        headerParameters: { parameters: [kv('User-Agent', USER_AGENT), kv('Accept', 'application/json')] },
        options: {
          batching: { batch: { batchSize: 1, batchInterval: OPENVERSE_INTERVAL_MS } },
          timeout: HTTP_TIMEOUT_MS,
        },
      },
      ...robust,
    },
    {
      id: '1effa37b-0711-4a26-9ca7-23cb25ac36a3',
      name: NAMES.commons,
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [3860, 1040],
      parameters: {
        url: 'https://commons.wikimedia.org/w/api.php',
        sendQuery: true,
        queryParameters: {
          parameters: [
            kv('action', 'query'),
            kv('format', 'json'),
            kv('formatversion', '2'),
            kv('generator', 'search'),
            kv('gsrsearch', `={{ $('${NAMES.split}').item.json.q }} filetype:bitmap`),
            kv('gsrnamespace', '6'),
            kv('gsrlimit', '20'),
            kv('prop', 'imageinfo'),
            kv('iiprop', 'url|size|mime|extmetadata'),
            kv('iiurlwidth', '1920'),
            kv('iiextmetadatafilter', COMMONS_EXTMETADATA.join('|')),
            kv('iiextmetadatalanguage', 'en'),
            kv('maxlag', '5'),
          ],
        },
        sendHeaders: true,
        headerParameters: { parameters: [kv('User-Agent', USER_AGENT)] },
        options: {
          batching: { batch: { batchSize: 1, batchInterval: COMMONS_INTERVAL_MS } },
          timeout: HTTP_TIMEOUT_MS,
        },
      },
      ...robust,
    },
    {
      id: '903fcaea-d8e6-434b-a378-425dc098dd6a',
      name: NAMES.pick,
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [4080, 1040],
      parameters: { mode: 'runOnceForAllItems', jsCode: pickCode },
    },
    {
      id: '09607442-b87a-4eca-a63f-1dcff37bc49b',
      name: NAMES.sticky3,
      type: 'n8n-nodes-base.stickyNote',
      typeVersion: 1,
      position: [3560, 660],
      parameters: { content: STICKY3, height: 340, width: 780 },
    },
  ];
  const main = to => ({ main: [[{ node: to, type: 'main', index: 0 }]] });
  const connections = {
    [NAMES.split]: main(NAMES.openverse),
    [NAMES.openverse]: main(NAMES.commons),
    [NAMES.commons]: main(NAMES.pick),
  };
  const fragment = { nodes, connections, pinData: {} };
  validate(fragment, { known: [NAMES.build] });
  return fragment;
}

// Steps 2 + 3 in one paste: build queries -> split queries.
export function buildImageFinder() {
  const s2 = buildFragment();
  const s3 = buildStep3Fragment();
  const fragment = {
    nodes: [...s2.nodes, ...s3.nodes],
    connections: {
      ...s2.connections,
      [NAMES.build]: { main: [[{ node: NAMES.split, type: 'main', index: 0 }]] },
      ...s3.connections,
    },
    pinData: {},
  };
  validate(fragment);
  return fragment;
}

export function buildAll() {
  return {
    [OUTPUTS.step2]: buildFragment(),
    [OUTPUTS.step3]: buildStep3Fragment(),
    [OUTPUTS.cumulative]: buildImageFinder(),
  };
}

// `known`: node names the fragment may reference with $('...') without containing them (step 3 alone
// reads "Image: build queries", which comes with step 2).
export function validate(fragment, { known = [] } = {}) {
  const names = new Set();
  const ids = new Set();
  for (const n of fragment.nodes) {
    if (names.has(n.name)) fail(`duplicate node name ${n.name}`);
    if (ids.has(n.id)) fail(`duplicate node id ${n.id}`);
    if (WATCH_CENTRO_NAMES.includes(n.name)) fail(`node name collides with Watch Centro: ${n.name}`);
    if (!(n.type in MAX_TYPE_VERSIONS)) fail(`unexpected node type ${n.type} (${n.name})`);
    if (n.typeVersion > MAX_TYPE_VERSIONS[n.type]) fail(`${n.name}: typeVersion ${n.typeVersion} is newer than Watch Centro's`);
    names.add(n.name);
    ids.add(n.id);
  }
  // Every literal $('Node name') must name a node of the fragment (or of the step it builds on).
  for (const n of fragment.nodes) {
    for (const m of JSON.stringify(n.parameters).matchAll(/\$\('([^'\\]+)'\)/g)) {
      if (!names.has(m[1]) && !known.includes(m[1])) fail(`${n.name} references unknown node $('${m[1]}')`);
    }
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
  mkdirSync(new URL('workflows/', ROOT), { recursive: true });
  for (const [rel, fragment] of Object.entries(buildAll())) {
    const out = new URL(rel, ROOT);
    writeFileSync(out, JSON.stringify(fragment, null, 2) + '\n');
    const counts = fragment.nodes.map(n => n.name).join(', ');
    console.log(`wrote ${fileURLToPath(out)} (${fragment.nodes.length} nodes: ${counts})`);
  }
}
