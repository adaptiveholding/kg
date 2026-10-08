// The e2e HTTP mocks (test/e2e/mock-openverse.mjs, mock-commons.mjs, mock-http.mjs) behave like the
// real APIs they stand in for. Fast: in-process servers on free ports, no n8n.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { startOpenverseMock } from '../e2e/mock-openverse.mjs';
import { startCommonsMock, uaPolicyViolation, bareSearch, shapeResult } from '../e2e/mock-commons.mjs';
import { makeJpeg, makePng, imageSizeFromPath, resolveSpec } from '../e2e/mock-http.mjs';

const UA = 'WatchCentroImageFinder/1.0 (+https://watchcentro.com)';

// Plain http.get so the test controls every header (fetch always adds a User-Agent).
function get(url, headers = {}, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json;
        try {
          json = JSON.parse(buf.toString('utf8'));
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode, headers: res.headers, buf, text: buf.toString('utf8'), json });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const ovSearch = (base, qs) => `${base}/v1/images/?${new URLSearchParams(qs)}`;
const CM_PARAMS = {
  action: 'query',
  format: 'json',
  formatversion: '2',
  generator: 'search',
  gsrnamespace: '6',
  gsrlimit: '20',
  prop: 'imageinfo',
  iiprop: 'url|size|mime|extmetadata',
  iiurlwidth: '1920',
  iiextmetadatafilter: 'LicenseShortName|License|Artist|Restrictions',
  iiextmetadatalanguage: 'en',
  maxlag: '5',
};
const cmSearch = (base, gsrsearch, extra = {}) => `${base}/w/api.php?${new URLSearchParams({ ...CM_PARAMS, gsrsearch, ...extra })}`;

test('generated images are valid JPEG/PNG files of the requested size', () => {
  const jpg = makeJpeg(1600, 1067);
  assert.deepEqual([...jpg.subarray(0, 3)], [0xff, 0xd8, 0xff]);
  assert.deepEqual([...jpg.subarray(-2)], [0xff, 0xd9]);
  const sof = jpg.indexOf(Buffer.from([0xff, 0xc0]));
  assert.equal(jpg.readUInt16BE(sof + 5), 1067);
  assert.equal(jpg.readUInt16BE(sof + 7), 1600);
  assert.ok(jpg.length < 10000);
  const png = makePng(300, 200);
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 300);
  assert.equal(png.readUInt32BE(20), 200);
  const idat = png.indexOf('IDAT');
  const raw = zlib.inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)));
  assert.equal(raw.length, (1 + 300 * 3) * 200);
  assert.deepEqual(imageSizeFromPath('commons/thumb/1/10/X.jpg/1920px-X.jpg'), [1920, 1280]);
  assert.deepEqual(imageSizeFromPath('a/b-2000x1333.png'), [2000, 1333]);
  assert.deepEqual(imageSizeFromPath('x.jpg', { w: '1200', h: '800' }), [1200, 800]);
});

test('fixture keys: exact, normalised, extra candidates, re: patterns, __default__', () => {
  const fx = { 'Rolex Submariner': 'a', 're:^omega\\b': 'b', __default__: 'c' };
  assert.deepEqual(resolveSpec(fx, 'Rolex Submariner'), { key: 'Rolex Submariner', spec: 'a' });
  assert.deepEqual(resolveSpec(fx, '  rolex   SUBMARINER '), { key: 'Rolex Submariner', spec: 'a' });
  assert.deepEqual(resolveSpec(fx, 'Rolex Submariner filetype:bitmap', ['Rolex Submariner']), { key: 'Rolex Submariner', spec: 'a' });
  assert.deepEqual(resolveSpec(fx, 'Omega Speedmaster'), { key: 're:^omega\\b', spec: 'b' });
  assert.deepEqual(resolveSpec(fx, 'Tudor'), { key: '__default__', spec: 'c' });
  assert.equal(resolveSpec({}, 'x').key, '(builtin default)');
  assert.equal(bareSearch('Rolex Submariner filetype:bitmap -intitle:logo incategory:"Rolex watches"'), 'Rolex Submariner');
});

