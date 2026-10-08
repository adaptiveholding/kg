import test from 'node:test';
import assert from 'node:assert/strict';
import { runCode, runBuild, llmText, clone, PICK_CODE, setConst, BUILD_NODE, SPLIT_NODE, OPENVERSE_NODE, COMMONS_NODE } from './harness.mjs';
import {
  OV, CM, N8N, ovPage, cmPages, ovRec, cmRec, post, query, pipeline, single, Q_MODEL, Q_FAMILY, Q_BRAND, Q_GENERIC, W_SUB,
} from './step3-helpers.mjs';

const ALL4 = [Q_MODEL, Q_FAMILY, Q_BRAND, Q_GENERIC];
const OV_MAP = {
  'Rolex Submariner Date': 'search-rolex-submariner-date.json', 'Rolex Submariner': 'search-rolex-submariner.json',
  'Rolex watch': 'search-rolex-watch-nothing-usable.json', 'luxury wristwatch': 'search-luxury-wristwatch.json',
};
const CM_MAP = { 'Rolex Submariner': 'search-rolex-submariner.json' };
const IMAGE_KEYS = [
  'provider', 'source_name', 'id', 'title', 'creator', 'creator_url', 'license', 'license_version', 'license_name',
  'license_url', 'landing_url', 'file_url', 'width', 'height', 'extension', 'mime', 'attribution_required', 'query',
  'score', 'reasons', 'alt_text', 'credit_text', 'download_filename',
];
const OUT_KEYS = ['source', 'post_title', 'watches', 'image_queries', 'image', 'image_error', 'alternates', 'search_log'];
const tag = name => ({ name, accuracy: null, unstable__provider: 'flickr' });
const flickrTags = (...names) => names.map(tag);

// Every output: exact keys, image shape, no em dash, no internal fields, plain-text alt/credit.
function assertContract(o) {
  assert.deepEqual(Object.keys(o), OUT_KEYS);
  const text = JSON.stringify(o);
  assert.ok(!text.includes('\u2014'), 'no em dash');
  for (const img of [o.image, ...o.alternates].filter(Boolean)) {
    assert.deepEqual(Object.keys(img), IMAGE_KEYS);
    assert.ok(['cc0', 'pdm', 'by', 'by-sa'].includes(img.license), img.license);
    assert.doesNotMatch(img.credit_text, /https?:|www\.|\u2014|\u2013/);
    assert.doesNotMatch(img.alt_text, /https?:|\u2014/);
    assert.match(img.download_filename, /^[a-z0-9-]+-(openverse|commons)-[a-z0-9]+\.(jpg|png|webp)$/);
    assert.ok(img.download_filename.length <= 80, img.download_filename);
    assert.match(img.file_url, /^https:\/\//);
    assert.match(img.landing_url, /^https:\/\//);
  }
  for (const e of o.search_log) {
    assert.deepEqual(Object.keys(e), e.status === 'error'
      ? ['rank', 'q', 'provider', 'status', 'http_error', 'results', 'passed']
      : ['rank', 'q', 'provider', 'status', 'results', 'passed']);
  }
}
const run = async opts => { const r = await pipeline(opts); r.json.forEach(assertContract); return r; };
const one = async (q, ov, cm, opts) => { const o = await single(q, ov, cm, opts); assertContract(o); return o; };

// --- The six step-3 scenarios ---------------------------------------------------------------------------

test('(a) Openverse hit at model level: best-scored copy, Commons-hosted file fetched as a 1920 px thumbnail', async () => {
  const { json: [o], splits } = await run({ posts: [post(ALL4)], openverse: OV_MAP, commons: CM_MAP });
  assert.equal(splits.length, 4);
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
  });
  assert.deepEqual(o.search_log[0], { rank: 0, q: 'Rolex Submariner Date', provider: 'openverse', status: 'ok', results: 4, passed: 4 });
  assert.deepEqual(o.search_log.map(e => [e.rank, e.provider, e.status, e.results, e.passed]), [
    [0, 'openverse', 'ok', 4, 4], [0, 'commons', 'ok', 0, 0], [1, 'openverse', 'ok', 14, 8], [1, 'commons', 'ok', 11, 6],
    [2, 'openverse', 'ok', 9, 0], [2, 'commons', 'ok', 0, 0], [3, 'openverse', 'ok', 5, 3], [3, 'commons', 'ok', 0, 0],
  ]);
  // The Flickr original (a765171e) and the Flickr2Commons copy (d3e4d1e1) are one photo; the copy scores higher.
  assert.deepEqual(o.alternates.map(a => [a.provider, a.id, a.score]), [
    ['openverse', 'd3e4d1e1-c069-5080-b265-b206da47bdea', 53], ['openverse', '149d8686-eb6f-51c9-a31f-86efb87a8d42', 28],
    ['commons', '34418877', 35],
  ]);
  const p = post(ALL4);
  assert.deepEqual([o.source, o.post_title, o.watches, o.image_queries], [p.source, p.post_title, p.watches, p.image_queries]);
});

test('(a2) a Flickr photo keeps its own URL and credits Flickr', async () => {
  const o = await one(Q_MODEL, ovPage(ovRec(0)));
  assert.equal(o.image.file_url, 'https://live.staticflickr.com/65535/53218846721_9c1e4b7a2f_b.jpg');
  assert.deepEqual([o.image.width, o.image.height, o.image.score], [1024, 683, 43]);
  assert.equal(o.image.credit_text, 'Photo: "Rolex Submariner Date 126610LN" by chronoshots, CC BY 2.0, via Flickr');
  assert.equal(o.image.download_filename, 'rolex-submariner-date-watch-openverse-a765171e3b3a.jpg');
});

test('(b) Openverse answers 429 to every request: Commons wins, search_log records each 429', async () => {
  const { json: [o] } = await run({ posts: [post(ALL4)], openverse: () => N8N.default_429, commons: CM_MAP });
  assert.deepEqual(o.search_log.filter(e => e.provider === 'openverse'),
    ALL4.map((q, rank) => ({ rank, q: q.q, provider: 'openverse', status: 'error', http_error: 'HTTP 429', results: 0, passed: 0 })));
  const page = CM('search-rolex-submariner.json').query.pages.find(p => p.index === 1);
  assert.equal(o.image.provider, 'commons');
  assert.equal(o.image.id, '148213907');
  assert.deepEqual(o.image.query, { rank: 1, q: 'Rolex Submariner', level: 'family', watch_index: 0 });
  assert.equal(o.image.file_url, page.imageinfo[0].thumburl, 'the API thumbnail (1920 px step)');
  assert.equal(o.image.landing_url, 'https://commons.wikimedia.org/wiki/File:Rolex_Submariner_Date_126610LN.jpg');
  assert.deepEqual([o.image.width, o.image.height, o.image.score], [1920, 1440, 50]);
  assert.deepEqual(o.image.reasons, ['+20 model tokens present', '+15 reference 126610LN', '+10 width >= 1600', '+5 landscape']);
  assert.equal(o.image.alt_text, 'Rolex Submariner Date watch', 'family query, but the photo shows the model');
  assert.equal(o.image.credit_text, 'Photo: "Rolex Submariner Date 126610LN" by Horologium42, CC BY-SA 4.0, via Wikimedia Commons');
  assert.deepEqual([o.image.license_name, o.image.license_url], ['CC BY-SA 4.0', 'https://creativecommons.org/licenses/by-sa/4.0']);
});

test('(c) only the generic query finds something: the generic photo is chosen with generic alt text', async () => {
  const { json: [o] } = await run({
    posts: [post(ALL4)],
    openverse: { 'luxury wristwatch': 'search-luxury-wristwatch.json', __default__: 'search-rolex-watch-nothing-usable.json' },
  });
  assert.equal(o.image.id, '257ee03a-0c40-53ee-9ade-d0df7abffb89');
  assert.deepEqual(o.image.query, { rank: 3, q: 'luxury wristwatch', level: 'generic', watch_index: -1 });
  assert.equal(o.image.alt_text, 'Luxury wristwatch');
  assert.equal(o.image.credit_text, 'Photo: "Luxury wristwatch" by Open Watch Photos (CC0 1.0), via Flickr');
  assert.equal(o.image.download_filename, 'luxury-wristwatch-openverse-257ee03a0c40.jpg');
  assert.equal(o.image.attribution_required, false);
  // caseback (Commons-hosted, wide) and store (Flickr) are penalised, portraits under 1000 px are rejected.
  assert.deepEqual(o.alternates.map(a => [a.id.slice(0, 8), a.score]), [['a6cad6a3', 3], ['20a26494', -7]]);
  assert.ok(o.alternates[0].reasons.includes('-15 negative term caseback'));
  assert.ok(o.alternates[1].reasons.includes('-15 negative term store'));
});

