// Step 4a/4b: "Image: plan licence check" and "Image: confirm licence" (the Commons cross-check of
// Wikimedia-sourced Openverse picks, the LLM-failure policy, media_update, and the copies of the step 3 rules).
import test from 'node:test';
import assert from 'node:assert/strict';
import { runCode, clone, setConst, PICK_CODE, BUILD_NODE, COMMONS_NODE } from './harness.mjs';
import { pipeline, post, Q_MODEL, Q_FAMILY, Q_BRAND, Q_GENERIC } from './step3-helpers.mjs';
import {
  PLAN_CODE, CONFIRM_CODE, HANDBACK_CODE, N, image, FLICKR_ALT, COMMONS_ALT, pickJson, commonsPage, PAGE_148, lookupAnswer,
  runPlan, runConfirm, planAndConfirm, declaration, between, CREDIT_START, CREDIT_END, creditHelpers,
} from './step4-helpers.mjs';

const N8N_ITEMS = JSON.parse((await import('node:fs')).readFileSync(new URL('../fixtures/n8n/http-request-items.json', import.meta.url), 'utf8'));
const OUT_KEYS = ['source', 'post_title', 'watches', 'image_queries', 'image', 'image_error', 'alternates', 'search_log',
  'extract_error', 'licence_check', 'media_update'];
const OV_D3 = image({
  id: 'd3e4d1e1-c069-5080-b265-b206da47bdea', title: 'Rolex Submariner Date 126610LN (53218846721)', creator: 'chronoshots',
  creator_url: 'https://www.flickr.com/people/41894170373@N01', license: 'by', license_version: '2.0', license_name: 'CC BY 2.0',
  license_url: 'https://creativecommons.org/licenses/by/2.0/', landing_url: 'https://commons.wikimedia.org/w/index.php?curid=150337412',
  file_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c1/Rolex_Submariner_Date_126610LN_%2853218846721%29.jpg/1920px-Rolex_Submariner_Date_126610LN_%2853218846721%29.jpg',
  download_filename: 'rolex-submariner-date-watch-openverse-d3e4d1e1c069.jpg',
});
const PAGE_150 = (meta, patch) => {
  const p = commonsPage(150337412, 'Rolex_Submariner_Date_126610LN_%2853218846721%29.jpg', {
    LicenseShortName: 'CC BY 2.0', License: 'cc-by-2.0', LicenseUrl: 'https://creativecommons.org/licenses/by/2.0',
    UsageTerms: 'Creative Commons Attribution 2.0',
    Artist: '<a rel="nofollow" class="external text" href="https://www.flickr.com/people/41894170373@N01">chronoshots</a>', ...meta,
  }, patch);
  p.imageinfo[0].url = 'https://upload.wikimedia.org/wikipedia/commons/c/c1/Rolex_Submariner_Date_126610LN_%2853218846721%29.jpg';
  return p;
};
const contract = o => {
  assert.deepEqual(Object.keys(o), OUT_KEYS);
  assert.ok(!JSON.stringify(o).includes('\u2014'), 'no em dash');
  if (o.image) {
    assert.match(o.image.download_filename, /^[A-Za-z0-9_-]+\.(jpg|png|webp)$/);
    assert.deepEqual(Object.keys(o.media_update), ['alt_text', 'caption', 'title', 'description']);
  } else assert.equal(o.media_update, null);
};

// --- Plan -----------------------------------------------------------------------------------------------------

