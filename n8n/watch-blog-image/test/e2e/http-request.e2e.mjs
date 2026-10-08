// HTTP Request 4.2 behaviour that the step 3 search nodes rely on, proven in a REAL local n8n 2.x
// against mock-openverse.mjs and mock-commons.mjs (no network).
//   N8N_BIN=/abs/path/n8n.sh E2E_N8N_HOME=/abs/scratch/n8n-e2e-home node --test test/e2e/http-request.e2e.mjs
// Skipped when N8N_BIN is unset. Three n8n executions, about 70 s in total.
//
// 1. "responses": six input items (200, 429, 500, no answer -> timeout, empty result, connection
//    reset) through Openverse-style and Commons-style HTTP Request 4.2 nodes, first with the default
//    response options and onError continueRegularOutput, then with neverError + fullResponse, then a
//    Commons node without a User-Agent header; a Code node records what it sees, and bumps
//    $getWorkflowStaticData('global'). Every HTTP node reads the query through
//    $('E2E: input').item, so paired-item lookups through error items are covered too.
// 2. "oauth2": genericCredentialType + oAuth2Api with grant type Client Credentials: n8n fetches a
//    token on first use, sends it as Bearer, and on a 401 fetches a new one and repeats the request.
// 3. "retryOnFail": the engine re-runs the whole node only when output item 0 has json.error.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runWorkflow } from './run-workflow.mjs';

const OV_500 = new URL('../fixtures/openverse/error-500.json', import.meta.url);
const skip = !process.env.N8N_BIN && 'N8N_BIN not set (see test/e2e/README.md)';
const UA = 'WatchCentroImageFinder/1.0 (+https://watchcentro.com)';
const INTERVAL = 400;
const Q = "={{ $('E2E: input').item.json.q }}";

function httpNode(id, name, x, url, query, { headers = true, options = {}, node = {}, parameters = {} } = {}) {
  return {
    id,
    name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [x, 300],
    parameters: {
      url,
      sendQuery: true,
      queryParameters: { parameters: query },
      ...(headers ? { sendHeaders: true, headerParameters: { parameters: [{ name: 'User-Agent', value: UA }] } } : {}),
      options: { batching: { batch: { batchSize: 1, batchInterval: INTERVAL } }, timeout: 3000, ...options },
      ...parameters,
    },
    onError: 'continueRegularOutput',
    ...node,
  };
}

const OV_QUERY = [
  { name: 'q', value: Q },
  { name: 'license', value: 'by,by-sa,cc0,pdm' },
  { name: 'page_size', value: '20' },
];
const CM_QUERY = [
  { name: 'action', value: 'query' },
  { name: 'format', value: 'json' },
  { name: 'formatversion', value: '2' },
  { name: 'generator', value: 'search' },
  { name: 'gsrsearch', value: "={{ $('E2E: input').item.json.q }} filetype:bitmap" },
  { name: 'gsrnamespace', value: '6' },
  { name: 'gsrlimit', value: '20' },
  { name: 'prop', value: 'imageinfo' },
  { name: 'iiprop', value: 'url|size|mime|extmetadata' },
  { name: 'iiurlwidth', value: '1920' },
  { name: 'iiextmetadatalanguage', value: 'en' },
  { name: 'maxlag', value: '5' },
];
const NEVER_ERROR = { response: { response: { neverError: true, fullResponse: true } } };

const OV = 'Probe: Openverse';
const CM = 'Probe: Commons';
const OV_NE = 'Probe: Openverse neverError';
const CM_NE = 'Probe: Commons neverError';
const CM_NOUA = 'Probe: Commons no User-Agent';
const INSPECT = 'Probe: inspect';
const HTTP_NODES = [OV, CM, OV_NE, CM_NE, CM_NOUA];
const INPUT = ['Rolex Submariner', 'busy', 'boom', 'slow', 'nothing', 'reset'].map((q) => ({ q }));

