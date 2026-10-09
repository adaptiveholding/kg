// Steps 5 and 6: "Image: hand back post" (the fragment's exit) and the credit line it adds, plus the one-line
// change to the real "WordPress: create draft" node.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { runCode, clone, setConst, readText } from './harness.mjs';
import {
  HANDBACK_CODE, N, WP, SOURCE, image, FLICKR_ALT, pickJson, confirmed, runHandBack, handBackSetup, creditHelpers,
  binaryOf, notRun, offPath, runPlan, runConfirm,
} from './step4-helpers.mjs';

const { safeUrl, creditHtml, creditBlock, esc, cleanText } = creditHelpers();
const SOURCE_KEYS = Object.keys(SOURCE);
const REPORT_KEYS = ['status', 'reason', 'media_id', 'source_url', 'credit_text', 'license_name', 'landing_url', 'provider',
  'photo_title', 'alt_text_set', 'licence_check', 'search_summary', 'extract_error'];
const CREDIT_148 = 'Photo: <a href="https://commons.wikimedia.org/w/index.php?curid=148213907">Rolex Submariner Date 126610LN</a> ' +
  'by <a href="https://commons.wikimedia.org/wiki/User:Horologium42">Horologium42</a>, ' +
  '<a href="https://creativecommons.org/licenses/by-sa/4.0">CC BY-SA 4.0</a>, via Wikimedia Commons.';
const BLOCK_148 = '<!-- wp:paragraph {"fontSize":"small"} -->\n<p class="has-small-font-size">' + CREDIT_148 + '</p>\n<!-- /wp:paragraph -->';

let CONF;
const conf = async () => (CONF ??= await confirmed());

// Not attached: the output is the source, untouched, plus image_report (no featured_media, same content).
function assertUntouched(o, status) {
  assert.deepEqual(Object.keys(o.json), [...SOURCE_KEYS, 'image_report']);
  for (const k of SOURCE_KEYS) assert.strictEqual(o.json[k], SOURCE[k], k);
  assert.ok(!('featured_media' in o.json));
  assert.deepEqual(Object.keys(o.json.image_report), REPORT_KEYS);
  assert.equal(o.json.image_report.status, status);
  assert.equal(o.json.image_report.media_id, null);
  assert.equal(o.binary, undefined, 'no binary is handed to create draft');
  assert.deepEqual(o.pairedItem, { item: 0 });
  assert.ok(!JSON.stringify(o.json).includes('—'));
  return o.json.image_report;
}
// Attached: every source field identical except content (credit appended), then featured_media and image_report.
function assertAttached(o, mediaId) {
  assert.deepEqual(Object.keys(o.json), [...SOURCE_KEYS, 'featured_media', 'image_report']);
  for (const k of SOURCE_KEYS) if (k !== 'content') assert.strictEqual(o.json[k], SOURCE[k], k);
  assert.strictEqual(o.json.featured_media, mediaId);
  assert.ok(o.json.content.startsWith(SOURCE.content + '\n\n'));
  assert.deepEqual(Object.keys(o.json.image_report), REPORT_KEYS);
  assert.equal(o.json.image_report.status, 'attached');
  assert.equal(o.json.image_report.media_id, mediaId);
  assert.equal(o.binary, undefined);
  assert.deepEqual(o.pairedItem, { item: 0 });
  assert.ok(!JSON.stringify(o.json).includes('—'));
  return o.json.image_report;
}

// --- Attached ---------------------------------------------------------------------------------------------------

