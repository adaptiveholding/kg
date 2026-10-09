// Steps 2 + 3 end to end, in a REAL local n8n 2.x: the cumulative fragment workflows/image-finder.json,
// verbatim except that the harness points its two HTTP Request nodes at mock-openverse.mjs and
// mock-commons.mjs (base URLs rewritten in a copy before import) and the Anthropic credential at
// mock-anthropic.mjs.
//   N8N_BIN=/abs/path/n8n.sh E2E_N8N_HOME=/abs/scratch/n8n-e2e-home node --test test/e2e/step3.e2e.mjs
// Skipped when N8N_BIN is unset. One n8n execution per case; each takes about 10 to 25 s.
//
// Test workflow:
//   E2E: manual trigger
//   -> Parse + code checks (sanitizer)   fixture: {sanitized: {data_window}}, read by the Render code via $()
//   -> Fixture: writer output             fixture: the "Parse review + code checks" item {ok, stage, post, ...}
//   -> Fixture: Render WP blocks          the REAL Watch Centro "Render WP blocks" jsCode, verbatim
//   -> the 10 nodes of workflows/image-finder.json (prep -> LLM -> build -> split -> Openverse -> Commons -> pick)
//   -> E2E: check pairing                 runOnceForEachItem: $('Fixture: Render WP blocks').item from each pick item
//
// Batching: cases (a) and (h) keep the fragment's real intervals (Openverse 3500 ms, Commons 1000 ms) and
// check the spacing the mocks saw; the other cases shrink both intervals in their copy to keep the suite fast.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWorkflow } from './run-workflow.mjs';
import { WRITER_POSTS } from '../fixtures/writer-posts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FRAGMENT_FILE = path.join(ROOT, 'workflows/image-finder.json');
const RENDERED = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/rendered-posts.json'), 'utf8'));
const RENDER_FILE = fs.readFileSync(path.join(ROOT, 'test/fixtures/render-wp-blocks.js'), 'utf8');
const RENDER_CODE = RENDER_FILE.slice(RENDER_FILE.indexOf('\n') + 1).trimEnd();
const CM_SUB = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/commons/search-rolex-submariner.json'), 'utf8'));

const PREP = 'Image: prep post text';
const BUILD = 'Image: build queries';
const SPLIT = 'Image: split queries';
const OPENVERSE = 'Image: search Openverse';
const COMMONS = 'Image: search Commons';
const PICK = 'Image: pick photo';
const RENDER = 'Fixture: Render WP blocks';
const CHECK = 'E2E: check pairing';
const UA = 'WatchCentroImageFinder/1.0 (+https://watchcentro.com)';
const QUERIES = ['Rolex Submariner Date', 'Rolex Submariner', 'Rolex watch', 'luxury wristwatch'];
const EXTMETA = 'LicenseShortName|License|LicenseUrl|UsageTerms|AttributionRequired|Copyrighted|Restrictions|Artist|Credit|ObjectName|ImageDescription|Attribution|NonFree|Categories';
const OUT_KEYS = ['source', 'post_title', 'watches', 'image_queries', 'image', 'image_error', 'alternates', 'search_log'];
const IMAGE_KEYS = [
  'provider', 'source_name', 'id', 'title', 'creator', 'creator_url', 'license', 'license_version', 'license_name',
  'license_url', 'landing_url', 'file_url', 'width', 'height', 'extension', 'mime', 'attribution_required', 'query',
  'score', 'reasons', 'alt_text', 'credit_text', 'download_filename', 'recent_keys',
];
const skip = !process.env.N8N_BIN && 'N8N_BIN not set (see README, "End-to-end tests")';

// The LLM answer for the "steel" post: one watch -> 4 queries (model, family, brand, generic).
const SUB = { brand: 'Rolex', model_family: 'Submariner', model: 'Submariner Date', reference: '126610LN', mentioned_as: 'Rolex Submariner Date 126610LN', prominence: 'primary' };
const STEEL = WRITER_POSTS.steel.post.title;
const ANTHROPIC = {
  [STEEL]: { json: { watches: [SUB] } },
  [WRITER_POSTS.dress.post.title]: { json: { watches: [] } },
  __default__: { status: 400, message: 'E2E: prompt did not contain an expected post title' },
};
// Openverse fixtures for the four queries when everything works (case a).
const OV_OK = {
  'Rolex Submariner Date': 'search-rolex-submariner-date.json',
  'Rolex Submariner': 'search-rolex-submariner.json',
  'Rolex watch': 'search-rolex-watch-nothing-usable.json',
  'luxury wristwatch': 'search-luxury-wristwatch.json',
};