test('Openverse mock: search, sensitive filter, validation, throttling, sequences, logging', async () => {
  const ov = await startOpenverseMock({
    quiet: true,
    burstLimit: 8,
    fixtures: {
      'Rolex Submariner': 'search-rolex-submariner.json',
      busy: { status: 429 },
      boom: { status: 500 },
      flaky: { sequence: [{ status: 429 }, 'search-luxury-wristwatch.json'] },
    },
  });
  try {
    const qs = { q: 'Rolex Submariner', license: 'by,by-sa,cc0,pdm', page_size: '20' };
    let r = await get(ovSearch(ov.url, qs), { 'user-agent': UA });
    assert.equal(r.status, 200);
    assert.equal(r.headers['x-ratelimit-limit-anon_burst'], '20/min');
    assert.equal(r.json.results.length, 13, 'the mature record is dropped without a mature param');
    assert.equal(r.json.result_count, 13);
    assert.ok(r.json.results.every((x) => x.mature === false));

    r = await get(ovSearch(ov.url, { ...qs, mature: 'false' }));
    assert.equal(r.json.results.length, 14, 'mature=false turns sensitive results ON, as in the real API');
    assert.equal(ov.requests.at(-1).sensitive_included, true);

    r = await get(ovSearch(ov.url, { ...qs, page_size: '21' }));
    assert.equal(r.status, 401);
    assert.deepEqual(r.json, { detail: 'page_size may not exceed 20 for anonymous requests' });

    r = await get(ovSearch(ov.url, { ...qs, license: 'by, by-sa' }));
    assert.equal(r.status, 400);
    assert.deepEqual(r.json, { detail: { license: ["License ' by-sa' does not exist."] } });

    r = await get(ovSearch(ov.url, { q: 'busy' }));
    assert.equal(r.status, 429);
    assert.equal(r.headers['retry-after'], '37');
    assert.deepEqual(r.json, { detail: 'Request was throttled. Expected available in 37 seconds.' });

    r = await get(ovSearch(ov.url, { q: 'boom' }));
    assert.equal(r.status, 500);
    assert.deepEqual(r.json, { detail: 'An internal server error occurred.' });

    assert.equal((await get(ovSearch(ov.url, { q: 'flaky' }))).status, 429);
    assert.equal((await get(ovSearch(ov.url, { q: 'flaky' }))).json.results.length, 5);

    r = await get(ovSearch(ov.url, { q: 'no fixture for this' }));
    assert.deepEqual(r.json, { result_count: 0, page_count: 0, page_size: 20, page: 1, results: [] });

    r = await get(`${ov.url}/v1/images?q=x`);
    assert.equal(r.status, 301);
    assert.equal(r.headers.location, '/v1/images/?q=x');

    // 7 counted searches so far (the 301 and the rejected page_size/license requests do not count): 8th ok, 9th throttled.
    r = await get(ovSearch(ov.url, qs));
    assert.equal(r.status, 200);
    r = await get(ovSearch(ov.url, qs));
    assert.equal(r.status, 429);
    assert.equal(ov.requests.at(-1).throttled, true);

    const first = ov.requests[0];
    assert.equal(first.method, 'GET');
    assert.equal(first.pathname, '/v1/images/');
    assert.deepEqual(first.query, qs);
    assert.equal(first.headers['user-agent'], UA);
    assert.equal(first.matched, 'Rolex Submariner');
    assert.deepEqual(first.response, { status: 200, kind: 'fixture', fixture: 'search-rolex-submariner.json' });
  } finally {
    await ov.close();
  }
});

test('Openverse mock: OAuth2 client credentials, Bearer checks, token expiry', async () => {
  const ov = await startOpenverseMock({ quiet: true, tokenMaxUses: 1, fixtures: { 'Rolex Submariner': 'search-rolex-submariner.json' } });
  try {
    const form = 'grant_type=client_credentials&client_id=mock-openverse-client-id&client_secret=mock-openverse-client-secret';
    const ct = { 'content-type': 'application/x-www-form-urlencoded' };
    let r = await get(`${ov.url}/v1/auth_tokens/token/`, ct, 'POST', form);
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json), ['access_token', 'expires_in', 'token_type', 'scope']);
    assert.equal(r.json.expires_in, 43200);
    const token = r.json.access_token;

    r = await get(`${ov.url}/v1/auth_tokens/token/`, ct, 'POST', form.replace('mock-openverse-client-secret', 'wrong'));
    assert.equal(r.status, 401);
    assert.deepEqual(r.json, { error: 'invalid_client' });
    const basic = Buffer.from('mock-openverse-client-id:mock-openverse-client-secret').toString('base64');
    r = await get(`${ov.url}/v1/auth_tokens/token/`, { ...ct, authorization: `Basic ${basic}` }, 'POST', 'grant_type=client_credentials');
    assert.equal(r.status, 200, 'HTTP Basic client authentication works too');
    assert.equal(ov.requests.at(-1).headers.authorization, 'Basic <redacted>');

    r = await get(ovSearch(ov.url, { q: 'Rolex Submariner', page_size: '50' }), { authorization: `Bearer ${token}` });
    assert.equal(r.status, 200, 'registered apps may ask for 50 per page');
    assert.equal(r.headers['x-ratelimit-limit-oauth2_client_credentials_burst'], '100/min');
    assert.equal(r.headers['x-ratelimit-limit-anon_burst'], undefined);

    r = await get(ovSearch(ov.url, { q: 'x' }), { authorization: `Bearer ${token}` });
    assert.equal(r.status, 401, 'tokenMaxUses: 1');
    assert.match(r.headers['www-authenticate'], /The access token has expired/);

    r = await get(ovSearch(ov.url, { q: 'x' }), { authorization: 'Bearer not-issued' });
    assert.equal(r.status, 401);
    assert.match(r.headers['www-authenticate'], /The access token is invalid/);
    assert.deepEqual(r.json, { detail: 'Incorrect authentication credentials.' });
  } finally {
    await ov.close();
  }
});