test('(a) attached: featured_media from the upload, credit paragraph appended, all other fields byte-identical', async () => {
  const staticData = { liveRunIds: { r1: 'x' } };
  const [o] = await runHandBack(await conf(), { stage: 'alt', staticData });
  const r = assertAttached(o, 901);
  assert.equal(o.json.content, SOURCE.content + '\n\n' + BLOCK_148);
  assert.deepEqual(r, {
    status: 'attached', reason: '', media_id: 901,
    source_url: 'https://watchcentro.com/wp-content/uploads/2026/10/rolex-submariner-116610ln.jpg',
    credit_text: 'Photo: "Rolex Submariner Date 126610LN" by Horologium42, CC BY-SA 4.0, via Wikimedia Commons',
    license_name: 'CC BY-SA 4.0', landing_url: 'https://commons.wikimedia.org/w/index.php?curid=148213907', provider: 'openverse',
    photo_title: 'Rolex Submariner Date 126610LN', alt_text_set: true,
    licence_check: { status: 'confirmed', lookup: 'not needed', checked: [{ provider: 'openverse', id: 'ed296e8f-1cb3-5e22-825d-ddbd552c338c', result: 'used', reason: 'licence confirmed by the Commons search' }] },
    search_summary: 'openverse: 1 search, 1 ok, 4 results, 4 passed; commons: 1 search, 0 ok, 0 results, 0 passed, errors: 1x HTTP 503',
    extract_error: '',
  });
  // The photo is recorded as used for step 3's -40 penalty; the rest of the static data is untouched.
  assert.deepEqual(staticData.liveRunIds, { r1: 'x' });
  assert.equal(staticData.imageFinder.recent.length, 1);
  assert.deepEqual(staticData.imageFinder.recent[0].keys, image().recent_keys);
  assert.equal(staticData.imageFinder.recent[0].key, 'commons:148213907');
  assert.match(staticData.imageFinder.recent[0].at, /^\d{4}-\d\d-\d\dT/);
});

test('attached with neverError + fullResponse on the upload and alt text nodes', async () => {
  const altFull = { body: { ...WP.alt_200 }, headers: {}, statusCode: 200, statusMessage: 'OK' };
  const [o] = await runHandBack(await conf(), { stage: 'alt', upload: WP.full_upload_201, alt: altFull });
  const r = assertAttached(o, 902);
  assert.equal(r.source_url, 'https://watchcentro.com/wp-content/uploads/2026/10/ok.jpg');
  assert.equal(r.alt_text_set, true);
});

test('(e) the alt text update fails: the featured image and credit stay, the report says why', async () => {
  const cases = [
    [WP.alt_500, 'alt text and caption were not set: HTTP 500 internal_server_error: There has been a critical error on this website.; the featured image is attached'],
    [WP.upload_timeout, 'alt text and caption were not set: timeout; the featured image is attached'],
    [{ body: { code: 'rest_cannot_edit', message: 'Sorry, you are not allowed to edit this post.', data: { status: 403 } }, headers: {}, statusCode: 403 },
      'alt text and caption were not set: HTTP 403 rest_cannot_edit: Sorry, you are not allowed to edit this post.; the featured image is attached'],
  ];
  for (const [alt, reason] of cases) {
    const [o] = await runHandBack(await conf(), { stage: 'alt', alt });
    const r = assertAttached(o, 901);
    assert.equal(o.json.content, SOURCE.content + '\n\n' + BLOCK_148);
    assert.equal(r.alt_text_set, false);
    assert.equal(r.reason, reason);
  }
  // The alt text node did not run although the upload did (not wired): still attached.
  const { input, nodes } = handBackSetup(await conf(), { stage: 'alt' });
  nodes[N.alt] = notRun;
  const [o] = await runCode(HANDBACK_CODE, { input, nodes });
  assert.equal(assertAttached(o, 901).reason, 'alt text and caption were not set (the update did not run); the featured image is attached');
});

// --- Not attached -------------------------------------------------------------------------------------------------

test('(b) no photo found: the post is handed back unchanged with the search reason', async () => {
  const [p] = await runPlan([pickJson(null)]);
  const [c] = await runConfirm(p.json);
  const [o] = await runHandBack(c.json, { stage: 'no-photo' });
  const r = assertUntouched(o, 'no_image');
  assert.equal(r.reason, 'no licence-safe relevant photo found for 4 queries; openverse: 4x HTTP 429; commons: 0 results in 4 searches, 0 passed');
  assert.deepEqual([r.credit_text, r.license_name, r.landing_url, r.provider, r.alt_text_set], ['', '', '', '', null]);
  assert.deepEqual(o.json, { ...SOURCE, image_report: r });
});

test('(g) the watch extraction failed (Anthropic 500): no image, the report names the LLM error', async () => {
  const [p] = await runPlan([pickJson(image(), [], { watches: [] })], { build: [{ extract_error: 'Anthropic API error: HTTP 500' }] });
  const [c] = await runConfirm(p.json);
  const [o] = await runHandBack(c.json, { stage: 'no-photo' });
  const r = assertUntouched(o, 'no_image');
  assert.equal(r.reason, 'watch extraction failed (Anthropic API error: HTTP 500), so no photo is used');
  assert.equal(r.extract_error, 'Anthropic API error: HTTP 500');
});