const wordCount = p => [p.summary, p.takeaway, p.closing, ...(p.sections || []).flatMap(s => s.paragraphs || [])]
  .join(' ').split(/\s+/).filter(Boolean).length;
const code = (id, name, x, jsCode, extra = {}) => ({
  id, name, type: 'n8n-nodes-base.code', typeVersion: 2, position: [x, 1400], parameters: { jsCode, ...extra },
});

// renderMode 'real': the Watch Centro Render code on the steel post. 'two': a fixture node emitting two
// rendered posts (steel and dress), to run two posts through one execution.
function testWorkflow({ renderMode = 'real', intervals } = {}) {
  const fragment = JSON.parse(fs.readFileSync(FRAGMENT_FILE, 'utf8'));
  if (intervals) {
    for (const n of fragment.nodes) {
      if (n.name === OPENVERSE) n.parameters.options.batching.batch.batchInterval = intervals[0];
      if (n.name === COMMONS) n.parameters.options.batching.batch.batchInterval = intervals[1];
    }
  }
  const { post, data_window } = WRITER_POSTS.steel;
  const reviewItem = { ok: true, stage: 'reviewer', reason: '', post, word_count: wordCount(post), run_date: '2026-10-07' };
  const render = renderMode === 'real'
    ? code('e2e3a000-0000-4000-8000-000000000004', RENDER, 2440, RENDER_CODE)
    : code('e2e3a000-0000-4000-8000-000000000004', RENDER, 2440,
      `return ${JSON.stringify([RENDERED.steel, RENDERED.dress].map(json => ({ json })))};`);
  return {
    name: 'E2E step 3 (image finder)',
    nodes: [
      { id: 'e2e3a000-0000-4000-8000-000000000001', name: 'E2E: manual trigger', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [1960, 1400], parameters: {} },
      code('e2e3a000-0000-4000-8000-000000000002', 'Parse + code checks (sanitizer)', 2120,
        `return [{ json: ${JSON.stringify({ ok: true, sanitized: { data_window } })} }];`),
      code('e2e3a000-0000-4000-8000-000000000003', 'Fixture: writer output', 2280, `return [{ json: ${JSON.stringify(reviewItem)} }];`),
      render,
      ...fragment.nodes,
      // What a step 4/5 node will do: reach the post through pairedItem from each pick item.
      code('e2e3a000-0000-4000-8000-000000000005', CHECK, 4300,
        `return { json: { pick_title: $json.post_title, render_title: $('${RENDER}').item.json.title, has_image: $json.image !== null } };`,
        { mode: 'runOnceForEachItem' }),
    ],
    connections: {
      'E2E: manual trigger': { main: [[{ node: 'Parse + code checks (sanitizer)', type: 'main', index: 0 }]] },
      'Parse + code checks (sanitizer)': { main: [[{ node: 'Fixture: writer output', type: 'main', index: 0 }]] },
      'Fixture: writer output': { main: [[{ node: RENDER, type: 'main', index: 0 }]] },
      [RENDER]: { main: [[{ node: PREP, type: 'main', index: 0 }]] },
      ...fragment.connections,
      [PICK]: { main: [[{ node: CHECK, type: 'main', index: 0 }]] },
    },
    settings: { executionOrder: 'v1', binaryMode: 'separate' },
  };
}