test('plan: the step 3 case (a) pick is confirmed by the same run\'s Commons search, so no lookup is needed', async () => {
  const OV_MAP = {
    'Rolex Submariner Date': 'search-rolex-submariner-date.json', 'Rolex Submariner': 'search-rolex-submariner.json',
    'Rolex watch': 'search-rolex-watch-nothing-usable.json', 'luxury wristwatch': 'search-luxury-wristwatch.json',
  };
  const r = await pipeline({ posts: [post([Q_MODEL, Q_FAMILY, Q_BRAND, Q_GENERIC])], openverse: OV_MAP, commons: { 'Rolex Submariner': 'search-rolex-submariner.json' } });
  const [p] = await runCode(PLAN_CODE, { input: r.out, nodes: { [BUILD_NODE]: [{ json: post([]) }], [COMMONS_NODE]: r.cm } });
  const lc = p.json.licence_check;
  assert.deepEqual(lc.lookup_pageids, []);
  assert.deepEqual(lc.candidates, [{ provider: 'openverse', id: 'ed296e8f-1cb3-5e22-825d-ddbd552c338c', pageid: '148213907', check: 'search' }]);
  assert.deepEqual(Object.keys(lc.search_pages), ['148213907']);
  assert.equal(lc.search_pages['148213907'].title, 'File:Rolex Submariner Date 126610LN.jpg');
  assert.deepEqual(p.pairedItem, { item: 0 });
  // Everything from the pick passes through unchanged.
  for (const k of Object.keys(r.json[0])) assert.deepEqual(p.json[k], r.json[0][k], k);
  // ... and the confirm node uses it with the Commons licence (same as Openverse here).
  const [c] = await runConfirm(p.json);
  contract(c.json);
  assert.equal(c.json.image.id, 'ed296e8f-1cb3-5e22-825d-ddbd552c338c');
  assert.deepEqual(c.json.licence_check, {
    status: 'confirmed', lookup: 'not needed',
    checked: [{ provider: 'openverse', id: 'ed296e8f-1cb3-5e22-825d-ddbd552c338c', pageid: '148213907', result: 'used', reason: 'licence confirmed by the Commons search' }],
  });
  assert.equal(c.json.image.license_url, 'https://creativecommons.org/licenses/by-sa/4.0', 'Commons LicenseUrl wins');
});

test('plan: Commons picks and non-Wikimedia Openverse rows need no lookup', async () => {
  for (const img of [COMMONS_ALT, FLICKR_ALT]) {
    const [p] = await runPlan([pickJson(img, [image()])]);
    assert.deepEqual(p.json.licence_check.lookup_pageids, [], img.id);
    assert.deepEqual(p.json.licence_check.candidates.map(c => c.check), ['not needed']);
  }
});

test('plan: Wikimedia rows without a search page are looked up, up to the first candidate that needs no lookup', async () => {
  const noCurid = image({ id: 'no-curid', landing_url: 'https://commons.wikimedia.org/wiki/File:X.jpg' });
  const [p] = await runPlan([pickJson(image(), [noCurid, OV_D3, FLICKR_ALT])]);
  const lc = p.json.licence_check;
  assert.deepEqual(lc.lookup_pageids, ['148213907', '150337412']);
  assert.deepEqual(lc.candidates.map(c => [c.id.slice(0, 8), c.pageid, c.check]), [
    ['ed296e8f', '148213907', 'lookup'], ['no-curid', '', 'no page id'], ['d3e4d1e1', '150337412', 'lookup'], ['a765171e', '', 'not needed'],
  ]);
  // Stops at the Flickr row: an alternate after it is never needed.
  const [q] = await runPlan([pickJson(image(), [FLICKR_ALT, OV_D3])]);
  assert.deepEqual(q.json.licence_check.lookup_pageids, ['148213907']);
  // A search page without file info does not count as a confirmation.
  const [s] = await runPlan([pickJson(image())], { commonsItems: [lookupAnswer({ pageid: 148213907, ns: 6, title: 'File:X.jpg' })] });
  assert.deepEqual(s.json.licence_check.lookup_pageids, ['148213907']);
  // Search results in the fullResponse shape and the formatversion 1 object shape are read too.
  const [t] = await runPlan([pickJson(image())], { commonsItems: [{ body: { query: { pages: { 148213907: PAGE_148() } } }, statusCode: 200, headers: {} }] });
  assert.deepEqual(t.json.licence_check.lookup_pageids, []);
});