test('(f) every candidate failed the Commons licence check: no image, reason per candidate', async () => {
  const [p] = await runPlan([pickJson(image())]);
  const [c] = await runConfirm(p.json, { batchcomplete: true, query: { pages: [{ pageid: 148213907, missing: true }] } });
  const [o] = await runHandBack(c.json, { stage: 'no-photo' });
  const r = assertUntouched(o, 'no_image');
  assert.equal(r.reason, 'no picked photo passed the Commons licence check: openverse ed296e8f-1cb3-5e22-825d-ddbd552c338c: file not found on Commons (Commons lookup)');
  assert.equal(r.licence_check.status, 'rejected');
  assert.equal(r.licence_check.lookup, 'ok');
});

test('(c) download failures: 404, timeout, not an image, too large, empty, no file', async () => {
  const cases = [
    [{ download: WP.download_404 }, 'download failed: HTTP 404 mock: only .jpg, .jpeg and .png files are generated'],
    [{ download: WP.download_timeout }, 'download failed: timeout'],
    [{ binary: { mimeType: 'text/html', fileType: 'html' } }, 'the download is not a JPEG, PNG or WebP image (text/html)'],
    [{ binary: { mimeType: 'image/svg+xml' } }, 'the download is not a JPEG, PNG or WebP image (image/svg+xml)'],
    [{ binary: { bytes: 15 * 1024 * 1024 + 1 } }, 'the photo is too large (15.0 MB, limit 15 MB)'],
    [{ binary: { bytes: 40 * 1024 * 1024 } }, 'the photo is too large (40.0 MB, limit 15 MB)'],
    [{ binary: { bytes: 0 } }, 'the download is empty or its size is unknown'],
    [{ binary: { bytes: undefined } }, 'the download is empty or its size is unknown'],
    [{ binary: null }, 'the download holds no file'],
  ];
  for (const [opts, reason] of cases) {
    const [o] = await runHandBack(await conf(), { stage: 'download', ...opts });
    const r = assertUntouched(o, 'failed');
    assert.equal(r.reason, reason, JSON.stringify(opts));
    assert.equal(r.credit_text, 'Photo: "Rolex Submariner Date 126610LN" by Horologium42, CC BY-SA 4.0, via Wikimedia Commons');
    assert.equal(r.landing_url, 'https://commons.wikimedia.org/w/index.php?curid=148213907');
  }
  // A 15 MB file and a PNG pass the check (the IF would send them on; here the upload then fails).
  for (const binary of [{ bytes: 15 * 1024 * 1024 }, { mimeType: 'image/png' }, { mimeType: 'image/webp' }]) {
    const [o] = await runHandBack(await conf(), { stage: 'upload', binary, upload: WP.upload_401 });
    assert.match(o.json.image_report.reason, /^upload to WordPress failed: HTTP 401/);
  }
});

test('(d) upload failures: 401, 403, 413 (nginx HTML), timeout, refused, no binary, no media id', async () => {
  const cases = [
    [WP.upload_401, 'HTTP 401 rest_cannot_create: Sorry, you are not allowed to upload files as this user.'],
    [WP.upload_403, 'HTTP 403 rest_cannot_create: Sorry, you are not allowed to upload files as this user.'],
    [WP.upload_413, 'HTTP 413 Request Entity Too Large'],
    [WP.upload_timeout, 'timeout'],
    [WP.upload_refused, 'connection refused'],
    [WP.upload_no_binary, "This operation expects the node's input data to contain a binary file 'photo', but none was found [item 0]"],
    [WP.full_upload_401, 'HTTP 401 rest_cannot_create: Sorry, you are not allowed to upload files as this user.'],
    [WP.full_upload_413, 'HTTP 413 Request Entity Too Large'],
    [{ error: { message: 'Authorization failed - please check your credentials', name: 'NodeApiError', description: 'The provided password is an invalid application password.', cause: { name: 'AxiosError', message: '401 - "{\\"code\\":\\"incorrect_password\\",\\"message\\":\\"The provided password is an invalid application password.\\",\\"data\\":{\\"status\\":401}}"' } } },
      'HTTP 401 incorrect_password: The provided password is an invalid application password.'],
    [{ error: { message: 'The service was not able to process your request', name: 'NodeApiError', description: '<p>There has been a critical error on this website.</p>', cause: { name: 'AxiosError', message: '500 - "<p>broken</p>"' } } },
      'HTTP 500 There has been a critical error on this website.'],
  ];
  for (const [upload, label] of cases) {
    const [o] = await runHandBack(await conf(), { stage: 'upload', upload });
    const r = assertUntouched(o, 'failed');
    assert.equal(r.reason, 'upload to WordPress failed: ' + label);
  }
  for (const upload of [{ ...WP.upload_201, id: 'abc' }, { ...WP.upload_201, id: 0 }, { body: {}, statusCode: 201, headers: {} }]) {
    const [o] = await runHandBack(await conf(), { stage: 'upload', upload });
    assert.equal(assertUntouched(o, 'failed').reason, 'WordPress answered the upload without a media id');
  }
  // A media id given as a numeric string is accepted as an integer.
  const [o] = await runHandBack(await conf(), { stage: 'alt', upload: { ...WP.upload_201, id: '1234' } });
  assertAttached(o, 1234);
});