// Every pick item obeys the output contract.
function assertContract(o) {
  assert.deepEqual(Object.keys(o), OUT_KEYS);
  assert.ok(!JSON.stringify(o).includes('\u2014'), 'no em dash');
  assert.equal(typeof o.image_error, 'string');
  assert.equal(o.image === null, o.image_error !== '', 'image_error is set exactly when there is no image');
  assert.ok(o.alternates.length <= 3);
  for (const img of [o.image, ...o.alternates].filter(Boolean)) {
    assert.deepEqual(Object.keys(img), IMAGE_KEYS);
    assert.ok(['cc0', 'pdm', 'by', 'by-sa'].includes(img.license), img.license);
    assert.doesNotMatch(img.credit_text, /https?:|www\.|\u2014/);
    assert.match(img.download_filename, /^[a-z0-9-]+-(openverse|commons)-[a-z0-9]+\.(jpg|png|webp)$/);
    assert.ok(img.download_filename.length <= 80);
    assert.ok(img.width >= 1000 || img.width === null);
  }
  for (const e of o.search_log) {
    assert.ok(['ok', 'error', 'skipped'].includes(e.status));
    assert.ok(!/stack|\/home\/|node_modules/.test(JSON.stringify(e)), 'no stack traces or local paths');
  }
}

async function runCase(caseName, { openverse, commons, staticData = { global: {} }, renderMode, intervals = [300, 100] }) {
  const r = await runWorkflow({
    workflow: testWorkflow({ renderMode, intervals }),
    fixtures: ANTHROPIC,
    mocks: { openverse: { fixtures: openverse }, commons: { fixtures: commons } },
    staticData,
    readStaticData: true,
  });
  fs.writeFileSync(path.join(path.dirname(r.logs.n8n), `step3-${caseName}.result.json`), JSON.stringify(r, null, 2));
  assert.equal(r.ok, true, `workflow failed: ${JSON.stringify(r.error)}; see ${r.logs.n8n}`);
  for (const name of [RENDER, PREP, BUILD, SPLIT, OPENVERSE, COMMONS, PICK, CHECK]) assert.ok(r.nodes[name], `node did not run: ${name}`);
  for (const name of [OPENVERSE, COMMONS, PICK]) assert.equal(r.nodes[name][0].status, 'success', name);
  const posts = r.nodes[BUILD][0].items;
  const splits = r.nodes[SPLIT][0].items;
  // One HTTP item per query, on both search nodes, whatever the responses were.
  assert.equal(r.nodes[OPENVERSE][0].items.length, splits.length);
  assert.equal(r.nodes[COMMONS][0].items.length, splits.length);
  const pickRun = r.nodes[PICK][0];
  assert.equal(pickRun.items.length, posts.length, 'one pick item per post');
  pickRun.items.forEach(assertContract);
  // pairedItem leads every pick item back to its own post.
  const check = r.nodes[CHECK][0].items;
  assert.equal(check.length, posts.length);
  for (const c of check) assert.equal(c.pick_title, c.render_title);
  return {
    r, posts, splits, out: pickRun.items, pickOut: pickRun.outputs.main[0],
    ov: r.mocks.openverse.requests.filter(q => q.pathname === '/v1/images/'),
    cm: r.mocks.commons.requests.filter(q => q.pathname === '/w/api.php'),
  };
}

// What the APIs received: exact query parameters and headers.
function assertOpenverseRequests(ov, queries) {
  assert.deepEqual(ov.map(q => q.query.q), queries);
  for (const q of ov) {
    assert.equal(q.method, 'GET');
    assert.deepEqual(q.query, { q: q.query.q, license: 'by,by-sa,cc0,pdm', page_size: '20' }, 'no "mature", no "extension"');
    assert.equal(q.headers['user-agent'], UA);
    assert.equal(q.headers.accept, 'application/json');
    assert.equal(q.headers.authorization, undefined);
    assert.equal(q.sensitive_included, false, 'no "mature" param: the sensitive filter stays on');
  }
}
function assertCommonsRequests(cm, queries) {
  assert.deepEqual(cm.map(q => q.query.gsrsearch), queries.map(q => `${q} filetype:bitmap`));
  for (const q of cm) {
    assert.equal(q.method, 'GET');
    assert.deepEqual(q.query, {
      action: 'query', format: 'json', formatversion: '2', generator: 'search', gsrsearch: q.query.gsrsearch,
      gsrnamespace: '6', gsrlimit: '20', prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: '1920',
      iiextmetadatafilter: EXTMETA, iiextmetadatalanguage: 'en',
    }, 'no maxlag');
    assert.equal(q.headers['user-agent'], UA, 'Wikimedia UA policy: app name/version + contact');
  }
}
const logOf = o => o.search_log.map(e => [e.rank, e.provider, e.status, e.http_error ?? '', e.results, e.passed]);
const ids = o => [o.image, ...o.alternates].filter(Boolean).map(a => `${a.provider}:${a.id}`);
const startGaps = reqs => reqs.slice(1).map((q, i) => q.t_ms - reqs[i].t_ms);