test('(d) nothing passes anywhere: image null, the reason names the rejections, the run still completes', async () => {
  const { json: [o] } = await run({
    posts: [post(ALL4)], openverse: () => 'search-rolex-watch-nothing-usable.json', commons: () => 'search-nothing-usable.json',
  });
  assert.equal(o.image, null);
  assert.deepEqual(o.alternates, []);
  assert.equal(o.image_error, 'no licence-safe relevant photo found for 4 queries; ' +
    'openverse: 36 results in 4 searches, 0 passed (file type 12, excluded term 8, too small 8, aspect 4, mature 4); ' +
    'commons: 48 results in 4 searches, 0 passed (licence 20, excluded term 8, too small 4, aspect 4, file type 4)');
  assert.ok(o.search_log.every(e => e.status === 'ok' && e.passed === 0));
});

test('(e) the same photo from both providers is kept once (Commons page id, upload path, Flickr id)', async () => {
  const o = await one(Q_FAMILY, 'search-rolex-submariner.json', 'search-rolex-submariner.json');
  const all = [o.image, ...o.alternates];
  assert.deepEqual(all.map(a => [a.provider, a.id]), [
    ['openverse', 'ed296e8f-1cb3-5e22-825d-ddbd552c338c'], ['openverse', 'd3e4d1e1-c069-5080-b265-b206da47bdea'],
    ['commons', '34418877'], ['openverse', '149d8686-eb6f-51c9-a31f-86efb87a8d42'],
  ]);
  // Commons 148213907 = Openverse ed296e8f, 150337412 = d3e4d1e1, 118904562 = 149d8686; Flickr a765171e = d3e4d1e1.
  for (const id of ['148213907', '150337412', '118904562', 'a765171e-3b3a-5da9-9e17-ebaae6a89b6f']) assert.ok(!all.some(a => a.id === id), id);
});

test('(f) Commons pages arrive in database order: relevance "index" decides ties, not array position', async () => {
  const o = await one(Q_FAMILY, N8N.default_429, 'search-rolex-submariner.json');
  assert.deepEqual(CM('search-rolex-submariner.json').query.pages.map(p => p.index), [5, 10, 3, 11, 1, 2, 4, 6, 8, 9, 7]);
  assert.deepEqual([o.image, ...o.alternates].map(a => [a.id, a.score]), [['148213907', 50], ['150337412', 50], ['34418877', 35], ['118904562', 25]]);
});

test('Commons index tie-break: two equal pages, the lower index wins whatever the array order', async () => {
  const mk = (index, pageid, name) => cmRec(3, {
    page: { index, pageid, title: `File:${name}.jpg` },
    info: { url: `https://upload.wikimedia.org/wikipedia/commons/a/ab/${name}.jpg`, thumburl: '', descriptionurl: `https://commons.wikimedia.org/wiki/File:${name}.jpg`, descriptionshorturl: `https://commons.wikimedia.org/w/index.php?curid=${pageid}` },
  });
  const a = mk(2, 1001, 'Rolex_Submariner_Date_A');
  const b = mk(1, 1002, 'Rolex_Submariner_Date_B');
  for (const pages of [[a, b], [b, a]]) {
    const o = await one(Q_FAMILY, N8N.default_429, cmPages(...clone(pages)));
    assert.deepEqual([o.image.id, o.alternates[0].id], ['1002', '1001']);
    assert.equal(o.image.score, o.alternates[0].score);
  }
});

test('Commons formatversion=1 (pages keyed by page id) is read too', async () => {
  const fv2 = CM('search-rolex-submariner.json');
  const fv1 = { batchcomplete: '', query: { pages: Object.fromEntries(fv2.query.pages.map(p => [String(p.pageid), p])) } };
  const o = await one(Q_FAMILY, N8N.default_429, fv1);
  assert.equal(o.image.id, '148213907');
});

// --- Hard filters: Openverse ------------------------------------------------------------------------------
// Base record: Flickr CC0 "Rolex Submariner" 1024x768 (passes for the family query).
const OV_BASE = 2;
const OV_FILTERS = [
  ['licence by-nc', { license: 'by-nc', license_url: 'https://creativecommons.org/licenses/by-nc/2.0/' }, 'licence'],
  ['licence by-nd', { license: 'by-nd', license_url: 'https://creativecommons.org/licenses/by-nd/2.0/' }, 'licence'],
  ['licence by-nc-sa', { license: 'by-nc-sa', license_version: '2.0', license_url: null }, 'licence'],
  ['licence by-nc-nd', { license: 'by-nc-nd', license_version: '3.0', license_url: null }, 'licence'],
  ['licence sampling+', { license: 'sampling+', license_version: '1.0', license_url: null }, 'licence'],
  ['licence missing', { license: null, license_version: null, license_url: null }, 'licence'],
  ['license "by" but license_url says by-nc', { license: 'by', license_version: '2.0', license_url: 'https://creativecommons.org/licenses/by-nc/2.0/' }, 'licence'],
  ['recorded odd URL .../by-nd-nc/2.0/jp/', { license: 'by', license_version: '2.0', license_url: 'https://creativecommons.org/licenses/by-nd-nc/2.0/jp/' }, 'licence'],
  ['license_url outside creativecommons.org', { license: 'by', license_version: '2.0', license_url: 'https://example.com/terms' }, 'licence'],
  ['license by-sa but license_url says by', { license: 'by-sa', license_version: '2.0', license_url: 'https://creativecommons.org/licenses/by/2.0/' }, 'licence'],
  ['mature', { mature: true }, 'mature'],
  ['sensitive text', { unstable__sensitivity: ['sensitive_text'] }, 'mature'],
  ['svg', { url: 'https://upload.wikimedia.org/wikipedia/commons/d/d8/Rolex_Submariner_dial.svg', filetype: 'svg', category: 'illustration' }, 'file type'],
  ['gif', { url: 'https://live.staticflickr.com/1/2_3.gif', filetype: 'gif' }, 'file type'],
  ['tiff (filetype only)', { url: 'https://upload.wikimedia.org/wikipedia/commons/3/33/Scan.tif', filetype: 'tiff' }, 'file type'],
  ['pdf', { url: 'https://example.org/rolex-submariner.pdf', filetype: null }, 'file type'],
  ['djvu', { url: 'https://example.org/rolex-submariner.djvu', filetype: null }, 'file type'],
  ['video', { url: 'https://example.org/rolex-submariner.webm', filetype: 'webm' }, 'file type'],
  ['no extension, no filetype', { url: 'https://images.example.org/photo/12345', filetype: null }, 'file type'],
  ['filetype svg behind a .jpg URL', { filetype: 'svg' }, 'file type'],
  ['999 px wide', { width: 999, height: 700 }, 'too small'],
  ['Flickr portrait 683x1024', { width: 683, height: 1024 }, 'too small'],
  ['aspect 0.6596 (< 0.66)', { width: 1000, height: 1516 }, 'aspect'],
  ['aspect 2.5 (> 2.4)', { width: 2500, height: 1000 }, 'aspect'],
  ['"replica" in the title', { title: 'Replica Rolex Submariner' }, 'excluded term'],
  ['"counterfeit" tag', { tags: flickrTags('rolex', 'submariner', 'counterfeit') }, 'excluded term'],
  ['concatenated tag "rolexreplica"', { tags: flickrTags('rolex', 'submariner', 'rolexreplica') }, 'excluded term'],
  ['"logo" in the title', { title: 'Rolex Submariner logo' }, 'excluded term'],
  ['"fakes" (plural) in the title', { title: 'Rolex Submariner fakes' }, 'excluded term'],
  ['url missing', { url: null }, 'missing url'],
  ['foreign_landing_url empty', { foreign_landing_url: '' }, 'missing url'],
  ['url not http(s)', { url: 'ftp://example.org/rolex.jpg' }, 'missing url'],
];
for (const [name, patch, category] of OV_FILTERS) {
  test(`Openverse hard filter rejects: ${name}`, async () => {
    const o = await one(Q_FAMILY, ovPage(ovRec(OV_BASE, patch)));
    assert.equal(o.image, null);
    assert.equal(o.image_error, `no licence-safe relevant photo found for 1 query; openverse: 1 result in 1 search, 0 passed (${category} 1); commons: 0 results in 1 search, 0 passed`);
  });
}