test('nothing is written to the static data unless the photo is attached; REMEMBER_USED and the limit', async () => {
  const staticData = { liveRunIds: { r1: 'x' } };
  await runHandBack(await conf(), { stage: 'upload', upload: WP.upload_401, staticData });
  await runHandBack(await conf(), { stage: 'download', download: WP.download_404, staticData });
  assert.deepEqual(staticData, { liveRunIds: { r1: 'x' } });
  // Dedupe by key, newest last, trimmed to RECENT_LIMIT.
  const recent = Array.from({ length: 30 }, (_, k) => ({ key: 'flickr:' + k, keys: ['flickr:' + k], at: 't' }));
  recent[3] = { key: 'commons:148213907', keys: ['commons:148213907'], at: 'old' };
  const sd = { imageFinder: { recent } };
  await runHandBack(await conf(), { stage: 'alt', staticData: sd });
  assert.equal(sd.imageFinder.recent.length, 30);
  assert.equal(sd.imageFinder.recent.filter(r => r.key === 'commons:148213907').length, 1);
  assert.equal(sd.imageFinder.recent.at(-1).key, 'commons:148213907');
  assert.notEqual(sd.imageFinder.recent.at(-1).at, 'old');
  const off = {};
  await runHandBack(await conf(), { stage: 'alt', staticData: off, code: setConst(HANDBACK_CODE, 'REMEMBER_USED', 'false') });
  assert.deepEqual(off, {});
  // No static data available (as in a sandbox without it): still attached.
  const [o] = await runHandBack(await conf(), { stage: 'alt' });
  assertAttached(o, 901);
});

// --- Credit line ----------------------------------------------------------------------------------------------------

