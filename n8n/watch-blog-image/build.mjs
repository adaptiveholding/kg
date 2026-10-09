#!/usr/bin/env node
// Builds the paste-able n8n fragments of the image finder (n8n paste format {nodes, connections, pinData}):
//   workflows/step2-extract-watches.json  step 2 only (prep post text -> extract watches -> build queries)
//   workflows/step3-search-photos.json    step 3 only (split queries -> search Openverse -> search Commons -> pick photo)
//   workflows/step4-6-upload-attach.json  steps 4-6 only (licence check -> download -> upload -> alt text -> hand back)
//   workflows/image-finder.json           steps 2-6 wired together: THE file to hand over
// from src/*.js and src/extract-watches.prompt.txt.
// Zero dependencies:  node build.mjs   (or: npm run build)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = new URL('./', import.meta.url);
export const OUTPUTS = {
  step2: 'workflows/step2-extract-watches.json',
  step3: 'workflows/step3-search-photos.json',
  step4: 'workflows/step4-6-upload-attach.json',
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
  plan: 'Image: plan licence check',
  needsLookup: 'Image: needs Commons lookup?',
  lookup: 'Image: look up licence on Commons',
  confirm: 'Image: confirm licence',
  hasPhoto: 'Image: has photo?',
  download: 'Image: download photo',
  photoOk: 'Image: photo OK?',
  upload: 'Image: upload to WordPress',
  uploaded: 'Image: uploaded?',
  alt: 'Image: set alt text and caption',
  handBack: 'Image: hand back post',
  sticky4: 'Image finder (steps 4-6)',
};

// Newest node type versions Watch Centro uses; the fragment must not need anything newer.
const MAX_TYPE_VERSIONS = {
  'n8n-nodes-base.code': 2,
  'n8n-nodes-base.httpRequest': 4.2,
  '@n8n/n8n-nodes-langchain.chainLlm': 1.9,
  '@n8n/n8n-nodes-langchain.lmChatAnthropic': 1.6,
  'n8n-nodes-base.if': 2.2,
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

// Same credential reference as "WordPress: create draft" in Watch Centro.
export const WORDPRESS_CREDENTIALS = { wordpressApi: { id: 'LPEXDGdEBrfFA7NC', name: 'WatchCentro' } };
export const WP_BASE = 'https://watchcentro.com/wp-json/wp/v2';

const PLACEHOLDERS = {
  '{{POST_TITLE}}': '{{ $json.post_title }}',
  '{{POST_TEXT}}': '{{ $json.post_text }}',
};

const STICKY = `## Image finder (step 2): watch search queries

**Input:** the one item from **Render WP blocks** (title, slug, excerpt, content, seo_title, ...).

**Flow:** *prep post text* turns the block HTML into plain text -> *extract watches* (Claude Haiku, thinking off) lists the watches the post discusses -> *build queries* drops marketplaces and watches not in the post (a model it cannot find is kept as brand only), then orders up to 6 image search queries (most specific first, one slot kept for the main brand) and always adds "luxury wristwatch" last.

**Output:** \`{source, post_title, watches[], image_queries[{q, level, brand, model_family, model, reference, prominence, watch_index}], dropped_watches[], dropped_queries, extract_error}\`. \`source\` is the untouched Render WP blocks item.

**Placement:** first node of the image chain, on the LIVE branch only: *Live mode?* (true) -> *prep post text*; the chain ends at *Image: hand back post* -> *WordPress: create draft* (see the steps 4-6 note). Test runs never reach it. An LLM error never stops the run: you get the generic query and \`extract_error\` is set (and step 4 then uses no photo).`;

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

**Flow:** *split queries* makes one item per image query -> *search Openverse* (licences CC BY, BY-SA, CC0, PDM only; 20 results; one request every 3.5 s) -> *search Commons* (same query, bitmap files only; one request per second) -> *pick photo* drops anything that is not CC0, public domain, CC BY or CC BY-SA, smaller than 1000 px, the wrong shape or file type, a replica, a logo, another brand's watch, a non-watch subject, or a copy of a photo the other source rejected, then takes the best photo of the most specific query that has one.

**Output (one item per post):** \`{source, post_title, watches, image_queries, image, image_error, alternates, search_log}\`. \`image\` has file_url, landing_url, licence, creator, alt_text, credit_text, download_filename. When nothing passes, \`image\` is null and \`image_error\` says why. A 429, a timeout or an API error never stops the run; it shows in \`search_log\`.

**Optional, higher Openverse limits:** register a free app (README, "Openverse registration"), click the e-mailed link, then Credentials > Create > **OAuth2 API**: Grant Type *Client Credentials*, Access Token URL \`https://api.openverse.org/v1/auth_tokens/token/\`, Client ID and Secret from the registration, Scope empty, Authentication *Body*. In *search Openverse* set Authentication *Generic Credential Type* > *OAuth2 API* > that credential; the batch interval can then go down to 700 ms.

**Placement:** inside the live-branch image chain (see the steps 4-6 note). Recently used photos (static data \`imageFinder.recent\`) score -40; this node only READS that list, *Image: hand back post* adds a photo once it is attached (\`image.recent_keys\`).`;

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
            // Not "extension": Openverse derives it from the URL's last dot segment, and Wikimedia URLs now end in
            // "?utm_source=commons.wikimedia.org&...", so the filter would drop every recently indexed Commons photo.
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
            // No maxlag: for a few reads a minute it only adds a failure mode (HTTP 200 + error, nothing retries it).
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

// --- Steps 4-6: licence cross-check, download, upload, alt text, hand back --------------------------------
export const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
export const PHOTO_MIMES = ['image/jpeg', 'image/png', 'image/webp'];
export const DOWNLOAD_TIMEOUT_MS = 30000;
export const UPLOAD_TIMEOUT_MS = 60000;
export const ALT_TIMEOUT_MS = 30000;

// IF 2.2 in Watch Centro's style (strict validation, one boolean condition). Output 0 = true, 1 = false.
const ifNode = (id, name, position, leftValue) => ({
  id, name, type: 'n8n-nodes-base.if', typeVersion: 2.2, position,
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [{ id: name, leftValue, rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }],
      combinator: 'and',
    },
    options: {},
  },
});