test('plan: no image -> nothing to check; failed searches -> lookup', async () => {
  const [p] = await runPlan([pickJson(null)]);
  assert.deepEqual(p.json.licence_check, { lookup_pageids: [], candidates: [], search_pages: {}, settled: false });
  const [q] = await runPlan([pickJson(image())], { commonsItems: [N8N_ITEMS.default_500, N8N_ITEMS.full_response_commons_maxlag] });
  assert.deepEqual(q.json.licence_check.lookup_pageids, ['148213907']);
});

test('plan: a failed watch extraction with no watches drops the photo (no lookup, no download); config can keep it', async () => {
  const pick = pickJson(image(), [FLICKR_ALT], { watches: [] });
  const build = [{ extract_error: 'Anthropic API error: 500 Internal Server Error' }];
  const [p] = await runPlan([pick], { build });
  assert.equal(p.json.image, null);
  assert.deepEqual(p.json.alternates, []);
  assert.equal(p.json.extract_error, 'Anthropic API error: 500 Internal Server Error');
  assert.equal(p.json.image_error, 'watch extraction failed (Anthropic API error: 500 Internal Server Error), so no photo is used');
  assert.deepEqual(p.json.licence_check.lookup_pageids, []);
  // A partly read answer (watches kept) keeps the photo, and so does the config switch.
  const [q] = await runPlan([pickJson(image())], { build: [{ extract_error: 'LLM JSON was invalid or cut off; kept 1 complete watch entries' }] });
  assert.equal(q.json.image.id, image().id);
  const [r] = await runPlan([pick], { build, code: setConst(PLAN_CODE, 'USE_PHOTO_WITHOUT_WATCHES', 'true') });
  assert.equal(r.json.image.id, image().id);
});

test('plan: one item per pick item, pairedItem {item: i}, extract_error matched by position', async () => {
  const out = await runPlan([pickJson(image(), [], { watches: [] }), pickJson(FLICKR_ALT)], { build: [{ extract_error: 'boom' }, { extract_error: '' }] });
  assert.deepEqual(out.map(o => o.pairedItem), [{ item: 0 }, { item: 1 }]);
  assert.deepEqual(out.map(o => [o.json.extract_error, o.json.image && o.json.image.id]), [['boom', null], ['', FLICKR_ALT.id]]);
});

test('plan: never throws (garbage input, missing nodes)', async () => {
  const out = await runCode(PLAN_CODE, { input: [{ json: { image: 'x', alternates: 'y' } }, { json: {} }], nodes: {} });
  assert.equal(out.length, 2);
  for (const o of out) assert.deepEqual(o.json.licence_check.lookup_pageids, []);
});

// --- Confirm --------------------------------------------------------------------------------------------------

test('confirm: a lookup that allows the licence confirms the pick; licence and creator come from Commons', async () => {
  // Openverse says CC BY 2.0, Commons now says CC BY-SA 4.0 and asks for a credit name.
  const pick = pickJson(image({ license: 'by', license_version: '2.0', license_name: 'CC BY 2.0', license_url: 'https://creativecommons.org/licenses/by/2.0/', creator: 'horo42' }));
  const { plan, out, lookupJson } = await planAndConfirm(pick, {
    lookup: ids => (assert.deepEqual(ids, ['148213907']), lookupAnswer(PAGE_148({ Attribution: 'Photo: Horologium42 / Wikimedia Commons / CC BY-SA 4.0' }))),
  });
  assert.ok(lookupJson);
  contract(out);
  assert.equal(plan.licence_check.candidates[0].check, 'lookup');
  assert.deepEqual(out.licence_check.checked, [{ provider: 'openverse', id: pick.image.id, pageid: '148213907', result: 'used', reason: 'licence confirmed by the Commons lookup' }]);
  assert.deepEqual([out.licence_check.status, out.licence_check.lookup], ['confirmed', 'ok']);
  const img = out.image;
  assert.deepEqual([img.license, img.license_version, img.license_name, img.license_url], ['by-sa', '4.0', 'CC BY-SA 4.0', 'https://creativecommons.org/licenses/by-sa/4.0']);
  assert.equal(img.creator, 'Horologium42');
  assert.equal(img.creator_url, 'https://commons.wikimedia.org/wiki/User:Horologium42');
  assert.equal(img.credit_text, 'Photo: "Rolex Submariner Date 126610LN" by Horologium42, CC BY-SA 4.0, via Wikimedia Commons');
  assert.equal(img.attribution_required, true);
  // Unchanged: what was picked and how it is fetched.
  for (const k of ['id', 'title', 'file_url', 'landing_url', 'alt_text', 'download_filename', 'recent_keys', 'score']) assert.deepEqual(img[k], pick.image[k], k);
  assert.equal(out.image_error, '');
  // Pick fields pass through.
  for (const k of ['source', 'post_title', 'watches', 'image_queries', 'search_log']) assert.deepEqual(out[k], pick[k], k);
});