test('(a) Openverse hit at model level; real batching intervals; static data is left untouched', { skip, timeout: 300000 }, async () => {
  const { r, out, pickOut, ov, cm, posts } = await runCase('a-openverse-model', {
    openverse: OV_OK, commons: { 'Rolex Submariner': 'search-rolex-submariner.json' },
    staticData: { global: { liveRunIds: { 'run-e2e-1': '2026-10-01T00:00:00.000Z' } } },
    intervals: null,
  });
  assert.deepEqual(posts[0].image_queries.map(q => q.q), QUERIES);
  assertOpenverseRequests(ov, QUERIES);
  assertCommonsRequests(cm, QUERIES);
  // 20/min anonymous Openverse limit: requests start 3.5 s apart; Commons 1 s apart.
  for (const g of startGaps(ov)) assert.ok(g >= 3300, `Openverse requests ${g} ms apart`);
  for (const g of startGaps(cm)) assert.ok(g >= 900, `Commons requests ${g} ms apart`);

  const [o] = out;
  assert.equal(o.image_error, '');
  assert.deepEqual(o.image, {
    provider: 'openverse', source_name: 'Wikimedia Commons', id: 'ed296e8f-1cb3-5e22-825d-ddbd552c338c',
    title: 'Rolex Submariner Date 126610LN', creator: 'Horologium42', creator_url: 'https://commons.wikimedia.org/wiki/User:Horologium42',
    license: 'by-sa', license_version: '4.0', license_name: 'CC BY-SA 4.0', license_url: 'https://creativecommons.org/licenses/by-sa/4.0/',
    landing_url: 'https://commons.wikimedia.org/w/index.php?curid=148213907',
    file_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4c/Rolex_Submariner_Date_126610LN.jpg/1920px-Rolex_Submariner_Date_126610LN.jpg',
    width: 1920, height: 1440, extension: 'jpg', mime: 'image/jpeg', attribution_required: true,
    query: { rank: 0, q: 'Rolex Submariner Date', level: 'model', watch_index: 0 },
    score: 53, reasons: ['+20 model tokens present', '+15 reference 126610LN', '+10 width >= 1600', '+5 landscape', '+3 openverse'],
    alt_text: 'Rolex Submariner Date watch',
    credit_text: 'Photo: "Rolex Submariner Date 126610LN" by Horologium42, CC BY-SA 4.0, via Wikimedia Commons',
    download_filename: 'rolex-submariner-date-watch-openverse-ed296e8f1cb3.jpg',
    recent_keys: ['commons:148213907', 'file:upload.wikimedia.org/wikipedia/commons/4/4c/rolex_submariner_date_126610ln.jpg', 'openverse:ed296e8f-1cb3-5e22-825d-ddbd552c338c'],
  });
  assert.deepEqual(ids(o).slice(1), [
    'openverse:d3e4d1e1-c069-5080-b265-b206da47bdea', 'openverse:149d8686-eb6f-51c9-a31f-86efb87a8d42', 'commons:34418877',
  ]);
  // The mock applied the real API's sensitive filter (no "mature" param): the mature row of "Rolex Submariner" is gone.
  // No "extension" filter: the svg row arrives and the pick rejects it.
  const sub = ov.find(q => q.query.q === 'Rolex Submariner');
  assert.equal(sub.extension_removed, undefined);
  assert.equal(sub.sensitive_removed, 1);
  assert.deepEqual(logOf(o), [
    [0, 'openverse', 'ok', '', 4, 4], [0, 'commons', 'ok', '', 0, 0],
    [1, 'openverse', 'ok', '', 13, 8], [1, 'commons', 'ok', '', 11, 6],
    [2, 'openverse', 'ok', '', 8, 0], [2, 'commons', 'ok', '', 0, 0],
    [3, 'openverse', 'ok', '', 5, 3], [3, 'commons', 'ok', '', 0, 0],
  ]);
  // The post is passed through untouched.
  assert.deepEqual(o.source, RENDERED.steel);
  assert.equal(o.post_title, RENDERED.steel.title);
  assert.deepEqual(o.watches, posts[0].watches);
  assert.deepEqual(o.image_queries, posts[0].image_queries);
  // pairedItem: every Commons item of the post (n8n resolves them all to the same post upstream).
  assert.deepEqual(pickOut[0].pairedItem, [{ item: 0 }, { item: 1 }, { item: 2 }, { item: 3 }]);
  // Static data: the pick only reads it (review fix). n8n saves the whole object at the end of a non-editor run when
  // anything changed, which could overwrite an overlapping live run's liveRunIds; step 5 records used photos instead.
  assert.deepEqual(r.staticData.global, { liveRunIds: { 'run-e2e-1': '2026-10-01T00:00:00.000Z' } });
});