const STICKY4 = `## Image finder (steps 4-6): check, upload, attach

**Live branch only.** Wire *Live mode?* (true) -> *Image: prep post text*, and *Image: hand back post* -> *WordPress: create draft* (README, "Integration").

**Flow:** *plan licence check* lists the Commons page ids of Wikimedia-sourced Openverse picks that this run's Commons search did not already return -> *needs Commons lookup?* -> *look up licence on Commons* (one imageinfo request) -> *confirm licence* re-applies the step 3 licence rules (else the next alternate, else no image) -> *has photo?* -> *download photo* -> *photo OK?* (JPEG/PNG/WebP, at most 15 MB) -> *upload to WordPress* (raw body, credential WatchCentro) -> *uploaded?* -> *set alt text and caption* -> *hand back post*.

**Output of hand back post:** the untouched *Render WP blocks* item plus \`image_report\`; with a photo also \`featured_media\` and a small credit paragraph at the end of \`content\`. Every failure (LLM, search, licence, download, upload) ends here with \`image_report.status\` no_image or failed, and the draft is still created. A failed alt text update keeps the featured image.

**Create draft:** add \`featured_media: $json.featured_media,\` to its JSON body (undefined is dropped).`;

export function buildStep4Fragment() {
  const planCode = checkCode(NAMES.plan, read('src/plan-licence-check.js').trimEnd());
  const confirmCode = checkCode(NAMES.confirm, read('src/confirm-licence.js').trimEnd());
  const handCode = checkCode(NAMES.handBack, read('src/hand-back-post.js').trimEnd());
  const robust = { onError: 'continueRegularOutput' };
  const y = 1040;
  const nodes = [
    {
      id: '0b1c7e52-5a3d-4c8e-9f21-6d4a8b3e1f01', name: NAMES.plan, type: 'n8n-nodes-base.code', typeVersion: 2,
      position: [4300, y], parameters: { mode: 'runOnceForAllItems', jsCode: planCode },
    },
    ifNode('0b1c7e52-5a3d-4c8e-9f21-6d4a8b3e1f02', NAMES.needsLookup, [4520, y],
      '={{ Array.isArray($json.licence_check && $json.licence_check.lookup_pageids) && $json.licence_check.lookup_pageids.length > 0 }}'),
    {
      id: '0b1c7e52-5a3d-4c8e-9f21-6d4a8b3e1f03', name: NAMES.lookup, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
      position: [4740, y - 160],
      parameters: {
        url: 'https://commons.wikimedia.org/w/api.php',
        sendQuery: true,
        queryParameters: {
          parameters: [
            kv('action', 'query'),
            kv('format', 'json'),
            kv('formatversion', '2'),
            kv('pageids', "={{ $json.licence_check.lookup_pageids.slice(0, 50).join('|') }}"),
            kv('prop', 'imageinfo'),
            kv('iiprop', 'url|size|mime|extmetadata'),
            kv('iiextmetadatafilter', COMMONS_EXTMETADATA.join('|')),
            kv('iiextmetadatalanguage', 'en'),
          ],
        },
        sendHeaders: true,
        headerParameters: { parameters: [kv('User-Agent', USER_AGENT)] },
        options: { timeout: HTTP_TIMEOUT_MS },
      },
      ...robust,
    },
    {
      id: '0b1c7e52-5a3d-4c8e-9f21-6d4a8b3e1f04', name: NAMES.confirm, type: 'n8n-nodes-base.code', typeVersion: 2,
      position: [4960, y], parameters: { mode: 'runOnceForAllItems', jsCode: confirmCode },
    },
    ifNode('0b1c7e52-5a3d-4c8e-9f21-6d4a8b3e1f05', NAMES.hasPhoto, [5180, y],
      '={{ !!($json.image && $json.image.file_url && $json.image.download_filename) }}'),
    {
      id: '0b1c7e52-5a3d-4c8e-9f21-6d4a8b3e1f06', name: NAMES.download, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
      position: [5400, y - 160],
      parameters: {
        url: '={{ $json.image.file_url }}',
        sendHeaders: true,
        headerParameters: { parameters: [kv('User-Agent', USER_AGENT)] },
        // fullResponse stays off: the output item then keeps the input json next to binary.photo.
        options: { response: { response: { responseFormat: 'file', outputPropertyName: 'photo' } }, timeout: DOWNLOAD_TIMEOUT_MS },
      },
      ...robust,
    },
    ifNode('0b1c7e52-5a3d-4c8e-9f21-6d4a8b3e1f07', NAMES.photoOk, [5620, y - 160],
      `={{ !!($binary.photo && ${JSON.stringify(PHOTO_MIMES).replace(/"/g, "'")}.includes(String($binary.photo.mimeType || '').split(';')[0].trim().toLowerCase()) && Number($binary.photo.bytes) > 0 && Number($binary.photo.bytes) <= ${MAX_PHOTO_BYTES}) }}`),
    {
      id: '0b1c7e52-5a3d-4c8e-9f21-6d4a8b3e1f08', name: NAMES.upload, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
      position: [5840, y - 320],
      parameters: {
        method: 'POST',
        url: `${WP_BASE}/media`,
        authentication: 'predefinedCredentialType',
        nodeCredentialType: 'wordpressApi',
        sendHeaders: true,
        headerParameters: {
          parameters: [
            kv('Content-Type', '={{ $binary.photo.mimeType }}'),
            kv('Content-Disposition', '=attachment; filename="{{ $json.image.download_filename }}"'),
          ],
        },
        sendBody: true,
        contentType: 'binaryData',
        inputDataFieldName: 'photo',
        options: { timeout: UPLOAD_TIMEOUT_MS },
      },
      credentials: WORDPRESS_CREDENTIALS,
      ...robust,
    },
    ifNode('0b1c7e52-5a3d-4c8e-9f21-6d4a8b3e1f09', NAMES.uploaded, [6060, y - 320],
      "={{ typeof $json.id === 'number' && $json.id > 0 }}"),
    {
      id: '0b1c7e52-5a3d-4c8e-9f21-6d4a8b3e1f0a', name: NAMES.alt, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
      position: [6280, y - 480],
      parameters: {
        method: 'POST',
        url: `=${WP_BASE}/media/{{ $json.id }}`,
        authentication: 'predefinedCredentialType',
        nodeCredentialType: 'wordpressApi',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: `={{ JSON.stringify($('${NAMES.confirm}').item.json.media_update) }}`,
        options: { timeout: ALT_TIMEOUT_MS },
      },
      credentials: WORDPRESS_CREDENTIALS,
      ...robust,
    },
    {
      id: '0b1c7e52-5a3d-4c8e-9f21-6d4a8b3e1f0b', name: NAMES.handBack, type: 'n8n-nodes-base.code', typeVersion: 2,
      position: [6500, y], parameters: { mode: 'runOnceForAllItems', jsCode: handCode },
    },
    {
      id: '0b1c7e52-5a3d-4c8e-9f21-6d4a8b3e1f0c', name: NAMES.sticky4, type: 'n8n-nodes-base.stickyNote', typeVersion: 1,
      position: [4300, 1260], parameters: { content: STICKY4, height: 420, width: 1100 },
    },
  ];
  const link = to => ({ node: to, type: 'main', index: 0 });
  const connections = {
    [NAMES.plan]: { main: [[link(NAMES.needsLookup)]] },
    [NAMES.needsLookup]: { main: [[link(NAMES.lookup)], [link(NAMES.confirm)]] },
    [NAMES.lookup]: { main: [[link(NAMES.confirm)]] },
    [NAMES.confirm]: { main: [[link(NAMES.hasPhoto)]] },
    [NAMES.hasPhoto]: { main: [[link(NAMES.download)], [link(NAMES.handBack)]] },
    [NAMES.download]: { main: [[link(NAMES.photoOk)]] },
    [NAMES.photoOk]: { main: [[link(NAMES.upload)], [link(NAMES.handBack)]] },
    [NAMES.upload]: { main: [[link(NAMES.uploaded)]] },
    [NAMES.uploaded]: { main: [[link(NAMES.alt)], [link(NAMES.handBack)]] },
    [NAMES.alt]: { main: [[link(NAMES.handBack)]] },
  };
  const fragment = { nodes, connections, pinData: {} };
  validate(fragment, { known: [NAMES.build, NAMES.commons, NAMES.pick] });
  return fragment;
}