test('confirm (f): the Commons lookup shows a disallowed licence -> the next confirmable alternate, else no image', async () => {
  const lookup = lookupAnswer(
    PAGE_148({ LicenseShortName: 'CC BY-NC-SA 4.0', License: 'cc-by-nc-sa-4.0', LicenseUrl: 'https://creativecommons.org/licenses/by-nc-sa/4.0' }),
    PAGE_150(),
  );
  const { out } = await planAndConfirm(pickJson(image(), [OV_D3, FLICKR_ALT]), { lookup });
  contract(out);
  assert.equal(out.image.id, OV_D3.id);
  assert.equal(out.licence_check.status, 'alternate used');
  assert.deepEqual(out.licence_check.checked.map(e => [e.id.slice(0, 8), e.result, e.reason]), [
    ['ed296e8f', 'rejected', 'Commons: licence NC/ND (Commons lookup)'],
    ['d3e4d1e1', 'used', 'licence confirmed by the Commons lookup'],
  ]);
  assert.deepEqual(out.alternates.map(a => a.id), [FLICKR_ALT.id]);
  assert.match(out.media_update.caption, /chronoshots<\/a>, <a href="https:\/\/creativecommons.org\/licenses\/by\/2.0">CC BY 2.0<\/a>, via Wikimedia Commons\.$/);

  // Every candidate disallowed -> no image, and the reason names each one.
  const bad = lookupAnswer(
    PAGE_148({ NonFree: 'true' }),
    PAGE_150({ Restrictions: 'personality|trademarked' }),
  );
  const { out: none } = await planAndConfirm(pickJson(image(), [OV_D3]), { lookup: bad });
  contract(none);
  assert.equal(none.image, null);
  assert.deepEqual(none.alternates, []);
  assert.equal(none.licence_check.status, 'rejected');
  assert.equal(none.image_error, 'no picked photo passed the Commons licence check: openverse ed296e8f-1cb3-5e22-825d-ddbd552c338c: Commons: non-free file (Commons lookup); openverse d3e4d1e1-c069-5080-b265-b206da47bdea: Commons: restriction personality (Commons lookup)');
});

test('confirm: every step 3 Commons rule is re-applied (each rejects, the Flickr alternate is used instead)', async () => {
  const cases = [
    [{ LicenseShortName: 'GFDL', License: 'gfdl', LicenseUrl: 'http://www.gnu.org/copyleft/fdl.html', UsageTerms: 'GNU Free Documentation License' }, 'Commons: licence not allowed'],
    [{ LicenseShortName: 'CC BY-ND 4.0', License: 'cc-by-nd-4.0', LicenseUrl: 'https://creativecommons.org/licenses/by-nd/4.0' }, 'Commons: licence NC/ND'],
    [{ LicenseShortName: null, License: null, LicenseUrl: null }, 'Commons: licence unknown'],
    [{ LicenseShortName: 'CC BY-SA 4.0', License: 'cc-by-sa-4.0', LicenseUrl: 'https://creativecommons.org/licenses/by/4.0' }, 'Commons: licence URL disagrees'],
    [{ NonFree: 'true' }, 'Commons: non-free file'],
    [{ UsageTerms: 'Creative Commons Attribution-NonCommercial 4.0' }, 'Commons: licence NC/ND'],
    [{ LicenseShortName: 'Public domain', License: 'pd-textlogo', LicenseUrl: null }, 'Commons: public domain logo or simple shape'],
    [{ Restrictions: 'trademarked|personality' }, 'Commons: restriction personality'],
  ];
  for (const [meta, reason] of cases) {
    const { out } = await planAndConfirm(pickJson(image(), [FLICKR_ALT]), { lookup: lookupAnswer(PAGE_148(meta)) });
    contract(out);
    assert.equal(out.image.id, FLICKR_ALT.id, reason);
    assert.equal(out.licence_check.checked[0].reason, reason + ' (Commons lookup)');
    assert.equal(out.licence_check.checked[1].reason, 'not a Wikimedia Commons file');
  }
  // trademarked alone stays allowed (as in step 3).
  const { out } = await planAndConfirm(pickJson(image(), [FLICKR_ALT]), { lookup: lookupAnswer(PAGE_148({ Restrictions: 'trademarked' })) });
  assert.equal(out.image.id, image().id);
});