test('(b) Openverse answers 429 to every request: Commons wins, search_log shows the 429s', { skip, timeout: 300000 }, async () => {
  const { out, ov, cm } = await runCase('b-openverse-429', {
    openverse: { __default__: { status: 429 } },
    commons: { 'Rolex Submariner': 'search-rolex-submariner.json' },
  });
  assertOpenverseRequests(ov, QUERIES);
  assertCommonsRequests(cm, QUERIES);
  assert.ok(ov.every(q => q.response.status === 429));
  const [o] = out;
  assert.deepEqual(o.search_log.filter(e => e.provider === 'openverse'),
    QUERIES.map((q, rank) => ({ rank, q, provider: 'openverse', status: 'error', http_error: 'HTTP 429', results: 0, passed: 0 })));
  assert.equal(o.image.provider, 'commons');
  assert.equal(o.image.id, '148213907');
  assert.deepEqual(o.image.query, { rank: 1, q: 'Rolex Submariner', level: 'family', watch_index: 0 });
  const page = CM_SUB.query.pages.find(p => p.pageid === 148213907);
  assert.equal(o.image.file_url, page.imageinfo[0].thumburl, 'the API 1920 px thumbnail');
  assert.equal(o.image.landing_url, 'https://commons.wikimedia.org/wiki/File:Rolex_Submariner_Date_126610LN.jpg');
  assert.deepEqual([o.image.width, o.image.height, o.image.score], [1920, 1440, 50]);
  assert.equal(o.image.credit_text, 'Photo: "Rolex Submariner Date 126610LN" by Horologium42, CC BY-SA 4.0, via Wikimedia Commons');
  assert.ok(o.alternates.every(a => a.provider === 'commons'));
});

test('(c) only the generic query finds a usable photo: generic pick with generic alt text', { skip, timeout: 300000 }, async () => {
  const { out, ov } = await runCase('c-generic-only', {
    openverse: { 'luxury wristwatch': 'search-luxury-wristwatch.json', __default__: 'search-rolex-watch-nothing-usable.json' },
    commons: {},
  });
  assertOpenverseRequests(ov, QUERIES);
  const [o] = out;
  assert.equal(o.image.id, '257ee03a-0c40-53ee-9ade-d0df7abffb89');
  assert.deepEqual(o.image.query, { rank: 3, q: 'luxury wristwatch', level: 'generic', watch_index: -1 });
  assert.equal(o.image.alt_text, 'Luxury wristwatch');
  assert.equal(o.image.credit_text, 'Photo: "Luxury wristwatch" by Open Watch Photos (CC0 1.0), via Flickr');
  assert.equal(o.image.attribution_required, false);
  assert.ok(o.search_log.filter(e => e.rank < 3).every(e => e.status === 'ok' && e.passed === 0));
});