const OV_PASSES = [
  ['webp', { url: 'https://live.staticflickr.com/65535/52790466118_3a7d0c51e8_b.webp', filetype: 'webp' }, i => {
    assert.deepEqual([i.extension, i.mime], ['webp', 'image/webp']);
    assert.match(i.download_filename, /\.webp$/);
  }],
  ['png', { url: 'https://live.staticflickr.com/65535/52790466118_3a7d0c51e8_b.png', filetype: 'png' }, i => assert.equal(i.mime, 'image/png')],
  ['filetype null: extension from the URL', { filetype: null }, i => assert.equal(i.extension, 'jpg')],
  ['aspect exactly 2.4', { width: 2400, height: 1000 }, i => assert.equal(i.width, 2400)],
  ['aspect 0.66 (1000x1515)', { width: 1000, height: 1515 }, i => assert.equal(i.height, 1515)],
  ['width exactly MIN_WIDTH', { width: 1000, height: 750 }, i => assert.equal(i.width, 1000)],
  ['a machine tag "logo" does not exclude', { tags: [...flickrTags('rolex', 'submariner'), { name: 'logo', accuracy: 0.91, unstable__provider: 'clarifai' }] }, () => {}],
  ['tag "memento" is not "meme"', { tags: flickrTags('rolex', 'submariner', 'memento') }, () => {}],
  ['"logos" only in a description Openverse does not return', { fields_matched: ['description', 'title'] }, () => {}],
  ['unknown dimensions: kept, -10', { width: null, height: null }, i => {
    assert.deepEqual([i.width, i.height], [null, null]);
    assert.deepEqual(i.reasons, ['+3 openverse', '-10 unknown dimensions']);
  }],
  ['CC BY without creator: "Unknown author", -10', { license: 'by', license_version: '2.0', license_url: 'https://creativecommons.org/licenses/by/2.0/', creator: null, creator_url: null }, i => {
    assert.equal(i.creator, 'Unknown author');
    assert.ok(i.reasons.includes('-10 creator unknown'));
    assert.equal(i.credit_text, 'Photo: "Rolex Submariner" by Unknown author, CC BY 2.0, via Flickr');
  }],
  ['CC0 without creator: no penalty', { creator: null }, i => {
    assert.equal(i.creator, 'Unknown author');
    assert.ok(!i.reasons.includes('-10 creator unknown'));
    assert.equal(i.credit_text, 'Photo: "Rolex Submariner" (CC0 1.0), via Flickr');
  }],
  ['Public Domain Mark', { license: 'pdm', license_version: '1.0', license_url: 'https://creativecommons.org/publicdomain/mark/1.0/' }, i => {
    assert.deepEqual([i.license, i.license_name, i.attribution_required], ['pdm', 'Public Domain Mark 1.0', false]);
    assert.equal(i.credit_text, 'Photo: "Rolex Submariner" by Open Watch Photos (Public Domain Mark 1.0), via Flickr');
  }],
  ['license_url null is rebuilt', { license: 'by-sa', license_version: '2.0', license_url: null }, i => {
    assert.deepEqual([i.license_name, i.license_url, i.attribution_required], ['CC BY-SA 2.0', 'https://creativecommons.org/licenses/by-sa/2.0/', true]);
  }],
  ['jurisdiction port from license_url', { license: 'by', license_version: '2.0', license_url: 'https://creativecommons.org/licenses/by/2.0/jp/' }, i => {
    assert.equal(i.license_name, 'CC BY 2.0 JP');
  }],
  ['CC0 deed URL from a legacy Commons row', { license_url: 'http://creativecommons.org/publicdomain/zero/1.0/deed.en' }, i => {
    assert.deepEqual([i.license, i.license_name, i.license_url], ['cc0', 'CC0 1.0', 'http://creativecommons.org/publicdomain/zero/1.0/deed.en']);
  }],
];
for (const [name, patch, check] of OV_PASSES) {
  test(`Openverse record passes: ${name}`, async () => {
    const o = await one(Q_FAMILY, ovPage(ovRec(OV_BASE, patch)));
    assert.ok(o.image, o.image_error);
    check(o.image);
  });
}