test('confirm: SSRF guard, only https file URLs on upload.wikimedia.org / *.staticflickr.com are downloaded (review fix)', async () => {
  const bad = ['http://live.staticflickr.com/1/2_ab.jpg', 'https://169.254.169.254/latest/meta-data', 'http://127.0.0.1:5678/x.jpg',
    'https://evil.example/x.jpg', 'https://staticflickr.com.evil.example/x.jpg', 'https://upload.wikimedia.org.evil/x.jpg', 'ftp://upload.wikimedia.org/x.jpg'];
  for (const file_url of bad) {
    const flickrBad = { ...FLICKR_ALT, id: 'bad-1', file_url };
    const { out } = await planAndConfirm(pickJson(flickrBad, [FLICKR_ALT]), {});
    contract(out);
    assert.equal(out.image.id, FLICKR_ALT.id, file_url);
    assert.equal(out.licence_check.checked[0].result, 'rejected');
    assert.equal(out.licence_check.checked[0].reason, 'file URL not on the download allowlist');
    const { out: none } = await planAndConfirm(pickJson(flickrBad, []), {});
    contract(none);
    assert.equal(none.image, null, file_url);
    assert.match(none.image_error, /download allowlist/);
  }
  const { out } = await planAndConfirm(pickJson({ ...FLICKR_ALT, file_url: 'https://farm66.staticflickr.com/65535/1_ab_b.jpg' }, []), {});
  assert.equal(out.image.id, FLICKR_ALT.id);
});

test('confirm: missing page, another file, no file info and a missing page id are not confirmable', async () => {
  const cases = [
    [lookupAnswer({ pageid: 148213907, missing: true }), 'file not found on Commons (Commons lookup)'],
    [lookupAnswer(), 'not found on Commons'],
    [lookupAnswer({ pageid: 148213907, ns: 6, title: 'File:X.jpg' }), 'no file info on Commons (Commons lookup)'],
    [lookupAnswer(commonsPage(148213907, 'Some_other_file.jpg')), 'the Commons page shows another file (Commons lookup)'],
  ];
  for (const [answer, reason] of cases) {
    const { out } = await planAndConfirm(pickJson(image(), [FLICKR_ALT]), { lookup: answer });
    assert.equal(out.image.id, FLICKR_ALT.id, reason);
    assert.equal(out.licence_check.checked[0].reason, reason);
  }
  const { out } = await planAndConfirm(pickJson(image({ landing_url: 'https://commons.wikimedia.org/wiki/File:X.jpg' }), [COMMONS_ALT]));
  assert.equal(out.image.id, COMMONS_ALT.id);
  assert.deepEqual(out.licence_check.checked.map(e => e.reason), ['no Commons page id in the landing URL', 'licence read from Commons by the search']);
});