test('(d) nothing passes anywhere (NC/ND, too small, svg/tif, logo, replica): image null with the reason', { skip, timeout: 300000 }, async () => {
  const { r, out, cm } = await runCase('d-nothing-passes', {
    openverse: { __default__: 'search-rolex-watch-nothing-usable.json' },
    commons: { __default__: 'search-nothing-usable.json' },
  });
  assertCommonsRequests(cm, QUERIES);
  const [o] = out;
  assert.equal(o.image, null);
  assert.deepEqual(o.alternates, []);
  assert.equal(o.image_error, 'no licence-safe relevant photo found for 4 queries; ' +
    'openverse: 32 results in 4 searches, 0 passed (excluded term 8, too small 8, file type 8, not a photo 4, aspect 4); ' +
    'commons: 48 results in 4 searches, 0 passed (licence 20, excluded term 8, too small 4, aspect 4, file type 4)');
  assert.ok(o.search_log.every(e => e.status === 'ok' && e.passed === 0));
  // The run completes and static data is untouched.
  assert.equal(r.nodes[CHECK][0].items[0].has_image, false);
  assert.deepEqual(r.staticData.global, {});
});

test('(e) the same photo from both providers is kept once', { skip, timeout: 300000 }, async () => {
  const { out, cm } = await runCase('e-dedupe', {
    openverse: { 'Rolex Submariner Date': 'search-rolex-submariner-date.json' },
    commons: { 'Rolex Submariner Date': 'search-rolex-submariner.json' },
  });
  // Commons really returned the copies (148213907 = Openverse ed296e8f, 150337412 = d3e4d1e1, 118904562 = 149d8686).
  const served = cm.find(q => q.query.gsrsearch === 'Rolex Submariner Date filetype:bitmap');
  assert.equal(served.response.status, 200);
  assert.equal(served.response.fixture, 'search-rolex-submariner.json');
  const [o] = out;
  assert.deepEqual(ids(o), [
    'openverse:ed296e8f-1cb3-5e22-825d-ddbd552c338c', 'openverse:d3e4d1e1-c069-5080-b265-b206da47bdea',
    'commons:34418877', 'openverse:149d8686-eb6f-51c9-a31f-86efb87a8d42',
  ]);
  for (const id of ['commons:148213907', 'commons:150337412', 'commons:118904562', 'openverse:a765171e-3b3a-5da9-9e17-ebaae6a89b6f']) {
    assert.ok(!ids(o).includes(id), `${id} is a duplicate and must not be listed`);
  }
  assert.deepEqual(o.search_log.slice(0, 2).map(e => [e.provider, e.results, e.passed]), [['openverse', 4, 4], ['commons', 11, 6]]);
});

test('(f) Commons pages in database order: "index" decides; Commons API and HTTP errors are logged, not fatal', { skip, timeout: 300000 }, async () => {
  // The recorded page array is already out of index order ([5, 10, 3, 11, 1, 2, ...]), but the two
  // equal-score pages (148213907 index 1, 150337412 index 2) happen to sit in index order. Reverse the
  // array (indexes unchanged) so array position and relevance disagree for them as well.
  const reversed = { ...CM_SUB, query: { ...CM_SUB.query, pages: [...CM_SUB.query.pages].reverse() } };
  const pos = id => reversed.query.pages.findIndex(p => p.pageid === id);
  const idx = id => reversed.query.pages.find(p => p.pageid === id).index;
  assert.ok(pos(150337412) < pos(148213907) && idx(148213907) < idx(150337412));
  const { out, cm } = await runCase('f-commons-index', {
    openverse: {},
    commons: { 'Rolex Submariner Date': { json: reversed }, 'Rolex watch': 'error-generic.json', 'luxury wristwatch': { status: 503 } },
  });
  assert.deepEqual(cm.map(q => q.response.status), [200, 200, 200, 503]);
  const [o] = out;
  // Same ranking as the recorded order gives (unit test "(f)"): 148213907 wins the tie on index.
  assert.deepEqual([o.image, ...o.alternates].map(a => [a.id, a.score]), [['148213907', 50], ['150337412', 50], ['34418877', 35], ['118904562', 25]]);
  assert.equal(o.image.query.rank, 0);
  assert.deepEqual(logOf(o), [
    [0, 'openverse', 'ok', '', 0, 0], [0, 'commons', 'ok', '', 11, 6],
    [1, 'openverse', 'ok', '', 0, 0], [1, 'commons', 'ok', '', 0, 0],
    [2, 'openverse', 'ok', '', 0, 0], [2, 'commons', 'error', 'API cirrussearch-backend-error', 0, 0],
    [3, 'openverse', 'ok', '', 0, 0], [3, 'commons', 'error', 'HTTP 503', 0, 0],
  ]);
});