test('Commons mock: UA policy, maxlag, gsrlimit/iiprop/iiextmetadatafilter shaping, edge errors, files', async () => {
  const cm = await startCommonsMock({
    quiet: true,
    fixtures: { 'Rolex Submariner': 'search-rolex-submariner.json', lagging: 'maxlag', down: { status: 503 }, slowdown: { status: 429 } },
  });
  try {
    const ua = { 'user-agent': UA };
    let r = await get(cmSearch(cm.url, 'Rolex Submariner filetype:bitmap'), ua);
    assert.equal(r.status, 200);
    const pages = r.json.query.pages;
    assert.equal(pages.length, 11);
    assert.deepEqual(pages.map((p) => p.index), [5, 10, 3, 11, 1, 2, 4, 6, 8, 9, 7], 'database order, not relevance order');
    assert.deepEqual(Object.keys(pages[0].imageinfo[0].extmetadata).sort(), ['Artist', 'License', 'LicenseShortName', 'Restrictions']);
    assert.equal(cm.requests.at(-1).matched, 'Rolex Submariner', 'keyed by the query without CirrusSearch keywords');

    r = await get(cmSearch(cm.url, 'Rolex Submariner filetype:bitmap', { gsrlimit: '3', iiprop: 'url|size' }), ua);
    assert.deepEqual(r.json.query.pages.map((p) => p.index), [3, 1, 2]);
    assert.deepEqual(r.json.continue, { gsroffset: 3, continue: 'gsroffset||' });
    const ii = r.json.query.pages[0].imageinfo[0];
    assert.equal(ii.mime, undefined);
    assert.equal(ii.extmetadata, undefined);
    assert.equal(typeof ii.thumburl, 'string');
    assert.equal(typeof ii.width, 'number');

    r = await get(cmSearch(cm.url, 'lagging'), ua);
    assert.equal(r.status, 200);
    assert.equal(r.headers['mediawiki-api-error'], 'maxlag');
    assert.equal(r.headers['retry-after'], '5');
    assert.equal(r.json.error.code, 'maxlag');

    r = await get(cmSearch(cm.url, 'down'), ua);
    assert.equal(r.status, 503);
    assert.match(r.headers['content-type'], /text\/html/);

    r = await get(cmSearch(cm.url, 'slowdown'), ua);
    assert.equal(r.status, 429);
    assert.equal(r.headers['retry-after'], '11');

    r = await get(cmSearch(cm.url, 'nothing here'), ua);
    assert.deepEqual(r.json, { batchcomplete: true });

    r = await get(cmSearch(cm.url, 'x'), {});
    assert.equal(r.status, 403, 'no User-Agent');
    assert.match(r.text, /Please set a user-agent/);
    assert.equal((await get(cmSearch(cm.url, 'x'), { 'user-agent': 'axios/1.7.9' })).status, 403);
    assert.equal((await get(cmSearch(cm.url, 'x'), { 'user-agent': 'axios/1.7.9 (ops@watchcentro.com)' })).status, 200);
    assert.equal(uaPolicyViolation('n8n'), null, "n8n's own default UA is not a library default");
    assert.equal(uaPolicyViolation('python-requests/2.32 (https://github.com/psf/requests)'), 'ua_policy:library_default');

    r = await get(cmSearch(cm.url, 'x', { format: 'xml' }), ua);
    assert.match(r.headers['content-type'], /text\/html/);
    r = await get(`${cm.url}/w/api.php?action=query&format=json&generator=search`, ua);
    assert.equal(r.json.error.code, 'missingparam');

    r = await get(`${cm.url}/files/upload.wikimedia.org/wikipedia/commons/thumb/4/4c/X.jpg/1920px-X.jpg`, ua);
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'image/jpeg');
    assert.deepEqual([...r.buf.subarray(0, 2)], [0xff, 0xd8]);
    r = await get(`${cm.url}/files/a-640x427.png`, ua);
    assert.equal(r.headers['content-type'], 'image/png');
    assert.equal(r.buf.readUInt32BE(16), 640);
  } finally {
    await cm.close();
  }
});

test('Commons mock: lagSeconds answers maxlag only when the request sends maxlag', async () => {
  const cm = await startCommonsMock({ quiet: true, lagSeconds: 7, fixtures: { 'Rolex Submariner': 'search-rolex-submariner.json' } });
  try {
    let r = await get(cmSearch(cm.url, 'Rolex Submariner filetype:bitmap'), { 'user-agent': UA });
    assert.equal(r.json.error.code, 'maxlag');
    assert.equal(r.headers['x-database-lag'], '7');
    const noLag = { ...CM_PARAMS, gsrsearch: 'Rolex Submariner' };
    delete noLag.maxlag;
    r = await get(`${cm.url}/w/api.php?${new URLSearchParams(noLag)}`, { 'user-agent': UA });
    assert.equal(r.json.query.pages.length, 11);
  } finally {
    await cm.close();
  }
});

test('shapeResult leaves error bodies and empty results alone', () => {
  assert.deepEqual(shapeResult({ batchcomplete: true }, {}), { batchcomplete: true });
  const err = { error: { code: 'maxlag' } };
  assert.equal(shapeResult(err, {}), err);
});