// The one change to an existing Watch Centro node: "WordPress: create draft" also sends featured_media.
// When hand back post sets no featured_media, the value is undefined and JSON.stringify leaves the key out.
export const CREATE_DRAFT_PATCH = {
  before: '  excerpt: $json.excerpt,\n',
  after: '  excerpt: $json.excerpt,\n  featured_media: $json.featured_media,\n',
};
// A patched COPY of the create-draft node (throws when the node does not have the expected line exactly once).
export function patchCreateDraft(node) {
  const copy = JSON.parse(JSON.stringify(node));
  const body = copy && copy.parameters && copy.parameters.jsonBody;
  if (typeof body !== 'string') fail('create draft node has no jsonBody');
  if (body.includes('featured_media')) fail('create draft jsonBody already has featured_media');
  if (body.split(CREATE_DRAFT_PATCH.before).length !== 2) fail('create draft jsonBody: expected the excerpt line exactly once');
  copy.parameters.jsonBody = body.replace(CREATE_DRAFT_PATCH.before, CREATE_DRAFT_PATCH.after);
  return copy;
}

// Steps 2-6 in one paste: build queries -> split queries, pick photo -> plan licence check.
// Entry "Image: prep post text", exit "Image: hand back post".
export function buildImageFinder() {
  const s2 = buildFragment();
  const s3 = buildStep3Fragment();
  const s4 = buildStep4Fragment();
  const fragment = {
    nodes: [...s2.nodes, ...s3.nodes, ...s4.nodes],
    connections: {
      ...s2.connections,
      [NAMES.build]: { main: [[{ node: NAMES.split, type: 'main', index: 0 }]] },
      ...s3.connections,
      [NAMES.pick]: { main: [[{ node: NAMES.plan, type: 'main', index: 0 }]] },
      ...s4.connections,
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
    [OUTPUTS.step4]: buildStep4Fragment(),
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