const INSPECT_CODE = `const out = [];
for (const name of ${JSON.stringify(HTTP_NODES)}) {
  $(name).all().forEach((it, i) => {
    const j = it.json || {};
    const e = j.error && typeof j.error === 'object' ? j.error : null;
    out.push({ json: { node: name, i, pairedItem: it.pairedItem ?? null, keys: Object.keys(j).sort(),
      errorKeys: e ? Object.keys(e).sort() : null, errorMessage: e ? e.message ?? null : null,
      errorCode: e ? e.code ?? null : null, errorStatus: e ? e.status ?? null : null,
      statusCode: j.statusCode ?? null, retryAfter: j.headers ? j.headers['retry-after'] ?? null : null } });
  });
}
const g = $getWorkflowStaticData('global');
g.imageFinder = g.imageFinder || {};
g.imageFinder.recent = g.imageFinder.recent || [];
g.imageFinder.recent.push({ key: 'probe:' + g.imageFinder.recent.length, at: new Date().toISOString() });
if (g.imageFinder.recent.length > 30) g.imageFinder.recent = g.imageFinder.recent.slice(-30);
out.push({ json: { node: 'staticData', recent: g.imageFinder.recent.length } });
return out;`;

function responsesWorkflow() {
  const nodes = [
    httpNode('e2e3h000-0000-4000-8000-000000000001', OV, 200, 'https://api.openverse.org/v1/images/', OV_QUERY),
    httpNode('e2e3h000-0000-4000-8000-000000000002', CM, 420, 'https://commons.wikimedia.org/w/api.php', CM_QUERY),
    httpNode('e2e3h000-0000-4000-8000-000000000003', OV_NE, 640, 'https://api.openverse.org/v1/images/', OV_QUERY, { options: NEVER_ERROR }),
    httpNode('e2e3h000-0000-4000-8000-000000000004', CM_NE, 860, 'https://commons.wikimedia.org/w/api.php', CM_QUERY, { options: NEVER_ERROR }),
    httpNode('e2e3h000-0000-4000-8000-000000000005', CM_NOUA, 1080, 'https://commons.wikimedia.org/w/api.php', CM_QUERY, { headers: false }),
    { id: 'e2e3h000-0000-4000-8000-000000000006', name: INSPECT, type: 'n8n-nodes-base.code', typeVersion: 2, position: [1300, 300], parameters: { jsCode: INSPECT_CODE } },
  ];
  const chain = [...HTTP_NODES, INSPECT];
  const connections = {};
  for (let i = 0; i < chain.length - 1; i++) connections[chain[i]] = { main: [[{ node: chain[i + 1], type: 'main', index: 0 }]] };
  return { name: 'E2E HTTP Request 4.2 responses', nodes, connections };
}

const strip = (j) => {
  const c = JSON.parse(JSON.stringify(j));
  if (c.error && typeof c.error.stack === 'string') c.error.stack = c.error.stack.split('\n')[0];
  return c;
};

function save(r, name) {
  fs.writeFileSync(path.join(path.dirname(r.logs.n8n), `http-request-${name}.result.json`), JSON.stringify(r, null, 2));
}