test('credit block: same small-print paragraph markup as the Render WP blocks disclaimer', async () => {
  const open = '<!-- wp:paragraph {"fontSize":"small"} -->\n<p class="has-small-font-size">';
  const close = '</p>\n<!-- /wp:paragraph -->';
  // The real Render WP blocks output uses exactly this markup for its own small print.
  assert.ok(SOURCE.content.includes(open));
  assert.ok(SOURCE.content.endsWith(close));
  assert.ok(readText('test/fixtures/render-wp-blocks.js').includes('<!-- wp:paragraph {"fontSize":"small"} -->\\n<p class="has-small-font-size">'));
  const block = creditBlock(image());
  assert.equal(block, BLOCK_148);
  assert.ok(block.startsWith(open) && block.endsWith(close));
  // Content stays a balanced list of blocks.
  const [o] = await runHandBack(await conf(), { stage: 'alt' });
  const opens = o.json.content.match(/<!-- wp:paragraph[ {]/g).length;
  assert.equal(opens, o.json.content.match(/<!-- \/wp:paragraph -->/g).length);
  assert.equal(opens, SOURCE.content.match(/<!-- wp:paragraph[ {]/g).length + 1);
});

test('credit: every interpolated value is HTML-escaped (script tags, quotes, ampersands)', () => {
  const html = creditHtml(image({
    title: `"Sub" & 'Date' <b>bold</b>`,
    creator: '<script>alert("x")</script> & Sons',
    creator_url: 'https://example.org/u?a=1&b=2',
    license_name: 'CC BY 2.0"><script>x</script>',
    source_name: 'Flickr <img src=x onerror=alert(1)>',
    landing_url: 'https://example.org/p?x=1&y="2"',
  }));
  assert.equal(html,
    'Photo: &quot;Sub&quot; &amp; &#039;Date&#039; &lt;b&gt;bold&lt;/b&gt; by ' +
    '<a href="https://example.org/u?a=1&amp;b=2">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; Sons</a>, ' +
    '<a href="https://creativecommons.org/licenses/by-sa/4.0/">CC BY 2.0&quot;&gt;&lt;script&gt;x&lt;/script&gt;</a>, ' +
    'via Flickr &lt;img src=x onerror=alert(1)&gt;.');
  assert.doesNotMatch(html, /<script|<img|<b>/);
  // Only our own tags remain.
  assert.deepEqual([...new Set(html.match(/<\/?[a-z]+/g))].sort(), ['</a', '<a']);
});

test('credit: URLs are linked only when they are absolute http(s) URLs', () => {
  const ok = [
    'https://commons.wikimedia.org/w/index.php?curid=148213907', 'http://example.org', 'HTTPS://Example.org/a#b',
    'https://www.flickr.com/photos/41894170373@N01', 'https://127.0.0.1:18558/files/x.jpg', '  https://example.org/x  ',
    "https://commons.wikimedia.org/wiki/File:Rolex_'Hulk'.jpg",
  ];
  for (const u of ok) assert.equal(safeUrl(u), u.trim(), u);
  const bad = [
    'javascript:alert(1)', 'JavaScript:alert(1)', ' javascript:alert(1)', 'java\nscript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=',
    'vbscript:x', '//evil.example/x', '/wiki/File:X.jpg', 'wiki/File:X.jpg', 'ftp://example.org/x', 'https://', 'https:///x',
    'https://user:pw@evil.example/', 'https://evil.example@good.org/', 'https://exa mple.org/', 'https://example.org/a b',
    'https://example.org/"onmouseover="alert(1)', 'https://example.org/<script>', 'https:\\\\evil.example', 'https://example.org/ ',
    'https://example.org/‮', 'https://-bad-.org/', 'https://example.org:999999/', '', null, undefined, 42, {}, 'x'.repeat(2001),
    'https://example.org/' + 'x'.repeat(2000),
  ];
  for (const u of bad) assert.equal(safeUrl(u), '', String(u));
  // In the credit: an unsafe URL leaves the text unlinked, nothing else changes.
  const html = creditHtml(image({ landing_url: 'javascript:alert(1)', creator_url: '//evil.example/x', license_url: 'data:x' }));
  assert.equal(html, 'Photo: Rolex Submariner Date 126610LN by Horologium42, CC BY-SA 4.0, via Wikimedia Commons.');
});

test('credit: CC0 / public domain, unknown creator, missing pieces, em dashes and control characters', () => {
  const cc0 = image({ license: 'cc0', license_name: 'CC0 1.0', license_url: 'https://creativecommons.org/publicdomain/zero/1.0/', creator: 'Unknown author', creator_url: '' });
  assert.equal(creditHtml(cc0), 'Photo: <a href="https://commons.wikimedia.org/w/index.php?curid=148213907">Rolex Submariner Date 126610LN</a>, <a href="https://creativecommons.org/publicdomain/zero/1.0/">CC0 1.0</a>, via Wikimedia Commons.');
  const pd = image({ license: 'pdm', license_name: 'Public domain', license_url: '', creator: 'US Navy', creator_url: '' });
  assert.equal(creditHtml(pd), 'Photo: <a href="https://commons.wikimedia.org/w/index.php?curid=148213907">Rolex Submariner Date 126610LN</a> by US Navy, Public domain, via Wikimedia Commons.');
  const unknown = image({ creator: '', creator_url: 'https://example.org/u' });
  assert.match(creditHtml(unknown), / by Unknown author, /);
  const bare = image({ title: '', source_name: '', license_name: '', landing_url: '' });
  assert.equal(creditHtml(bare), 'Photo: Untitled by <a href="https://commons.wikimedia.org/wiki/User:Horologium42">Horologium42</a>.');
  const dashes = creditHtml(image({ title: 'Sub — Date – 2024', creator: 'A\u0000B‮C\nD' }));
  assert.ok(!/[‒-―\u0000‮\n]/.test(dashes));
  assert.match(dashes, />Sub - Date - 2024</);
  assert.match(dashes, />A B C D</);
  assert.equal(cleanText('x'.repeat(200), 20), 'x'.repeat(17) + '...');
  assert.equal(esc(`<&>"'`), '&lt;&amp;&gt;&quot;&#039;');
});

test('the credit paragraph in the post escapes a hostile photo record end to end', async () => {
  const c = clone(await conf());
  c.image = image({ title: '</p><!-- /wp:paragraph --><script>x</script>', creator: '"><img src=x>', creator_url: 'javascript:alert(1)' });
  const [o] = await runHandBack(c, { stage: 'alt' });
  assertAttached(o, 901);
  const added = o.json.content.slice(SOURCE.content.length);
  assert.equal(added, '\n\n<!-- wp:paragraph {"fontSize":"small"} -->\n<p class="has-small-font-size">Photo: ' +
    '<a href="https://commons.wikimedia.org/w/index.php?curid=148213907">&lt;/p&gt;&lt;!-- /wp:paragraph --&gt;&lt;script&gt;x&lt;/script&gt;</a>' +
    ' by &quot;&gt;&lt;img src=x&gt;, <a href="https://creativecommons.org/licenses/by-sa/4.0/">CC BY-SA 4.0</a>, via Wikimedia Commons.</p>\n<!-- /wp:paragraph -->');
});

// --- Routing, pairedItem, fallbacks ---------------------------------------------------------------------------------

test('several posts: each item only sees the steps on its own path (no media id of another post)', async () => {
  const a = await conf();
  const b = clone(a);
  b.source = { ...SOURCE, title: 'Post B', slug: 'post-b' };
  // Run of the "photo OK? false" branch with post B; post A's upload ran in another branch.
  const dlB = { json: b, binary: binaryOf({ mimeType: 'text/html' }), pairedItem: { item: 1 } };
  const nodes = {
    [N.pick]: [{ json: a }, { json: b }], [N.plan]: [{ json: a }, { json: b }],
    [N.confirm]: { items: [{ json: a }, { json: b }], itemMatching: () => ({ json: b }) },
    [N.download]: { items: [{ json: a, binary: binaryOf({}) }, dlB], itemMatching: () => dlB },
    [N.upload]: offPath([{ json: WP.upload_201 }]), [N.alt]: offPath([{ json: WP.alt_200 }]),
  };
  const [o] = await runCode(HANDBACK_CODE, { input: [dlB], nodes });
  assert.equal(o.json.title, 'Post B');
  assert.ok(!('featured_media' in o.json));
  assert.equal(o.json.image_report.reason, 'the download is not a JPEG, PNG or WebP image (text/html)');

  // Two posts arriving in the same run (alt branch): each gets its own upload's id; pairedItem per input.
  const up = [{ json: WP.upload_201 }, { json: { ...WP.upload_201, id: 777 } }];
  const alts = [{ json: WP.alt_200 }, { json: WP.alt_500 }];
  const nodes2 = {
    [N.pick]: [{ json: a }, { json: b }], [N.plan]: [{ json: a }, { json: b }],
    [N.confirm]: { items: [{ json: a }, { json: b }], itemMatching: i => ({ json: [a, b][i] }) },
    [N.download]: { items: [{ json: a, binary: binaryOf({}) }, { json: b, binary: binaryOf({}) }] },
    [N.upload]: up, [N.alt]: alts,
  };
  const out = await runCode(HANDBACK_CODE, { input: alts, nodes: nodes2 });
  assert.deepEqual(out.map(x => [x.json.title, x.json.featured_media, x.json.image_report.alt_text_set]), [[SOURCE.title, 901, true], ['Post B', 777, false]]);
  assert.deepEqual(out.map(x => x.pairedItem), [{ item: 0 }, { item: 1 }]);
});

test('single post: itemMatching that fails still finds the steps that ran (one item per node)', async () => {
  const { input, nodes } = handBackSetup(await conf(), { stage: 'alt' });
  for (const n of [N.confirm, N.download, N.upload, N.alt]) nodes[n] = offPath(nodes[n]);
  const [o] = await runCode(HANDBACK_CODE, { input, nodes });
  assertAttached(o, 901);
});

test('the post is found through earlier nodes when the confirm node is missing; never throws', async () => {
  const c = await conf();
  const { input, nodes } = handBackSetup(c, { stage: 'no-photo' });
  nodes[N.confirm] = notRun;
  let [o] = await runCode(HANDBACK_CODE, { input, nodes });
  assert.equal(o.json.title, SOURCE.title);
  nodes[N.plan] = notRun;
  [o] = await runCode(HANDBACK_CODE, { input, nodes });
  assert.equal(o.json.title, SOURCE.title);
  // Nothing anywhere: the input json is handed on (its error field dropped) with a failed report.
  [o] = await runCode(HANDBACK_CODE, { input: [{ json: { error: 'x', other: 1 } }], nodes: {} });
  assert.deepEqual(Object.keys(o.json), ['other', 'image_report']);
  assert.equal(o.json.image_report.status, 'failed');
  assert.equal(o.json.image_report.reason, 'the post was not found in the image finder nodes');
  // A source whose fields throw when read: still one item, failed report.
  const evil = { ...c, source: { get title() { throw new Error('boom'); } } };
  [o] = await runCode(HANDBACK_CODE, { input: [{ json: evil }], nodes: { [N.confirm]: [{ json: evil }], [N.pick]: [{ json: evil }] } });
  assert.equal(o.json.image_report.status, 'failed');
  assert.equal(o.json.image_report.reason, 'hand back failed: boom');
  // Zero items in, zero out.
  assert.deepEqual(await runCode(HANDBACK_CODE, { input: [], nodes: {} }), []);
});

// --- The one-line change to "WordPress: create draft" -----------------------------------------------------------------

const WC = process.env.WATCH_CENTRO_JSON || '/tmp/claude-0/-home-user-kg/aacd8074-0737-5f90-8758-10d665169dbb/scratchpad/watchcentro.json';
export const CREATE_DRAFT_BEFORE = '  excerpt: $json.excerpt,\n';
export const CREATE_DRAFT_AFTER = '  excerpt: $json.excerpt,\n  featured_media: $json.featured_media,\n';
// Evaluate an n8n "={{ ... }}" expression that only uses $json.
const evalBody = (expr, $json) => {
  assert.ok(expr.startsWith('={{') && expr.endsWith('}}'));
  return vm.runInNewContext(expr.slice(3, -2), { $json, JSON });
};

test('create draft: the featured_media line, on a copy of the real node', { skip: !fs.existsSync(WC) && 'Watch Centro export not found (set WATCH_CENTRO_JSON)' }, async () => {
  const wf = JSON.parse(fs.readFileSync(WC, 'utf8'));
  const node = clone(wf.nodes.find(n => n.name === 'WordPress: create draft'));
  const before = node.parameters.jsonBody;
  assert.equal(before.split(CREATE_DRAFT_BEFORE).length, 2, 'the excerpt line appears exactly once');
  assert.ok(!before.includes('featured_media'));
  const after = before.replace(CREATE_DRAFT_BEFORE, CREATE_DRAFT_AFTER);
  assert.equal(after.length - before.length, '  featured_media: $json.featured_media,\n'.length);

  // Attached: featured_media is sent; every other field is what the unpatched node sends for the same item.
  const [att] = await runHandBack(await conf(), { stage: 'alt' });
  const body = JSON.parse(evalBody(after, att.json));
  assert.deepEqual(Object.keys(body), ['title', 'slug', 'content', 'excerpt', 'featured_media', 'status', 'categories', 'tags', 'meta']);
  assert.strictEqual(body.featured_media, 901);
  const { featured_media, ...rest } = body;
  assert.deepEqual(rest, JSON.parse(evalBody(before, att.json)));
  assert.equal(body.content, SOURCE.content + '\n\n' + BLOCK_148);

  // Not attached: the body is byte-identical to what the unpatched node sends for the original Render item.
  for (const opts of [{ stage: 'download', download: WP.download_404 }, { stage: 'upload', upload: WP.upload_413 }]) {
    const [o] = await runHandBack(await conf(), opts);
    const sent = evalBody(after, o.json);
    assert.ok(!sent.includes('featured_media'));
    assert.equal(sent, evalBody(before, SOURCE));
  }
});