// --- Hard filters and licences: Commons -------------------------------------------------------------------
// Base page: index 1 (CC BY-SA 4.0, 4032x3024, Rolex Submariner Date 126610LN).
const GFDL_URL = 'http://www.gnu.org/copyleft/fdl.html';
const COMMONS_LICENCES = [
  ['CC BY-SA 3.0 de (jurisdiction port)', { LicenseShortName: 'CC BY-SA 3.0 de', License: 'cc-by-sa-3.0-de', LicenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/de/deed.en' }, ['by-sa', '3.0', 'CC BY-SA 3.0 DE', 'https://creativecommons.org/licenses/by-sa/3.0/de/deed.en']],
  ['CC BY 2.5 nl', { LicenseShortName: 'CC BY 2.5 nl', License: 'cc-by-2.5-nl', LicenseUrl: 'https://creativecommons.org/licenses/by/2.5/nl/deed.en' }, ['by', '2.5', 'CC BY 2.5 NL', 'https://creativecommons.org/licenses/by/2.5/nl/deed.en']],
  ['old style CC-BY-SA-3.0', { LicenseShortName: 'CC-BY-SA-3.0', License: 'cc-by-sa-3.0', LicenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0' }, ['by-sa', '3.0', 'CC BY-SA 3.0', 'https://creativecommons.org/licenses/by-sa/3.0']],
  ['CC BY-SA 3.0 igo (no machine License key)', { LicenseShortName: 'CC BY-SA 3.0 igo', License: null, LicenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/igo/deed.en' }, ['by-sa', '3.0', 'CC BY-SA 3.0 IGO', 'https://creativecommons.org/licenses/by-sa/3.0/igo/deed.en']],
  ['multi-version CC BY-SA 3.0-2.5-2.0-1.0', { LicenseShortName: 'CC BY-SA 3.0-2.5-2.0-1.0', License: 'cc-by-sa-3.0', LicenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0' }, ['by-sa', '3.0', 'CC BY-SA 3.0', 'https://creativecommons.org/licenses/by-sa/3.0']],
  ['CC0', { LicenseShortName: 'CC0', License: 'cc0', LicenseUrl: 'http://creativecommons.org/publicdomain/zero/1.0/deed.en', AttributionRequired: 'false' }, ['cc0', '1.0', 'CC0 1.0', 'http://creativecommons.org/publicdomain/zero/1.0/deed.en']],
  ['Public domain', { LicenseShortName: 'Public domain', License: 'pd', LicenseUrl: null, UsageTerms: 'Public domain', AttributionRequired: 'false', Copyrighted: 'False' }, ['pdm', '', 'Public domain', '']],
  ['only the machine License key', { LicenseShortName: null, License: 'cc-by-4.0', LicenseUrl: 'https://creativecommons.org/licenses/by/4.0' }, ['by', '4.0', 'CC BY 4.0', 'https://creativecommons.org/licenses/by/4.0']],
];
for (const [name, meta, [license, version, licName, url]] of COMMONS_LICENCES) {
  test(`Commons licence accepted: ${name}`, async () => {
    const o = await one(Q_FAMILY, N8N.default_429, cmPages(cmRec(1, { meta })));
    assert.ok(o.image, o.image_error);
    assert.deepEqual([o.image.license, o.image.license_version, o.image.license_name, o.image.license_url], [license, version, licName, url]);
    assert.equal(o.image.attribution_required, license === 'by' || license === 'by-sa');
  });
}

const COMMONS_REJECTS = [
  ['GFDL only', { meta: { LicenseShortName: 'GFDL', License: null, LicenseUrl: GFDL_URL, UsageTerms: 'GNU Free Documentation License' } }, 'licence'],
  ['FAL', { meta: { LicenseShortName: 'FAL', License: null, LicenseUrl: 'http://artlibre.org/licence/lal/en', UsageTerms: 'Free Art License' } }, 'licence'],
  ['{{Attribution}}', { meta: { LicenseShortName: 'Attribution', License: null, LicenseUrl: null, UsageTerms: 'Attribution' } }, 'licence'],
  ['Flickr Commons "No restrictions"', { meta: { LicenseShortName: 'No restrictions', License: null, LicenseUrl: 'https://www.flickr.com/commons/usage/', UsageTerms: 'No known copyright restrictions' } }, 'licence'],
  ['CC BY-NC-SA 2.0', { meta: { LicenseShortName: 'CC BY-NC-SA 2.0', License: null, LicenseUrl: 'https://creativecommons.org/licenses/by-nc-sa/2.0' } }, 'licence'],
  ['CC BY-ND 4.0', { meta: { LicenseShortName: 'CC BY-ND 4.0', License: null, LicenseUrl: 'https://creativecommons.org/licenses/by-nd/4.0' } }, 'licence'],
  ['CC SA 1.0 (parsed by Commons, not allowed here)', { meta: { LicenseShortName: 'CC SA 1.0', License: 'cc-sa-1.0', LicenseUrl: 'https://creativecommons.org/licenses/sa/1.0' } }, 'licence'],
  ['no licence fields at all', { meta: { LicenseShortName: null, License: null, LicenseUrl: null, UsageTerms: null } }, 'licence'],
  ['NonFree flag', { meta: { NonFree: 'true' } }, 'licence'],
  ['short name and machine key disagree', { meta: { License: 'cc-by-4.0' } }, 'licence'],
  ['LicenseUrl is NC', { meta: { LicenseUrl: 'https://creativecommons.org/licenses/by-nc-sa/4.0' } }, 'licence'],
  ['CC short name with a GNU LicenseUrl', { meta: { LicenseUrl: GFDL_URL } }, 'licence'],
  ['UsageTerms says NonCommercial', { meta: { UsageTerms: 'Creative Commons Attribution-NonCommercial-ShareAlike 4.0' } }, 'licence'],
  ['Restrictions personality', { meta: { Restrictions: 'personality' } }, 'personality'],
  ['Restrictions personality|trademarked', { meta: { Restrictions: 'personality|trademarked' } }, 'personality'],
  ['GIF', { page: { title: 'File:Rolex Submariner Date 126610LN.gif' }, info: { mime: 'image/gif' } }, 'file type'],
  ['PDF', { page: { title: 'File:Rolex Submariner Date 126610LN manual.pdf' }, info: { mime: 'application/pdf' } }, 'file type'],
  ['DjVu', { page: { title: 'File:Rolex Submariner Date 126610LN catalogue.djvu' }, info: { mime: 'image/vnd.djvu' } }, 'file type'],
  ['video', { page: { title: 'File:Rolex Submariner Date 126610LN.webm' }, info: { mime: 'video/webm' } }, 'file type'],
  ['JPEG name but TIFF mime', { info: { mime: 'image/tiff' } }, 'file type'],
  ['640 px wide', { info: { width: 640, height: 480 } }, 'too small'],
  ['aspect 3:1', { info: { width: 6000, height: 2000 } }, 'aspect'],
  ['"counterfeit" category', { meta: { Categories: 'Counterfeit watches|Rolex Submariner Date' } }, 'excluded term'],
  ['"replica" in the description', { meta: { ImageDescription: 'A replica of the Rolex Submariner Date 126610LN' } }, 'excluded term'],
  ['missing file (no imageinfo)', { page: { imagerepository: '', imageinfo: undefined } }, 'no file info'],
  ['no description URLs', { info: { descriptionurl: undefined, descriptionshorturl: undefined } }, 'missing url'],
  ['no file URL', { info: { url: undefined } }, 'missing url'],
];
for (const [name, patch, category] of COMMONS_REJECTS) {
  test(`Commons hard filter rejects: ${name}`, async () => {
    const o = await one(Q_FAMILY, N8N.default_429, cmPages(cmRec(1, patch)));
    assert.equal(o.image, null);
    assert.equal(o.image_error, `no licence-safe relevant photo found for 1 query; openverse: 1x HTTP 429; commons: 1 result in 1 search, 0 passed (${category} 1)`);
  });
}

test('Commons fixture pages each fail for the documented reason (TIFF, small, GFDL, personality, logo)', async () => {
  for (const [index, category] of [[10, 'file type'], [6, 'too small'], [4, 'licence'], [8, 'personality'], [9, 'excluded term']]) {
    const o = await one(Q_FAMILY, N8N.default_429, cmPages(cmRec(index)));
    assert.match(o.image_error, new RegExp(`0 passed \\(${category} 1\\)$`), `index ${index}`);
  }
  const svg = await one(Q_FAMILY, N8N.default_429, 'search-rolex-watch-no-filetype.json');
  assert.match(svg.image_error, /commons: 2 results in 1 search, 0 passed \(file type 2\)$/);
});

test('Commons "trademarked" alone is fine for product photos', async () => {
  const o = await one(Q_FAMILY, N8N.default_429, cmPages(cmRec(1, { meta: { Restrictions: 'trademarked' } })));
  assert.equal(o.image.id, '148213907');
});

const COMMONS_CREATORS = [
  ['no Artist on CC BY 3.0 (index 11)', cmRec(11), ['Unknown author', ''], true],
  ['Artist boilerplate', cmRec(1, { meta: { Artist: 'This file is lacking author information.' } }), ['Unknown author', ''], true],
  ['red link to a user page', cmRec(1, { meta: { Artist: cmRec(6).imageinfo[0].extmetadata.Artist.value } }), ['Diver1987', 'https://commons.wikimedia.org/wiki/User:Diver1987'], false],
  ['"The original uploader was X at English Wikipedia."', cmRec(1, { meta: { Artist: cmRec(4).imageinfo[0].extmetadata.Artist.value } }), ['Tickticktock at English Wikipedia', 'https://en.wikipedia.org/wiki/User:Tickticktock'], false],
  ['Flickr profile link', cmRec(2), ['chronoshots', 'https://www.flickr.com/people/41894170373@N01'], false],
  ['entities and nested markup', cmRec(1, { meta: { Artist: '<span class="fn"><a href="//commons.wikimedia.org/wiki/User:M%C3%BCller" title="User:Müller">J&#252;rgen M&uuml;ller &amp; Co</a></span>' } }), ['Jürgen M&uuml;ller & Co', 'https://commons.wikimedia.org/wiki/User:M%C3%BCller'], false],
];
for (const [name, page, [creator, url], penalised] of COMMONS_CREATORS) {
  test(`Commons creator: ${name}`, async () => {
    const o = await one(Q_FAMILY, N8N.default_429, cmPages(page));
    assert.deepEqual([o.image.creator, o.image.creator_url], [creator, url]);
    assert.equal(o.image.reasons.includes('-10 creator unknown'), penalised);
  });
}

test('Commons public domain with unknown author: no penalty, credit without "by"', async () => {
  const o = await one(Q_FAMILY, N8N.default_429, cmPages(cmRec(7)));
  assert.equal(o.image.creator, 'Unknown author');
  assert.equal(o.image.credit_text, 'Photo: "US Navy diver wearing Rolex Submariner 5513, 1972" (Public domain), via Wikimedia Commons');
  assert.deepEqual([o.image.license, o.image.license_name, o.image.license_url, o.image.attribution_required], ['pdm', 'Public domain', '', false]);
  // 1800 px wide: the original file, real size (thumbwidth 1920 in the API answer is NOT the pixel size)
  assert.match(o.image.file_url, /^https:\/\/upload\.wikimedia\.org\/wikipedia\/commons\/2\/2e\/US_Navy_diver_wearing_Rolex_Submariner_5513%2C_1972\.jpg\?utm_/);
  assert.deepEqual([o.image.width, o.image.height], [1800, 1350]);
});

test('Commons thumbnail: a 3840 px API thumb (iiurlwidth=2000) is replaced by a built 1920 px one', async () => {
  const page = cmRec(1, { info: { thumburl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4c/Rolex_Submariner_Date_126610LN.jpg/3840px-Rolex_Submariner_Date_126610LN.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail' } });
  const o = await one(Q_FAMILY, N8N.default_429, cmPages(page));
  assert.equal(o.image.file_url, 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4c/Rolex_Submariner_Date_126610LN.jpg/1920px-Rolex_Submariner_Date_126610LN.jpg');
  assert.deepEqual([o.image.width, o.image.height], [1920, 1440]);
});

// --- Relevance per level -------------------------------------------------------------------------------------
const fam = (brand, model_family, model = model_family) => query(`${brand} ${model_family}`, 'family', { brand, model_family, model, reference: '' });
const lvl = (brand, level) => query(level === 'generic' ? 'luxury wristwatch' : `${brand} watch`, level, { brand: level === 'generic' ? '' : brand });
const RELEVANCE = [
  // [name, query, title, human tags, passes]
  ['family: brand + family', Q_FAMILY, 'Rolex Submariner', [], true],
  ['family: upper case', Q_FAMILY, 'ROLEX SUBMARINER', [], true],
  ['family: no brand', Q_FAMILY, 'Submariner', [], false],
  ['family: other model of the brand', Q_FAMILY, 'Rolex Datejust', [], false],
  ['family: partial family word', Q_FAMILY, 'Rolex Sub', [], false],
  ['family: concatenated Flickr tag', Q_FAMILY, 'IMG_1234', ['rolexsubmariner'], true],
  ['model without family: all model tokens', query('Rolex Datejust 41', 'model', { model_family: '', model: 'Datejust 41', reference: '' }), 'Rolex Datejust 41', [], true],
  ['model without family: wrong size', query('Rolex Datejust 41', 'model', { model_family: '', model: 'Datejust 41', reference: '' }), 'Rolex Datejust 36', [], false],
  ['multi-word brand: full name', fam('Audemars Piguet', 'Royal Oak'), 'Audemars Piguet Royal Oak 15500', [], true],
  ['multi-word brand: short name AP', fam('Audemars Piguet', 'Royal Oak'), 'AP Royal Oak Jumbo', [], true],
  ['multi-word brand: one distinctive word', fam('Audemars Piguet', 'Royal Oak'), 'Piguet Royal Oak', [], true],
  ['multi-word brand: missing', fam('Audemars Piguet', 'Royal Oak'), 'Royal Oak tree', [], false],
  ['brand level: two-letter short name is not enough', lvl('Audemars Piguet', 'brand'), 'AP watch', [], false],
  ['brand level: longer short name', lvl('Audemars Piguet', 'brand'), 'Audemars watch on the wrist', [], true],
  ['Grand Seiko: plain Seiko is another brand', lvl('Grand Seiko', 'brand'), 'Seiko Presage watch', [], false],
  ['Grand Seiko: full name', lvl('Grand Seiko', 'brand'), 'Grand Seiko SBGA211 watch', [], true],
  ['Grand Seiko: GS with the family', fam('Grand Seiko', 'Heritage'), 'GS Heritage SBGA211', [], true],
  ['Patek Philippe: Patek', fam('Patek Philippe', 'Nautilus'), 'Patek Nautilus 5711', [], true],
  ['Patek Philippe: Philippe alone', fam('Patek Philippe', 'Nautilus'), 'Philippe Nautilus', [], false],
  ['Jaeger-LeCoultre: hyphenated', fam('Jaeger-LeCoultre', 'Reverso'), 'Jaeger-LeCoultre Reverso Tribute', [], true],
  ['Jaeger-LeCoultre: JLC', fam('Jaeger-LeCoultre', 'Reverso'), 'JLC Reverso', [], true],
  ['Jaeger-LeCoultre: LeCoultre', fam('Jaeger-LeCoultre', 'Reverso'), 'LeCoultre Reverso', [], true],
  ['TAG Heuer: Heuer', fam('TAG Heuer', 'Monaco'), 'Heuer Monaco 1133B', [], true],
  ['TAG Heuer: TAG is a common word', fam('TAG Heuer', 'Monaco'), 'TAG Monaco', [], false],
  ['diacritics: Soehne for Söhne', fam('A. Lange & Söhne', 'Lange 1'), 'A. Lange & Soehne Lange 1', [], true],
  ['diacritics: Söhne in the photo', fam('A. Lange & Söhne', 'Zeitwerk'), 'A. Lange & Söhne Zeitwerk', [], true],
  ['diacritics: Glashuette for Glashütte', fam('Glashütte Original', 'Senator'), 'Glashuette Original Senator Excellence', [], true],
  ['diacritics: another Glashütte brand', fam('Glashütte Original', 'Senator'), 'Nomos Glashütte Tangente', [], false],
  ['diacritics: accent in the photo title', fam('Breguet', 'Classique'), 'Bréguet Classique 5177', [], true],
  ['generic: wristwatch', Q_GENERIC, 'Luxury wristwatch', [], true],
  ['generic: no watch word', Q_GENERIC, 'Steel bracelet on velvet', [], false],
  ['generic: concatenated tag', Q_GENERIC, 'Ocean blue', ['divewatch'], true],
  ['generic: chronograph', Q_GENERIC, 'Chronograph close-up', [], true],
  ['generic: "moonwatch" contains watch', Q_GENERIC, 'Moonwatch on the wrist', [], true],
  ['generic: a scuba diver is not a watch', Q_GENERIC, 'Scuba diver off Cozumel', [], false],
  ['generic: watchtower', Q_GENERIC, 'Old watchtower at dusk', [], false],
  ['generic: birdwatching', Q_GENERIC, 'Birdwatching', ['birdwatching'], false],
  ['ambiguous brand: Omega Centauri is not an Omega Constellation', fam('Omega', 'Constellation'), 'Omega Centauri in the constellation Centaurus', [], false],
  ['ambiguous brand: with a watch word', fam('Omega', 'Constellation'), 'Omega Constellation watch', [], true],
  ['ambiguous brand: a tag naming brand + family', fam('Omega', 'Constellation'), 'Omega Constellation 1952', ['omegaconstellation'], true],
  ['ambiguous brand: no watch evidence', fam('Omega', 'Constellation'), 'Omega Constellation 1952', [], false],
  ['ambiguous brand at brand level: nebula', lvl('Omega', 'brand'), 'Omega Nebula', [], false],
  ['ambiguous brand at brand level: watch', lvl('Omega', 'brand'), 'Omega watch', [], true],
  ['ambiguous brand at brand level: Tudor rose', lvl('Tudor', 'brand'), 'Tudor rose', [], false],
];
for (const [name, q, title, tags, passes] of RELEVANCE) {
  test(`relevance (${q.level}): ${name}`, async () => {
    const o = await one(q, ovPage(ovRec(OV_BASE, { title, tags: flickrTags(...tags) })));
    if (passes) assert.ok(o.image, o.image_error);
    else assert.match(o.image_error, /0 passed \(not relevant 1\)/);
  });
}

test('brand level without a watch word passes with -10 (Commons pages often say only "Rolex Datejust")', async () => {
  const o = await one(Q_BRAND, ovPage(ovRec(OV_BASE, { title: 'Rolex Datejust', tags: flickrTags('rolex') })));
  assert.ok(o.image.reasons.includes('-10 no watch word'));
  assert.equal(o.image.alt_text, 'Rolex watch');
});

// --- Scoring and choice ----------------------------------------------------------------------------------------
test('score parts: model tokens, reference, width, landscape, provider', async () => {
  const cases = [
    [Q_MODEL, ovRec(0), 43, ['+20 model tokens present', '+15 reference 126610LN', '+5 landscape', '+3 openverse']],
    [Q_FAMILY, ovRec(2), 8, ['+5 landscape', '+3 openverse']],
    [Q_FAMILY, ovRec(3), 3, ['+3 openverse']], // square: no landscape bonus
    [Q_FAMILY, ovRec(11), -12, ['+10 width >= 1600', '+5 landscape', '+3 openverse', '-15 negative term box', '-15 negative term papers']],
    [Q_FAMILY, ovRec(12), 28, ['+20 model tokens present', '+10 width >= 1600', '+5 landscape', '+3 openverse', '-10 creator unknown']],
    [Q_FAMILY, ovRec(6), -7, ['+3 openverse', '-10 unknown dimensions']],
  ];
  for (const [q, rec, score, reasons] of cases) {
    const o = await one(q, ovPage(rec));
    assert.deepEqual([o.image.score, o.image.reasons], [score, reasons], rec.title);
  }
});

test('negative terms count once each and also match categories and plurals', async () => {
  const o = await one(Q_FAMILY, N8N.default_429, cmPages(cmRec(5)));
  assert.deepEqual(o.image.reasons, ['+20 model tokens present', '+10 width >= 1600', '+5 landscape', '-15 negative term box', '-15 negative term papers']);
});

test('choice is lexicographic: a weak photo for query 0 beats a perfect one for query 1', async () => {
  const { json: [o] } = await run({
    posts: [post([Q_MODEL, Q_FAMILY])],
    openverse: { 'Rolex Submariner Date': ovPage(ovRec(6)), 'Rolex Submariner': 'search-rolex-submariner-date.json' },
  });
  assert.deepEqual([o.image.id, o.image.query.rank, o.image.score], ['5b0bc14f-9c05-5991-8d32-e591a1d9ebf8', 0, -7]);
  assert.equal(o.alternates[0].score, 53);
});

test('within one query the higher score wins; equal scores keep the API order', async () => {
  const o = await one(Q_FAMILY, ovPage(ovRec(2), ovRec(3), ovRec(12)));
  assert.deepEqual([o.image, ...o.alternates].map(a => a.score), [28, 8, 3]);
  const tie = await one(Q_FAMILY, ovPage(ovRec(2), ovRec(2, { id: 'second', url: 'https://live.staticflickr.com/1/999_ab_b.jpg', foreign_landing_url: 'https://www.flickr.com/photos/x/999', title: 'Rolex Submariner steel' })));
  assert.deepEqual([tie.image.id, tie.alternates[0].id], [ovRec(2).id, 'second']);
});

test('dedupe: Flickr photo and its Flickr2Commons copy on Commons (Flickr id in title and Credit)', async () => {
  const o = await one(Q_MODEL, ovPage(ovRec(0)), cmPages(cmRec(2)));
  assert.deepEqual([o.image.provider, o.image.id, o.alternates.length], ['commons', '150337412', 0]);
});

test('dedupe: a legacy Openverse row ("File:...jpg" title) and the Commons page; the better-scored copy stays', async () => {
  const o = await one(Q_FAMILY, ovPage(ovRec(11)), cmPages(cmRec(5)));
  assert.deepEqual([o.image.provider, o.image.id, o.image.score, o.alternates.length], ['commons', '67324118', 5, 0]);
  const ovOnly = await one(Q_FAMILY, ovPage(ovRec(11)));
  assert.equal(ovOnly.image.title, 'Rolex Submariner 16610 with box and papers', 'File: prefix and extension removed');
});

test('dedupe: the same photo found by two queries is listed once, under the better rank', async () => {
  const { json: [o] } = await run({ posts: [post([Q_MODEL, Q_FAMILY])], openverse: OV_MAP });
  const ids = [o.image, ...o.alternates].map(a => a.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual([o.image, ...o.alternates].map(a => a.query.rank), [0, 0, 0, 1]);
});

test('dedupe: different URLs, same title and size', async () => {
  const twin = ovRec(2, { id: 'mirror', url: 'https://mirror.example.org/rolex-submariner.jpg', foreign_landing_url: 'https://mirror.example.org/p/1' });
  const o = await one(Q_FAMILY, ovPage(ovRec(2), twin));
  assert.equal(o.alternates.length, 0);
});

// --- Recently used photos (workflow static data) -------------------------------------------------------------
const seeded = recent => ({ liveRunIds: { 'run-1': '2026-10-01T00:00:00.000Z' }, imageFinder: { recent } });

test('recently used photo gets -40 and loses its rank to the next best; static data records the new choice', async () => {
  const staticData = seeded([{ key: 'commons:148213907', at: '2026-10-01T00:00:00.000Z' }]);
  const { json: [o] } = await run({ posts: [post(ALL4)], openverse: OV_MAP, commons: CM_MAP, staticData });
  assert.equal(o.image.id, 'd3e4d1e1-c069-5080-b265-b206da47bdea');
  assert.deepEqual(o.alternates.map(a => [a.id.slice(0, 8), a.score]), [['149d8686', 28], ['ed296e8f', 13], ['34418877', 35]]);
  assert.equal(o.alternates[1].reasons.at(-1), '-40 recently used');
  const recent = staticData.imageFinder.recent;
  assert.equal(recent.length, 2);
  assert.equal(recent[1].key, 'commons:150337412');
  assert.ok(recent[1].keys.includes('flickr:53218846721'));
  assert.match(recent[1].at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.deepEqual(staticData.liveRunIds, { 'run-1': '2026-10-01T00:00:00.000Z' }, "Watch Centro's own static data is untouched");
});

test('recently used: matched through any key (a bare Flickr id string entry)', async () => {
  const staticData = seeded(['flickr:53218846721']);
  const o = await one(Q_MODEL, ovPage(ovRec(0), ovRec(2)), undefined, { staticData });
  assert.equal(o.image.id, ovRec(2).id);
  assert.deepEqual([o.alternates[0].score, o.alternates[0].reasons.at(-1)], [3, '-40 recently used']);
});

test('recently used never beats rank: the only photo of query 0 is still chosen', async () => {
  const staticData = seeded([{ key: 'commons:148213907', at: 'x' }, { key: 'x:1', at: 'x' }]);
  const { json: [o] } = await run({
    posts: [post([Q_MODEL, Q_FAMILY])], openverse: { 'Rolex Submariner Date': ovPage(ovRec(1)), 'Rolex Submariner': ovPage(ovRec(2)) }, staticData,
  });
  assert.deepEqual([o.image.id.slice(0, 8), o.image.score], ['ed296e8f', 13]);
  assert.deepEqual(staticData.imageFinder.recent.map(r => r.key), ['x:1', 'commons:148213907'], 'moved to the end, not duplicated');
});

test(`recent list is trimmed to RECENT_LIMIT (30), oldest first out`, async () => {
  const staticData = seeded(Array.from({ length: 30 }, (_, i) => ({ key: 'old:' + i, at: 'x' })));
  await one(Q_FAMILY, ovPage(ovRec(2)), undefined, { staticData });
  const keys = staticData.imageFinder.recent.map(r => r.key);
  assert.equal(keys.length, 30);
  assert.deepEqual([keys[0], keys.at(-1)], ['old:1', 'flickr:52790466118']);
});

test('RECENT_LIMIT is a config constant', async () => {
  const staticData = seeded([{ key: 'a', at: 'x' }, { key: 'b', at: 'x' }]);
  await pipeline({ posts: [post([Q_FAMILY])], openverse: () => ovPage(ovRec(2)), staticData, code: setConst(PICK_CODE, 'RECENT_LIMIT', '2') });
  assert.deepEqual(staticData.imageFinder.recent.map(r => r.key), ['b', 'flickr:52790466118']);
});

const BAD_STATIC = [
  ['imageFinder is a string', { imageFinder: 'oops' }],
  ['recent is an object', { imageFinder: { recent: {} } }],
  ['recent has junk entries', { imageFinder: { recent: [null, 5, ['x'], { key: 7 }, { at: 'x' }] } }],
];
for (const [name, staticData] of BAD_STATIC) {
  test(`static data repaired, never fatal: ${name}`, async () => {
    const o = await one(Q_FAMILY, ovPage(ovRec(2)), undefined, { staticData });
    assert.ok(o.image);
    assert.ok(Array.isArray(staticData.imageFinder.recent));
    assert.equal(staticData.imageFinder.recent.at(-1).key, 'flickr:52790466118');
  });
}

test('without $getWorkflowStaticData the pick still works (nothing is remembered)', async () => {
  const o = await one(Q_FAMILY, ovPage(ovRec(2)), undefined, { staticData: undefined });
  assert.ok(o.image);
});

test('two posts in one run do not get the same photo', async () => {
  const { json } = await run({ posts: [post([Q_MODEL]), post([Q_MODEL])], openverse: OV_MAP });
  assert.deepEqual(json.map(o => o.image.id.slice(0, 8)), ['ed296e8f', 'd3e4d1e1']);
});

// --- Provider errors and odd responses ------------------------------------------------------------------------
const OV_ERRORS = [
  ['HTTP 429 (default options)', N8N.default_429, 'HTTP 429'],
  ['HTTP 500 (default options)', N8N.default_500, 'HTTP 500'],
  ['timeout', N8N.default_timeout, 'timeout'],
  ['connection reset', N8N.default_reset, 'ECONNRESET'],
  ['HTTP 429 (neverError + fullResponse)', N8N.full_response_429, 'HTTP 429'],
  ['HTTP 500 (neverError + fullResponse)', N8N.full_response_500, 'HTTP 500'],
  ['SSRF protection', N8N.ssrf_blocked, 'blocked by SSRF protection'],
  ['invalid JSON body', N8N.invalid_json, 'invalid JSON'],
  ['throttle body without status (neverError only)', OV('error-429-throttled.json'), 'HTTP 429'],
  ['401 body without status', OV('error-401-invalid-token.json'), 'API error: Incorrect authentication credentials.'],
  ['status only in the message', { error: { message: '404 - "Not Found"', name: 'AxiosError', code: 'ERR_BAD_REQUEST' } }, 'HTTP 404'],
  ['n8n NodeApiError style httpCode', { error: { message: 'Bad gateway', httpCode: '502' } }, 'HTTP 502'],
  ['null json', null, 'empty response'],
  ['empty object', {}, 'unexpected response'],
];
for (const [name, json, label] of OV_ERRORS) {
  test(`Openverse error item -> search_log error "${label}": ${name}`, async () => {
    const o = await one(Q_FAMILY, json, 'search-rolex-submariner.json');
    assert.deepEqual(o.search_log[0], { rank: 0, q: 'Rolex Submariner', provider: 'openverse', status: 'error', http_error: label, results: 0, passed: 0 });
    assert.equal(o.image.provider, 'commons', 'Commons still searched');
    assert.doesNotMatch(JSON.stringify(o), /AxiosError|axios\.cjs|node_modules/, 'no stack traces in the output');
  });
}

const CM_ERRORS = [
  ['maxlag (HTTP 200)', CM('error-maxlag.json'), 'API maxlag'],
  ['CirrusSearch backend error', CM('error-generic.json'), 'API cirrussearch-backend-error'],
  ['internal error', CM('error-internal.json'), 'API internal_api_error_DBQueryError'],
  ['urlparamnormal', CM('error-urlparamnormal.json'), 'API urlparamnormal'],
  ['HTTP 503 HTML page (default options)', N8N.default_commons_503_html, 'HTTP 503'],
  ['maxlag (neverError + fullResponse)', N8N.full_response_commons_maxlag, 'API maxlag'],
  ['HTTP 503 HTML page (neverError + fullResponse)', N8N.full_response_commons_503_html, 'HTTP 503'],
  ['edge 403 User-Agent policy', { error: { message: '403 - "Please set a user-agent and respect our robot policy https://w.wiki/4wJS."', name: 'AxiosError', code: 'ERR_BAD_REQUEST', status: 403 } }, 'HTTP 403'],
  ['HTML body without status', { data: '<!DOCTYPE html><title>Wikimedia Error</title>' }, 'non-JSON response'],
];
for (const [name, json, label] of CM_ERRORS) {
  test(`Commons error item -> search_log error "${label}": ${name}`, async () => {
    const o = await one(Q_FAMILY, 'search-rolex-submariner.json', json);
    assert.deepEqual(o.search_log[1], { rank: 0, q: 'Rolex Submariner', provider: 'commons', status: 'error', http_error: label, results: 0, passed: 0 });
    assert.equal(o.image.provider, 'openverse');
  });
}

test('both providers fail: image_error counts the errors per provider', async () => {
  const { json: [o] } = await run({
    posts: [post(ALL4)], openverse: (s, k) => (k < 3 ? N8N.default_429 : N8N.default_timeout), commons: () => CM('error-maxlag.json'),
  });
  assert.equal(o.image, null);
  assert.equal(o.image_error, 'no licence-safe relevant photo found for 4 queries; openverse: 3x HTTP 429, 1x timeout; commons: 4x API maxlag');
});

test('empty answers are "ok" with 0 results (Openverse page, Commons {batchcomplete}, fullResponse wrapper)', async () => {
  for (const [ov, cm] of [['search-empty.json', 'search-empty.json'], [N8N.full_response_openverse_empty, { batchcomplete: true, warnings: { main: { warnings: 'x' } } }]]) {
    const o = await one(Q_FAMILY, ov, cm);
    assert.deepEqual(o.search_log.map(e => [e.status, e.results]), [['ok', 0], ['ok', 0]]);
    assert.equal(o.image_error, 'no licence-safe relevant photo found for 1 query; openverse: 0 results in 1 search, 0 passed; commons: 0 results in 1 search, 0 passed');
  }
});

test('Commons answer with a continue block is read as one page', async () => {
  const o = await one(Q_FAMILY, N8N.default_429, 'search-rolex-watch-no-filetype.json');
  assert.deepEqual(o.search_log[1], { rank: 0, q: 'Rolex Submariner', provider: 'commons', status: 'ok', results: 2, passed: 0 });
});

const SKIPPED = [
  ['Openverse node not executed', { nodes: { [OPENVERSE_NODE]: { items: [], executed: false } } }, 'openverse'],
  ['Commons node not executed', { nodes: { [COMMONS_NODE]: { items: [], executed: false } } }, 'commons'],
  ['Openverse node disabled (passes the split item through)', { ovItems: splits => splits.map((s, k) => ({ json: s.json, pairedItem: { item: k } })) }, 'openverse'],
  ['Commons node disabled (passes the Openverse answer through)', { cmItems: (splits, ov) => ov.map((o, k) => ({ json: o.json, pairedItem: { item: k } })) }, 'commons'],
];
for (const [name, opts, provider] of SKIPPED) {
  test(`search_log "skipped": ${name}`, async () => {
    const { json: [o] } = await run({ posts: [post([Q_FAMILY])], openverse: OV_MAP, commons: CM_MAP, ...opts });
    const e = o.search_log.find(x => x.provider === provider);
    assert.deepEqual(e, { rank: 0, q: 'Rolex Submariner', provider, status: 'skipped', results: 0, passed: 0 });
    assert.ok(o.image, 'the other provider still counts');
  });
}

test('a query that lost its Openverse item (and so its Commons item) is "skipped" for both; later queries still count', async () => {
  const { json: [o] } = await run({
    posts: [post([Q_MODEL, Q_FAMILY])], openverse: OV_MAP, commons: CM_MAP,
    ovItems: splits => [{ json: OV('search-rolex-submariner.json'), pairedItem: { item: 1 } }],
    cmItems: (splits, ov) => ov.map((x, j) => ({ json: CM('search-rolex-submariner.json'), pairedItem: { item: j } })),
  });
  assert.deepEqual(o.search_log.map(e => [e.rank, e.provider, e.status]), [[0, 'openverse', 'skipped'], [0, 'commons', 'skipped'], [1, 'openverse', 'ok'], [1, 'commons', 'ok']]);
  assert.equal(o.image.query.rank, 1);
});

// --- Alignment and multiple posts -----------------------------------------------------------------------------
test('several posts: one output item per post, in order, each paired with its own search items', async () => {
  const { out } = await run({
    posts: [post(ALL4), post([Q_GENERIC], { post_title: 'Second' }), post([], { post_title: 'Third' })],
    openverse: OV_MAP, commons: CM_MAP,
  });
  assert.deepEqual(out.map(o => o.json.post_title), ['Watch market report', 'Second', 'Third']);
  assert.deepEqual(out.map(o => o.pairedItem), [[{ item: 0 }, { item: 1 }, { item: 2 }, { item: 3 }], [{ item: 4 }], []]);
  assert.equal(out[0].json.image.id.slice(0, 8), 'ed296e8f');
  assert.equal(out[1].json.image.id.slice(0, 8), '257ee03a');
  assert.deepEqual([out[2].json.image, out[2].json.image_error, out[2].json.search_log], [null, 'no image queries for this post', []]);
});

test('alignment survives shuffled search items (pairedItem is used, not the position)', async () => {
  const base = await run({ posts: [post(ALL4), post([Q_GENERIC])], openverse: OV_MAP, commons: CM_MAP });
  const respondOv = s => clone(OV(OV_MAP[s.q] || 'search-empty.json'));
  const respondCm = s => clone(CM(CM_MAP[s.q] || 'search-empty.json'));
  const shuffled = await run({
    posts: [post(ALL4), post([Q_GENERIC])],
    ovItems: splits => splits.map((s, k) => ({ json: respondOv(s.json), pairedItem: { item: k } })).reverse(),
    cmItems: (splits, ov) => ov.map((o, j) => ({ json: respondCm(splits[o.pairedItem.item].json), pairedItem: { item: j } })),
  });
  assert.deepEqual(shuffled.json.map(o => [o.image.id, o.alternates.map(a => a.id), o.search_log]), base.json.map(o => [o.image.id, o.alternates.map(a => a.id), o.search_log]));
});

test('alignment by position when pairedItem is missing (pinned data)', async () => {
  const strip = items => items.map(({ json }) => ({ json }));
  const r = await run({ posts: [post(ALL4)], openverse: OV_MAP, commons: CM_MAP });
  const out = await runCode(PICK_CODE, {
    input: strip(r.cm),
    nodes: { [BUILD_NODE]: [{ json: post(ALL4) }], [SPLIT_NODE]: strip(r.splits), [OPENVERSE_NODE]: strip(r.ov), [COMMONS_NODE]: strip(r.cm) },
    staticData: {},
  });
  assert.equal(out[0].json.image.id, r.json[0].image.id);
});

test('the real step-2 output feeds step 3 end to end (build queries -> split -> pick)', async () => {
  const posts = await runBuild([llmText([W_SUB])], [{ post_title: 'T', post_text: 'Traders liked the Rolex Submariner Date 126610LN.', source: { title: 'T' } }]);
  const { json: [o] } = await run({ posts: posts.map(p => p.json), openverse: OV_MAP, commons: CM_MAP });
  assert.equal(o.image.alt_text, 'Rolex Submariner Date watch');
  assert.deepEqual(o.source, { title: 'T' });
});

// --- Output formats -------------------------------------------------------------------------------------------
const ALT_CASES = [
  ['model', Q_MODEL, ovRec(0), 'Rolex Submariner Date watch'],
  ['family, photo shows the model', Q_FAMILY, ovRec(0), 'Rolex Submariner Date watch'],
  ['family, photo does not show the model', Q_FAMILY, ovRec(2), 'Rolex Submariner watch'],
  ['brand', Q_BRAND, ovRec(2, { title: 'Rolex watch' }), 'Rolex watch'],
  ['generic', Q_GENERIC, OV('search-luxury-wristwatch.json').results[0], 'Luxury wristwatch'],
  ['model without its family in the name', query('Rolex GMT-Master II Pepsi', 'model', { model_family: 'GMT-Master II', model: 'Pepsi', reference: '' }), ovRec(2, { title: 'Rolex GMT-Master II Pepsi' }), 'Rolex GMT-Master II Pepsi watch'],
  ['model already ending in "watch"', query('Rolex Submariner Date', 'model', { model: 'Submariner Date Watch' }), ovRec(0, { title: 'Rolex Submariner Date Watch 126610LN' }), 'Rolex Submariner Date Watch'],
];
for (const [name, q, rec, alt] of ALT_CASES) {
  test(`alt_text (${name}): "${alt}"`, async () => {
    const o = await one(q, ovPage(rec));
    assert.equal(o.image.alt_text, alt);
  });
}

test('credit_text: plain text, no URLs, no em dash, quotes made safe, long titles cut', async () => {
  const rec = ovRec(0, {
    title: 'Rolex Submariner Date \u2014 "the 126610LN" see https://example.com/x and www.example.org ' + 'very '.repeat(40),
    creator: 'Jane \u2013 Doe <b>Photo</b>',
  });
  const o = await one(Q_MODEL, ovPage(rec));
  const c = o.image.credit_text;
  assert.match(c, /^Photo: "Rolex Submariner Date - 'the 126610LN' see and .*\.\.\." by Jane - Doe Photo, CC BY 2\.0, via Flickr$/);
  assert.ok(c.length < 260);
  assert.doesNotMatch(o.image.title + o.image.creator, /\u2014/);
});

test('credit_text without a title, and with a jurisdiction port', async () => {
  const o = await one(Q_FAMILY, ovPage(ovRec(2, { title: '', tags: flickrTags('rolex', 'submariner'), license: 'by-sa', license_version: '3.0', license_url: 'https://creativecommons.org/licenses/by-sa/3.0/de/', creator: 'Kronograph' })));
  assert.equal(o.image.credit_text, 'Photo by Kronograph, CC BY-SA 3.0 DE, via Flickr');
});

test('download_filename: ASCII slug of the alt text + provider + id + extension, at most 80 characters', async () => {
  const lange = fam('A. Lange & Söhne', 'Datograph Up/Down');
  const o = await one(lange, N8N.default_429, cmPages(cmRec(1, { page: { title: 'File:A. Lange & Söhne Datograph Up Down.jpg' } })));
  assert.equal(o.image.alt_text, 'A. Lange & Söhne Datograph Up/Down watch');
  assert.equal(o.image.download_filename, 'a-lange-sohne-datograph-up-down-watch-commons-148213907.jpg');
  const long = query('x', 'model', { brand: 'Vacheron Constantin', model_family: 'Overseas', model: 'Overseas Perpetual Calendar Ultra-Thin Skeleton Openworked Pink Gold Edition' });
  const rec = ovRec(2, { title: 'Vacheron Constantin Overseas Perpetual Calendar Ultra-Thin Skeleton Openworked Pink Gold Edition', url: 'https://live.staticflickr.com/1/2_3_b.png', filetype: 'png' });
  const o2 = await one(long, ovPage(rec));
  assert.equal(o2.image.download_filename.length, 80);
  assert.match(o2.image.download_filename, /^vacheron-constantin-overseas-perpetual-[a-z0-9-]+-openverse-a9e58ed61829\.png$/);
  const jpeg = await one(Q_FAMILY, ovPage(ovRec(2, { url: 'https://live.staticflickr.com/1/2_3_b.jpeg', filetype: 'jpeg' })));
  assert.match(jpeg.image.download_filename, /\.jpg$/);
  assert.equal(jpeg.image.extension, 'jpeg');
});

// --- Never throws -----------------------------------------------------------------------------------------------
const GARBAGE = [
  ['Openverse results with junk entries', { openverse: () => ({ results: [null, 5, 'x', [], {}, { url: 7 }, { title: { a: 1 }, tags: 'rolex' }] }) }],
  ['Openverse fields of the wrong type', { openverse: () => ovPage(ovRec(2, { width: '1024', height: '768', tags: [null, 'x', { name: 5 }], title: 42, creator: { x: 1 }, license_version: 2 })) }],
  ['Commons pages with junk', { commons: () => ({ batchcomplete: true, query: { pages: [null, 'x', 7, {}, { imageinfo: 'x' }, { imageinfo: [null] }, { imageinfo: [{ extmetadata: 'x' }] }, { title: ['x'], imageinfo: [{ extmetadata: { Artist: { value: ['x'] }, LicenseShortName: { value: 7 }, Restrictions: 5 } }] }] } }) }],
  ['Commons query.pages is a string', { commons: () => ({ query: { pages: 'x' } }) }],
  ['a huge title', { openverse: () => ovPage(ovRec(2, { title: 'Rolex Submariner ' + 'x'.repeat(100000) })) }],
  ['split items without fields', { nodes: { [SPLIT_NODE]: [{ json: null }, { json: { rank: 'x', post_index: -4 } }, {}] } }],
  ['build queries item json is null', { nodes: { [BUILD_NODE]: [{ json: null }] } }],
  ['static data getter returns junk', { staticData: null }],
];
for (const [name, opts] of GARBAGE) {
  test(`never throws on garbage: ${name}`, async () => {
    const r = await pipeline({ posts: [post([Q_FAMILY])], ...opts });
    assert.ok(r.out.length >= 1);
    for (const o of r.out) {
      assert.deepEqual(Object.keys(o.json), OUT_KEYS);
      assert.equal(typeof o.json.image_error, 'string');
    }
  });
}

test('never throws when no upstream node can be read (all $() calls fail)', async () => {
  const out = await runCode(PICK_CODE, { input: [], nodes: {}, staticData: {} });
  assert.deepEqual(out, []);
});