test('HTTP Request 4.2: one item per input, error item shapes, neverError, User-Agent, batching, static data', { skip, timeout: 300000 }, async () => {
  const seed = { key: 'seeded', at: '2026-10-01T00:00:00.000Z' };
  const r = await runWorkflow({
    workflow: responsesWorkflow(),
    input: INPUT,
    staticData: { global: { imageFinder: { recent: [seed] } } },
    readStaticData: true,
    mocks: {
      openverse: {
        fixtures: { 'Rolex Submariner': 'search-rolex-submariner.json', busy: { status: 429 }, boom: { status: 500 }, slow: { hang: true }, reset: { reset: true } },
      },
      commons: {
        fixtures: { 'Rolex Submariner': 'search-rolex-submariner.json', busy: 'maxlag', boom: { status: 503 }, slow: { hang: true }, reset: { reset: true } },
      },
    },
  });
  save(r, 'responses');
  assert.equal(r.ok, true, `workflow failed: ${JSON.stringify(r.error)}; see ${r.logs.n8n}`);
  assert.equal(r.rewrites, 5, 'every HTTP node URL points at a mock');

  // One output item per input item, in order, each paired with its input item, for every node.
  for (const name of HTTP_NODES) {
    const out = r.nodes[name][0].outputs.main[0];
    assert.equal(out.length, INPUT.length, `${name}: one item per input item`);
    out.forEach((it, i) => assert.deepEqual(it.pairedItem, { item: i }, `${name} item ${i} pairedItem`));
  }
  const items = (name) => r.nodes[name][0].outputs.main[0].map((it) => strip(it.json));

  // Default response options: JSON body as the item; failures as {error: AxiosError.toJSON()}.
  const ov = items(OV);
  assert.equal(ov[0].result_count, 13, 'the object response is ONE item (results is not split)');
  assert.equal(ov[0].results.length, 13, 'mature record removed: no mature param sent');
  assert.deepEqual(ov[1], {
    error: {
      message: "Try spacing your requests out using the batching settings under 'Options'",
      name: 'AxiosError',
      stack: 'AxiosError: Request failed with status code 429',
      code: 'ERR_BAD_REQUEST',
      status: 429,
    },
  });
  assert.deepEqual(Object.keys(ov[2].error), ['message', 'name', 'stack', 'code', 'status']);
  assert.equal(ov[2].error.status, 500);
  assert.equal(ov[2].error.code, 'ERR_BAD_RESPONSE');
  assert.equal(ov[2].error.message, `500 - ${JSON.stringify(fs.readFileSync(OV_500, 'utf8').trimEnd())}`, 'message = "<status> - " + JSON.stringify(body text, trailing newline dropped)');
  assert.deepEqual(ov[3], { error: { message: 'timeout of 3000ms exceeded', name: 'AxiosError', stack: 'AxiosError: timeout of 3000ms exceeded', code: 'ECONNABORTED' } });
  assert.deepEqual(ov[4], { result_count: 0, page_count: 0, page_size: 20, page: 1, results: [] });
  assert.deepEqual(ov[5], { error: { message: 'socket hang up', name: 'Error', stack: 'Error: socket hang up', code: 'ECONNRESET' } });

  const cm = items(CM);
  assert.equal(cm[0].query.pages.length, 11);
  assert.equal(cm[1].error.code, 'maxlag', 'a MediaWiki API error is HTTP 200: a normal item whose json.error has code/info');
  assert.equal(typeof cm[1].error.info, 'string');
  assert.equal(cm[1].error.message, undefined);
  assert.equal(cm[2].error.status, 503);
  assert.ok(cm[2].error.message.startsWith('503 - "<!DOCTYPE html>'), 'non-JSON error body ends up JSON-stringified in the message');
  assert.equal(cm[3].error.code, 'ECONNABORTED');
  assert.deepEqual(cm[4], { batchcomplete: true }, 'no hits: no "query" key at all');
  assert.equal(cm[5].error.code, 'ECONNRESET');

  // neverError + fullResponse: every HTTP answer is {body, headers, statusCode, statusMessage}.
  const ovne = items(OV_NE);
  assert.deepEqual(Object.keys(ovne[0]).sort(), ['body', 'headers', 'statusCode', 'statusMessage']);
  assert.equal(ovne[0].statusCode, 200);
  assert.equal(ovne[0].body.results.length, 13);
  assert.equal(ovne[1].statusCode, 429);
  assert.equal(ovne[1].statusMessage, 'Too Many Requests');
  assert.deepEqual(ovne[1].body, { detail: 'Request was throttled. Expected available in 37 seconds.' });
  assert.equal(ovne[1].headers['retry-after'], '37', 'headers are lower-cased');
  assert.equal(ovne[2].statusCode, 500);
  assert.deepEqual(ovne[2].body, { detail: 'An internal server error occurred.' });
  assert.equal(ovne[3].error.code, 'ECONNABORTED', 'network failures still become error items');
  assert.equal(ovne[5].error.code, 'ECONNRESET');
  const cmne = items(CM_NE);
  assert.equal(cmne[1].statusCode, 200);
  assert.equal(cmne[1].body.error.code, 'maxlag');
  assert.equal(cmne[1].headers['mediawiki-api-error'], 'maxlag');
  assert.equal(cmne[1].headers['retry-after'], '5');
  assert.equal(cmne[2].statusCode, 503);
  assert.equal(typeof cmne[2].data, 'string', 'a text/html answer goes to `data`, not `body`');
  assert.ok(cmne[2].data.startsWith('<!DOCTYPE html>'));

  // The Code node downstream sees exactly the same shapes and paired items.
  const seen = r.nodes[INSPECT][0].items;
  for (const name of HTTP_NODES) {
    const rows = seen.filter((s) => s.node === name);
    assert.equal(rows.length, INPUT.length);
    rows.forEach((s, i) => {
      assert.deepEqual(s.pairedItem, { item: i });
      const j = r.nodes[name][0].outputs.main[0][i].json;
      assert.deepEqual(s.keys, Object.keys(j).sort());
    });
  }
  const seenOv429 = seen.find((s) => s.node === OV && s.i === 1);
  assert.deepEqual(seenOv429.errorKeys, ['code', 'message', 'name', 'stack', 'status']);
  assert.equal(seenOv429.errorStatus, 429);

  // What the mocks received: the query parameters, the User-Agent, one request per item, spaced by the batch interval.
  const ovReq = r.mocks.openverse.requests;
  assert.equal(ovReq.length, 2 * INPUT.length);
  for (const q of ovReq) {
    assert.equal(q.pathname, '/v1/images/');
    assert.equal(q.headers['user-agent'], UA);
    assert.deepEqual(Object.keys(q.query), ['q', 'license', 'page_size']);
    assert.equal(q.query.license, 'by,by-sa,cc0,pdm');
    assert.ok(q.path.includes('license=by%2Cby-sa%2Ccc0%2Cpdm'), 'commas are percent-encoded');
  }
  assert.deepEqual(ovReq.slice(0, 6).map((q) => q.query.q), INPUT.map((i) => i.q), '$(...).item resolves per item, through error items');
  const cmReq = r.mocks.commons.requests;
  assert.equal(cmReq.length, 3 * INPUT.length);
  for (const q of cmReq.slice(0, 12)) assert.equal(q.headers['user-agent'], UA);
  for (const q of cmReq.slice(12)) assert.equal(q.headers['user-agent'], 'n8n', 'n8n default User-Agent when the node sets none');
  assert.deepEqual(cmReq.slice(0, 6).map((q) => q.query.gsrsearch), INPUT.map((i) => `${i.q} filetype:bitmap`));
  assert.equal(cmReq[0].query.iiprop, 'url|size|mime|extmetadata');
  assert.ok(cmReq[0].path.includes('iiprop=url%7Csize%7Cmime%7Cextmetadata'));
  for (const reqs of [ovReq.slice(0, 6), ovReq.slice(6), cmReq.slice(0, 6), cmReq.slice(6, 12), cmReq.slice(12)]) {
    for (let i = 1; i < reqs.length; i++) {
      const gap = reqs[i].t_ms - reqs[i - 1].t_ms;
      assert.ok(gap >= INTERVAL - 30, `batch interval respected (gap ${gap} ms)`);
      assert.ok(gap < INTERVAL + 600, `requests are not serialized behind slow answers (gap ${gap} ms)`);
    }
  }

  // Static data: seeded on import, mutated in the Code node, persisted ("cli" mode is not "manual").
  assert.deepEqual(seen.at(-1), { node: 'staticData', recent: 2 });
  assert.equal(r.staticData.global.imageFinder.recent.length, 2);
  assert.deepEqual(r.staticData.global.imageFinder.recent[0], seed);
  assert.equal(r.staticData.global.imageFinder.recent[1].key, 'probe:1');
});