test('(g) two posts in one execution: one pick item each, paired to its own post', { skip, timeout: 300000 }, async () => {
  const { r, out, splits, ov } = await runCase('g-two-posts', {
    renderMode: 'two', openverse: OV_OK, commons: { 'Rolex Submariner': 'search-rolex-submariner.json' },
  });
  assert.deepEqual(splits.map(s => [s.post_index, s.rank, s.q]), [...QUERIES.map((q, i) => [0, i, q]), [1, 0, 'luxury wristwatch']]);
  assertOpenverseRequests(ov, [...QUERIES, 'luxury wristwatch']);
  assert.deepEqual(out.map(o => o.post_title), [RENDERED.steel.title, RENDERED.dress.title]);
  assert.equal(out[0].image.id, 'ed296e8f-1cb3-5e22-825d-ddbd552c338c');
  assert.equal(out[1].image.id, '257ee03a-0c40-53ee-9ade-d0df7abffb89');
  assert.deepEqual(out[1].search_log.map(e => e.rank), [0, 0]);
  assert.deepEqual(r.nodes[PICK][0].outputs.main[0].map(it => it.pairedItem), [
    [{ item: 0 }, { item: 1 }, { item: 2 }, { item: 3 }], [{ item: 4 }],
  ]);
  // Nothing is written to static data; the two posts still got different photos (in-run memory).
  assert.deepEqual(r.staticData.global, {});
});

test('(h) a recently used photo is penalised (-40); real intervals; the list is read, not written', { skip, timeout: 300000 }, async () => {
  const seed = { key: 'commons:148213907', keys: ['commons:148213907'], at: '2026-10-01T00:00:00.000Z' };
  const { r, out, ov } = await runCase('h-recently-used', {
    openverse: OV_OK, commons: { 'Rolex Submariner': 'search-rolex-submariner.json' },
    staticData: { global: { liveRunIds: { 'run-e2e-1': 'x' }, imageFinder: { recent: [seed] } } },
    intervals: null,
  });
  for (const g of startGaps(ov)) assert.ok(g >= 3300, `Openverse requests ${g} ms apart`);
  const [o] = out;
  assert.equal(o.image.id, 'd3e4d1e1-c069-5080-b265-b206da47bdea');
  const old = o.alternates.find(a => a.id === 'ed296e8f-1cb3-5e22-825d-ddbd552c338c');
  assert.ok(old, 'the recently used photo is still an alternate');
  assert.equal(old.score, 13);
  assert.ok(old.reasons.includes('-40 recently used'));
  assert.deepEqual(r.staticData.global, { liveRunIds: { 'run-e2e-1': 'x' }, imageFinder: { recent: [seed] } });
});

test('(i) the Commons copy is personality-restricted: the Openverse copy of the same file is not used either', { skip, timeout: 300000 }, async () => {
  const flagged = JSON.parse(JSON.stringify(CM_SUB));
  const page = flagged.query.pages.find(p => p.pageid === 148213907);
  page.imageinfo[0].extmetadata.Restrictions = { value: 'personality', source: 'commons-desc-page', hidden: '' };
  const { out } = await runCase('i-veto', {
    openverse: { 'Rolex Submariner Date': 'search-rolex-submariner-date.json' },
    commons: { 'Rolex Submariner Date': { json: flagged } },
  });
  const [o] = out;
  assert.ok(o.image, o.image_error);
  assert.ok(!ids(o).includes('openverse:ed296e8f-1cb3-5e22-825d-ddbd552c338c'), 'Openverse copy of the flagged file');
  assert.ok(!ids(o).includes('commons:148213907'));
  assert.equal(o.image.id, 'd3e4d1e1-c069-5080-b265-b206da47bdea');
  assert.deepEqual(o.search_log.slice(0, 2).map(e => [e.provider, e.results, e.passed]), [['openverse', 4, 3], ['commons', 11, 5]]);
});