test('confirm: a failed lookup (HTTP error, timeout, MediaWiki error, odd body) skips the unconfirmed rows', async () => {
  const cases = [
    [N8N_ITEMS.default_500, 'HTTP 500'],
    [N8N_ITEMS.default_timeout, 'timeout'],
    [N8N_ITEMS.default_commons_503_html, 'HTTP 503'],
    [N8N_ITEMS.full_response_commons_maxlag, 'API maxlag'],
    [N8N_ITEMS.full_response_commons_503_html, 'HTTP 503'],
    [N8N_ITEMS.invalid_json, 'invalid JSON'],
    [{ error: { code: 'internal_api_error_DBQueryError', info: 'Database query error.' } }, 'API internal_api_error_DBQueryError'],
    [{ hello: 'world' }, 'unexpected response'],
  ];
  for (const [answer, label] of cases) {
    const { out } = await planAndConfirm(pickJson(image(), [OV_D3, FLICKR_ALT]), { lookup: answer });
    contract(out);
    assert.equal(out.image.id, FLICKR_ALT.id, label);
    assert.equal(out.licence_check.lookup, label);
    assert.deepEqual(out.licence_check.checked.map(e => e.reason), [
      'Commons lookup failed: ' + label, 'Commons lookup failed: ' + label, 'not a Wikimedia Commons file',
    ]);
  }
  const { out } = await planAndConfirm(pickJson(image()), { lookup: N8N_ITEMS.default_500 });
  assert.equal(out.image, null);
  assert.equal(out.image_error, 'no picked photo passed the Commons licence check: openverse ed296e8f-1cb3-5e22-825d-ddbd552c338c: Commons lookup failed: HTTP 500');
});

test('confirm: no photo, plan not found, garbage: never throws, image null with a reason', async () => {
  const [a] = await runConfirm((await runPlan([pickJson(null)]))[0].json);
  contract(a.json);
  assert.deepEqual(a.json.licence_check, { status: 'no photo', lookup: 'not needed', checked: [] });
  assert.match(a.json.image_error, /^no licence-safe relevant photo found/);
  // A lookup answer whose plan item cannot be found.
  const [b] = await runConfirm(null, lookupAnswer(PAGE_148()), { planNode: { items: [], executed: false } });
  assert.equal(b.json.image, null);
  assert.equal(b.json.image_error, 'licence check failed: the picked photo was not found');
  // The plan item is found through pairedItem even when the node holds several items.
  const plans = (await runPlan([pickJson(FLICKR_ALT), pickJson(image())])).map(p => ({ json: p.json }));
  const [c] = await runConfirm(null, lookupAnswer(PAGE_148()), { planNode: { items: plans, itemMatching: () => plans[1] } });
  assert.equal(c.json.image.id, image().id);
  assert.equal(c.json.licence_check.status, 'confirmed');
  const out = await runCode(CONFIRM_CODE, { input: [{ json: { source: {}, image: 5, licence_check: 'x' } }, { json: null }], nodes: {} });
  assert.equal(out.length, 2);
  for (const o of out) assert.equal(o.json.image, null);
  assert.deepEqual(out.map(o => o.pairedItem), [{ item: 0 }, { item: 1 }]);
});

test('confirm: media_update is the alt text update body (plain alt/title, linked caption and description)', async () => {
  const { out } = await planAndConfirm(pickJson(image({ alt_text: 'Rolex <b>Sub</b> 100%2F watch', title: 'Sub <i>date</i>' })), { commonsItems: [lookupAnswer(PAGE_148())] });
  assert.deepEqual(out.media_update, {
    alt_text: 'Rolex bSub/b 100% 2F watch',
    caption: 'Photo: <a href="https://commons.wikimedia.org/w/index.php?curid=148213907">Sub &lt;i&gt;date&lt;/i&gt;</a> by <a href="https://commons.wikimedia.org/wiki/User:Horologium42">Horologium42</a>, <a href="https://creativecommons.org/licenses/by-sa/4.0">CC BY-SA 4.0</a>, via Wikimedia Commons.',
    title: 'Sub idate/i',
    description: '<p>Photo: <a href="https://commons.wikimedia.org/w/index.php?curid=148213907">Sub &lt;i&gt;date&lt;/i&gt;</a> by <a href="https://commons.wikimedia.org/wiki/User:Horologium42">Horologium42</a>, <a href="https://creativecommons.org/licenses/by-sa/4.0">CC BY-SA 4.0</a>, via Wikimedia Commons.</p>\n<p>Source: <a href="https://commons.wikimedia.org/w/index.php?curid=148213907">https://commons.wikimedia.org/w/index.php?curid=148213907</a></p>',
  });
});