test('HTTP Request 4.2 + OAuth2 API credential (client credentials): token on first use, refresh on 401', { skip, timeout: 300000 }, async () => {
  const CRED = { id: 'ovMockOAuth2Cred1', name: 'Openverse API (e2e mock)' };
  const node = httpNode('e2e3h000-0000-4000-8000-000000000011', 'Probe: Openverse OAuth2', 200, 'https://api.openverse.org/v1/images/', OV_QUERY, {
    parameters: { authentication: 'genericCredentialType', genericAuthType: 'oAuth2Api' },
    node: { credentials: { oAuth2Api: CRED } },
    options: { timeout: 20000, batching: { batch: { batchSize: 1, batchInterval: 600 } } },
  });
  const input = ['Rolex Submariner', 'luxury wristwatch', 'Rolex Submariner Date', 'nothing'].map((q) => ({ q }));
  const r = await runWorkflow({
    workflow: { name: 'E2E HTTP Request OAuth2', nodes: [node], connections: {} },
    input,
    mocks: {
      openverse: {
        tokenMaxUses: 2, // the third search with the first token gets 401 "The access token has expired."
        fixtures: { 'Rolex Submariner': 'search-rolex-submariner.json', 'luxury wristwatch': 'search-luxury-wristwatch.json', 'Rolex Submariner Date': 'search-rolex-submariner-date.json' },
      },
    },
    credentials: [
      {
        ...CRED,
        type: 'oAuth2Api',
        data: {
          grantType: 'clientCredentials',
          accessTokenUrl: '{{mock:openverse}}/v1/auth_tokens/token/',
          clientId: 'mock-openverse-client-id',
          clientSecret: 'mock-openverse-client-secret',
          scope: '',
          authentication: 'body',
        },
      },
    ],
  });
  save(r, 'oauth2');
  assert.equal(r.ok, true, `workflow failed: ${JSON.stringify(r.error)}; see ${r.logs.n8n}`);
  const out = r.nodes['Probe: Openverse OAuth2'][0].items;
  assert.deepEqual(out.map((j) => j.result_count), [13, 5, 4, 0], 'all four searches succeed');
  const reqs = r.mocks.openverse.requests;
  const kinds = reqs.map((q) => `${q.method} ${q.pathname} ${q.response.status}`);
  assert.deepEqual(kinds, [
    'POST /v1/auth_tokens/token/ 200',
    'GET /v1/images/ 200',
    'GET /v1/images/ 200',
    'GET /v1/images/ 401',
    'POST /v1/auth_tokens/token/ 200',
    'GET /v1/images/ 200',
    'GET /v1/images/ 200',
  ]);
  for (const t of [reqs[0], reqs[4]]) {
    assert.equal(t.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.deepEqual(t.body, { grant_type: 'client_credentials', client_id: 'mock-openverse-client-id', client_secret: '<redacted>' });
    assert.equal(t.client_auth, 'body');
  }
  assert.equal(reqs[1].headers.authorization, `Bearer ${reqs[0].issued_token}`);
  assert.equal(reqs[3].headers.authorization, `Bearer ${reqs[0].issued_token}`);
  assert.equal(reqs[5].headers.authorization, `Bearer ${reqs[4].issued_token}`, 'the 401 request is repeated once with the new token');
  assert.equal(reqs[5].query.q, 'Rolex Submariner Date');
  assert.equal(reqs[6].headers.authorization, `Bearer ${reqs[4].issued_token}`, 'later items reuse the new token');
});

test('retryOnFail re-runs the whole node, and only when output item 0 has json.error', { skip, timeout: 300000 }, async () => {
  const mk = (id, name, x, suffix) =>
    httpNode(id, name, x, 'https://api.openverse.org/v1/images/', [{ name: 'q', value: `={{ $('E2E: input').item.json.q + '${suffix}' }}` }], {
      headers: true,
      options: { batching: { batch: { batchSize: 1, batchInterval: 200 } } },
      node: { retryOnFail: true, maxTries: 2, waitBetweenTries: 300 },
    });
  const r = await runWorkflow({
    workflow: {
      name: 'E2E HTTP Request retryOnFail',
      nodes: [mk('e2e3h000-0000-4000-8000-000000000021', 'Probe: A', 200, 'A'), mk('e2e3h000-0000-4000-8000-000000000022', 'Probe: B', 420, 'B')],
      connections: { 'Probe: A': { main: [[{ node: 'Probe: B', type: 'main', index: 0 }]] } },
    },
    input: [{ q: 'first' }, { q: 'second' }],
    mocks: {
      openverse: {
        fixtures: {
          firstA: { sequence: [{ status: 429 }, 'search-luxury-wristwatch.json'] },
          secondA: 'search-empty.json',
          firstB: 'search-empty.json',
          secondB: { status: 429 },
        },
      },
    },
  });
  save(r, 'retry');
  assert.equal(r.ok, true, `workflow failed: ${JSON.stringify(r.error)}; see ${r.logs.n8n}`);
  assert.deepEqual(
    r.mocks.openverse.requests.map((q) => `${q.query.q} ${q.response.status}`),
    ['firstA 429', 'secondA 200', 'firstA 200', 'secondA 200', 'firstB 200', 'secondB 429'],
    'A: item 0 failed, so BOTH items were requested again; B: item 1 failed, no retry',
  );
  assert.equal(r.nodes['Probe: A'][0].items[0].result_count, 5);
  assert.equal(r.nodes['Probe: B'][0].items[1].error.status, 429);
});