test('confirm: download_filename is made ASCII-safe with a photo extension', async () => {
  const cases = [
    [{ download_filename: 'rolex-sub-openverse-ab12.jpg', extension: 'jpg' }, 'rolex-sub-openverse-ab12.jpg'],
    [{ download_filename: 'Söhne "x";y=z.php.jpeg', extension: 'jpeg' }, 'S-hne-x-y-z-php.jpg'],
    [{ download_filename: '', extension: 'png' }, 'watch-photo.png'],
    [{ download_filename: 'a.webp', extension: 'gif' }, 'a.jpg'],
    [{ download_filename: '../../etc/passwd', extension: 'webp' }, 'etc-passwd.webp'],
  ];
  for (const [patch, want] of cases) {
    const { out } = await planAndConfirm(pickJson(image({ provider: 'commons', ...patch })));
    assert.equal(out.image.download_filename, want, JSON.stringify(patch));
  }
});

// --- Copies stay in step -------------------------------------------------------------------------------------

test('the step 3 rules in confirm-licence.js are verbatim copies of pick-photo.js', () => {
  const names = ['REJECT_RESTRICTIONS', 'REJECT_COMMONS_LICENSE', 'str', 'norm', 'ENTITIES', 'decodeEntities', 'htmlText', 'plain',
    'isHttp', 'absUrl', 'safeDecode', 'normUrl', 'parseLicenseName', 'parseLicenseUrl', 'family', 'ALLOWED_CODES', 'jurLabel',
    'licenseFields', 'decideLicense', 'UNKNOWN_CREATOR', 'cleanCreator', 'requestedCredit', 'artistUrl', 'curidOf', 'creditFor',
    'toCode', 'n8nErrorLabel'];
  for (const n of names) {
    const a = declaration(PICK_CODE, n);
    assert.ok(a, `${n} in pick-photo.js`);
    assert.equal(declaration(CONFIRM_CODE, n), a, `${n} differs from pick-photo.js`);
  }
});

test('helpers shared by plan-licence-check.js and confirm-licence.js are identical', () => {
  for (const n of ['isObj', 'curidOf', 'hostOf', 'isWikimediaRow', 'pagesOf']) {
    const a = declaration(PLAN_CODE, n);
    assert.ok(a, n);
    assert.equal(declaration(CONFIRM_CODE, n), a, n);
  }
});

test('the credit-line block is identical in confirm-licence.js and hand-back-post.js', () => {
  const a = between(CONFIRM_CODE, CREDIT_START, CREDIT_END);
  assert.ok(a && a.length > 500);
  assert.equal(between(HANDBACK_CODE, CREDIT_START, CREDIT_END), a);
  assert.equal(typeof creditHelpers(CONFIRM_CODE).creditHtml, 'function');
});

test('new Code bodies: literal $(\'Image: ...\') references only, no em dashes, no Watch Centro node names', () => {
  const allowed = {
    [PLAN_CODE]: [N.build, N.commonsSearch],
    [CONFIRM_CODE]: [N.plan],
    [HANDBACK_CODE]: [N.confirm, N.plan, N.pick, N.download, N.upload, N.alt],
  };
  for (const [code, names] of Object.entries(allowed)) {
    const refs = [...code.matchAll(/\$\(([^)]*)\)/g)].map(m => m[1]);
    assert.deepEqual([...new Set(refs)].sort(), names.map(n => `'${n}'`).sort());
    assert.ok(!code.includes('\u2014') && !code.includes('\u2013'));
    assert.ok(!/Render WP blocks'\)|WordPress: create draft'\)/.test(code));
  }
});
