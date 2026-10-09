// Steps 2-6 end to end, in a REAL local n8n 2.x, with Watch Centro's workflow settings (binaryMode 'separate',
// executionOrder v1). The test workflow is
//   E2E: manual trigger -> Normalize input (stub: mode live) -> Parse + code checks (sanitizer) (fixture)
//   -> Fixture: writer output -> Render WP blocks (the REAL Watch Centro jsCode, verbatim)
//   -> Live mode? (IF 2.2, same condition as Watch Centro) --true--> the 21 work nodes of workflows/image-finder.json
//      (false --> Respond: test draft stub)
//   -> Image: hand back post -> WordPress: create draft (a COPY of the real node from the Watch Centro export with
//      the featured_media line added by build.mjs patchCreateDraft) -> E2E: respond (reads $json.id,
//      $('Render WP blocks').first().json.word_count and .item, like "Respond: draft created").
// Mocks: Anthropic (credential), Openverse, Commons (search + imageinfo lookup + /files/ photo downloads),
// WordPress (test/e2e/mock-wordpress.mjs, credential "WatchCentro" id LPEXDGdEBrfFA7NC imported).
// All hosts are rewritten in a copy before import. One test-only change in the copy: the download node's URL
// expression maps the photo's real URL to the Commons mock's /files/ route (data URLs are not rewritten by the
// harness): https://upload.wikimedia.org/a/b.jpg -> https://commons.wikimedia.org/files/upload.wikimedia.org/a/b.jpg.
//   N8N_BIN=/abs/n8n.sh E2E_N8N_HOME=/abs/scratch/n8n-e2e-home node --test test/e2e/steps4-6.e2e.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWorkflow } from './run-workflow.mjs';
import { makeJpeg, imageSizeFromPath } from './mock-http.mjs';
import { startWordpressMock, CREDENTIAL, PREFERRED_PORT } from './mock-wordpress.mjs';
import { WRITER_POSTS } from '../fixtures/writer-posts.mjs';
import { patchCreateDraft, NAMES } from '../../build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FRAGMENT = JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows/image-finder.json'), 'utf8'));
const RENDER_FILE = fs.readFileSync(path.join(ROOT, 'test/fixtures/render-wp-blocks.js'), 'utf8');
const RENDER_CODE = RENDER_FILE.slice(RENDER_FILE.indexOf('\n') + 1).trimEnd();
const WC_FILE = '/tmp/claude-0/-home-user-kg/aacd8074-0737-5f90-8758-10d665169dbb/scratchpad/watchcentro.json';
const CREATE_DRAFT_REAL = fs.existsSync(WC_FILE)
  ? JSON.parse(fs.readFileSync(WC_FILE, 'utf8')).nodes.find(n => n.name === 'WordPress: create draft')
  : JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/watchcentro/create-draft-node.json'), 'utf8'));
const CM_SUB = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/commons/search-rolex-submariner.json'), 'utf8'));
const skip = !process.env.N8N_BIN && 'N8N_BIN not set (see README, "End-to-end tests")';

const RENDER = 'Render WP blocks';
const CREATE = 'WordPress: create draft';
const RESPOND = 'E2E: respond';
const UA = 'WatchCentroImageFinder/1.0 (+https://watchcentro.com)';
const SUB = { brand: 'Rolex', model_family: 'Submariner', model: 'Submariner Date', reference: '126610LN', mentioned_as: 'Rolex Submariner Date 126610LN', prominence: 'primary' };
const STEEL = WRITER_POSTS.steel.post.title;
const ANTHROPIC_OK = { [STEEL]: { json: { watches: [SUB] } }, __default__: { status: 400, message: 'E2E: unexpected prompt' } };
const OV_OK = {
  'Rolex Submariner Date': 'search-rolex-submariner-date.json',
  'Rolex Submariner': 'search-rolex-submariner.json',
  'Rolex watch': 'search-rolex-watch-nothing-usable.json',
  'luxury wristwatch': 'search-luxury-wristwatch.json',
};
const CM_OK = { 'Rolex Submariner': 'search-rolex-submariner.json' };
const PICK_FILE = 'upload.wikimedia.org/wikipedia/commons/thumb/4/4c/Rolex_Submariner_Date_126610LN.jpg/1920px-Rolex_Submariner_Date_126610LN.jpg';
const PICK_NAME = 'rolex-submariner-date-watch-openverse-ed296e8f1cb3.jpg';
const PAGE_148 = CM_SUB.query.pages.find(p => p.pageid === 148213907);

const wordCount = p => [p.summary, p.takeaway, p.closing, ...(p.sections || []).flatMap(s => s.paragraphs || [])]
  .join(' ').split(/\s+/).filter(Boolean).length;
const code = (id, name, x, jsCode, extra = {}) => ({
  id, name, type: 'n8n-nodes-base.code', typeVersion: 2, position: [x, 400], parameters: { jsCode, ...extra },
});
const link = to => ({ main: [[{ node: to, type: 'main', index: 0 }]] });

function testWorkflow({ mode = 'live' } = {}) {
  const fragment = JSON.parse(JSON.stringify(FRAGMENT));
  for (const n of fragment.nodes) {
    // Shorter search batching than production (3500 / 1000 ms), as in step 3's e2e: speed only.
    if (n.name === NAMES.openverse) n.parameters.options.batching.batch.batchInterval = 300;
    if (n.name === NAMES.commons) n.parameters.options.batching.batch.batchInterval = 100;
    if (n.name === NAMES.download) {
      // Test seam (see the header): fetch the photo from the Commons mock's /files/ route.
      n.parameters.url = "={{ 'https://commons.wikimedia.org/files/' + $json.image.file_url.replace(/^https?:\\/\\//, '').replace(/[?#].*$/, '') }}";
    }
  }
  const { post, data_window } = WRITER_POSTS.steel;
  const reviewItem = { ok: true, stage: 'reviewer', reason: '', post, word_count: wordCount(post), run_date: '2026-10-07' };
  const createDraft = { ...patchCreateDraft(CREATE_DRAFT_REAL), position: [7000, 400] };
  return {
    name: 'E2E steps 4-6 (image finder)',
    nodes: [
      { id: 'e2e4a000-0000-4000-8000-000000000001', name: 'E2E: manual trigger', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [1800, 400], parameters: {} },
      code('e2e4a000-0000-4000-8000-000000000002', 'Normalize input', 1960, `return [{ json: ${JSON.stringify({ mode, run_id: 'run-e2e-4', window: '2026-10-01..2026-10-07' })} }];`),
      code('e2e4a000-0000-4000-8000-000000000003', 'Parse + code checks (sanitizer)', 2120, `return [{ json: ${JSON.stringify({ ok: true, sanitized: { data_window } })} }];`),
      code('e2e4a000-0000-4000-8000-000000000004', 'Fixture: writer output', 2280, `return [{ json: ${JSON.stringify(reviewItem)} }];`),
      code('e2e4a000-0000-4000-8000-000000000005', RENDER, 2440, RENDER_CODE),
      {
        id: 'e2e4a000-0000-4000-8000-000000000006', name: 'Live mode?', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [2600, 400],
        parameters: {
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
            conditions: [{ id: 'Live mode?', leftValue: "={{ $('Normalize input').first().json.mode === 'live' }}", rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }],
            combinator: 'and',
          },
          options: {},
        },
      },
      code('e2e4a000-0000-4000-8000-000000000007', 'Respond: test draft', 2800, 'return $input.all();'),
      ...fragment.nodes,
      createDraft,
      code('e2e4a000-0000-4000-8000-000000000008', RESPOND, 7200,
        `return { json: { post_id: $json.id, word_count: $('${RENDER}').first().json.word_count, title_via_item: $('${RENDER}').item.json.title } };`,
        { mode: 'runOnceForEachItem' }),
    ],
    connections: {
      'E2E: manual trigger': link('Normalize input'),
      'Normalize input': link('Parse + code checks (sanitizer)'),
      'Parse + code checks (sanitizer)': link('Fixture: writer output'),
      'Fixture: writer output': link(RENDER),
      [RENDER]: link('Live mode?'),
      // The integration: Live mode? true -> Image: prep post text (instead of -> create draft).
      'Live mode?': { main: [[{ node: NAMES.prep, type: 'main', index: 0 }], [{ node: 'Respond: test draft', type: 'main', index: 0 }]] },
      ...fragment.connections,
      [NAMES.handBack]: link(CREATE),
      [CREATE]: link(RESPOND),
    },
    settings: { executionOrder: 'v1', binaryMode: 'separate' },
  };
}

async function runCase(caseName, { anthropic = ANTHROPIC_OK, openverse = OV_OK, commons = CM_OK, wp = {}, mode } = {}) {
  let wpMock = null;
  const r = await runWorkflow({
    workflow: testWorkflow({ mode }),
    fixtures: anthropic,
    mocks: {
      openverse: { fixtures: openverse },
      commons: { fixtures: commons },
      wordpress: {
        // The mock's URL ends in /wp-json so only WordPress API URLs are rewritten, not the User-Agent's
        // "https://watchcentro.com".
        start: async o => { wpMock = await startWordpressMock({ ...o, ...wp, publicBase: undefined }); return { url: wpMock.url + '/wp-json', requests: wpMock.requests, close: () => wpMock.close() }; },
        rewrite: 'https://watchcentro.com/wp-json',
        port: PREFERRED_PORT,
      },
    },
    credentials: [CREDENTIAL('{{mock:wordpress}}')],
    staticData: { global: {} },
    readStaticData: true,
  });
  fs.writeFileSync(path.join(path.dirname(r.logs.n8n), `steps4-6-${caseName}.result.json`), JSON.stringify(r, null, 2));
  assert.equal(r.ok, true, `workflow failed: ${JSON.stringify(r.error)}; see ${r.logs.n8n}`);
  const wpReq = (r.mocks.wordpress.requests || []).filter(q => q.pathname && q.pathname.startsWith('/wp-json/'));
  const hand = r.nodes[NAMES.handBack];
  assert.ok(hand, 'hand back post ran');
  assert.equal(hand.length, 1, 'hand back post ran exactly once');
  assert.equal(hand[0].items.length, 1);
  assert.ok(r.nodes[CREATE], 'create draft ran');
  assert.equal(r.nodes[CREATE].length, 1);
  assert.equal(r.nodes[CREATE][0].status, 'success');
  const out = hand[0].items[0];
  const rendered = r.nodes[RENDER][0].items[0];
  const posts = [...wpMock.state.posts.values()];
  assert.equal(posts.length, 1, 'exactly one draft created');
  const postReq = wpReq.filter(q => q.pathname === '/wp-json/wp/v2/posts' && q.method === 'POST');
  assert.equal(postReq.length, 1);
  const postBody = typeof postReq[0].body === 'string' ? JSON.parse(postReq[0].body) : postReq[0].body;
  // The draft request: the other fields are exactly what Render WP blocks produced.
  assert.equal(postBody.title, rendered.title);
  assert.equal(postBody.slug, rendered.slug);
  assert.equal(postBody.excerpt, rendered.excerpt);
  assert.equal(postBody.status, 'draft');
  assert.deepEqual(postBody.categories, [39]);
  assert.deepEqual(postBody.tags, [77]);
  assert.deepEqual(postBody.meta, { _yoast_wpseo_title: rendered.seo_title, _yoast_wpseo_metadesc: rendered.meta_description, _yoast_wpseo_focuskw: rendered.focus_keyphrase });
  for (const k of Object.keys(rendered)) if (k !== 'content') assert.deepEqual(out[k], rendered[k], `hand back keeps ${k}`);
  // Respond-like node: $json.id from WordPress, Render WP blocks via .first() and .item (pairedItem through the chain).
  const resp = r.nodes[RESPOND][0].items[0];
  assert.equal(resp.post_id, posts[0].id);
  assert.equal(resp.word_count, rendered.word_count);
  assert.equal(resp.title_via_item, rendered.title);
  assert.ok(!JSON.stringify(out.image_report).includes('—'));
  for (const q of wpReq) assert.match(q.headers.authorization || '', /^Basic|redacted/i);
  return { r, out, rendered, postBody, post: posts[0], wpReq, wpMock, media: [...wpMock.state.media.values()] };
}

const fileReqs = r => (r.mocks.commons.requests || []).filter(q => q.pathname.startsWith('/files/'));
const lookupReqs = r => (r.mocks.commons.requests || []).filter(q => q.pathname === '/w/api.php' && q.query.pageids !== undefined);

function assertNoImage({ out, rendered, postBody, post, wpReq }, status) {
  assert.equal(out.featured_media, undefined);
  assert.equal(out.content, rendered.content, 'content unchanged');
  assert.equal(postBody.content, rendered.content);
  assert.ok(!('featured_media' in postBody), 'featured_media absent from the create-draft body');
  assert.equal(post.received_featured_media, '(absent)');
  assert.equal(out.image_report.status, status);
  assert.ok(out.image_report.reason.length > 0, 'the report explains why');
  assert.equal(out.image_report.media_id, null);
  return wpReq;
}

test('(a) full success: photo confirmed by the Commons search, uploaded, alt text set, draft has featured_media and credit', { skip, timeout: 300000 }, async () => {
  const c = await runCase('a-success');
  const { r, out, rendered, postBody, post, wpReq, media } = c;
  // No Commons lookup needed: the pick's page came back in this run's Commons search.
  assert.equal(lookupReqs(r).length, 0);
  const files = fileReqs(r);
  assert.equal(files.length, 1);
  assert.equal(files[0].pathname, '/files/' + PICK_FILE);
  assert.equal(files[0].headers['user-agent'], UA);
  // Media create: raw body, headers, filename, exact bytes.
  const create = wpReq.filter(q => q.pathname === '/wp-json/wp/v2/media' && q.method === 'POST');
  assert.equal(create.length, 1);
  assert.equal(create[0].headers['content-type'], 'image/jpeg');
  assert.equal(create[0].headers['content-disposition'], `attachment; filename="${PICK_NAME}"`);
  const [w, h] = imageSizeFromPath(PICK_FILE);
  const served = makeJpeg(w, h);
  assert.equal(Number(create[0].headers['content-length']), served.length);
  assert.equal(media.length, 1);
  const m = media[0];
  assert.equal(m.upload.mode, 'raw');
  assert.equal(m.upload.bytes, served.length);
  assert.equal(m.upload.sha256, crypto.createHash('sha256').update(served).digest('hex'));
  assert.equal(m.upload.sniffed_mime, 'image/jpeg');
  // Alt text and caption update.
  const upd = wpReq.filter(q => q.pathname === `/wp-json/wp/v2/media/${m.id}` && q.method === 'POST');
  assert.equal(upd.length, 1);
  const updBody = typeof upd[0].body === 'string' ? JSON.parse(upd[0].body) : upd[0].body;
  assert.deepEqual(Object.keys(updBody), ['alt_text', 'caption', 'title', 'description']);
  assert.equal(updBody.alt_text, 'Rolex Submariner Date watch');
  assert.equal(updBody.title, 'Rolex Submariner Date 126610LN');
  assert.match(updBody.caption, /^Photo: <a href="https:\/\/commons\.wikimedia\.org\/w\/index\.php\?curid=148213907">Rolex Submariner Date 126610LN<\/a> by <a href="https:\/\/commons\.wikimedia\.org\/wiki\/User:Horologium42">Horologium42<\/a>, <a href="https:\/\/creativecommons\.org\/licenses\/by-sa\/4\.0\/?">CC BY-SA 4\.0<\/a>, via Wikimedia Commons\.$/);
  assert.match(updBody.description, /Source: <a href="https:\/\/commons\.wikimedia\.org\/w\/index\.php\?curid=148213907">/);
  assert.equal(m.alt_text, 'Rolex Submariner Date watch');
  // The draft.
  assert.equal(out.featured_media, m.id);
  assert.equal(postBody.featured_media, m.id);
  assert.equal(post.featured_media_result, 'set');
  const credit = '<!-- wp:paragraph {"fontSize":"small"} -->\n<p class="has-small-font-size">' + updBody.caption + '</p>\n<!-- /wp:paragraph -->';
  assert.equal(postBody.content, rendered.content + '\n\n' + credit);
  assert.equal(out.content, postBody.content);
  assert.ok(!postBody.content.includes('—'));
  assert.deepEqual(Object.keys(postBody), ['title', 'slug', 'content', 'excerpt', 'featured_media', 'status', 'categories', 'tags', 'meta']);
  assert.equal(out.image_report.status, 'attached');
  assert.equal(out.image_report.reason, '');
  assert.equal(out.image_report.media_id, m.id);
  assert.equal(out.image_report.alt_text_set, true);
  assert.match(out.image_report.source_url, /\/wp-content\/uploads\/\d{4}\/\d{2}\/rolex-submariner-date-watch-openverse-ed296e8f1cb3\.jpg$/);
  assert.equal(out.image_report.licence_check.status, 'confirmed');
  // The used photo is remembered for step 3's "recently used" penalty.
  assert.equal(r.staticData.global.imageFinder.recent.length, 1);
  assert.equal(r.staticData.global.imageFinder.recent[0].key, 'commons:148213907');
});

test('(b) no usable photo anywhere: draft without featured_media, content unchanged, no download or WordPress media call', { skip, timeout: 300000 }, async () => {
  const c = await runCase('b-no-image', {
    openverse: { __default__: 'search-rolex-watch-nothing-usable.json' }, commons: { __default__: 'search-nothing-usable.json' },
  });
  const wpReq = assertNoImage(c, 'no_image');
  assert.equal(fileReqs(c.r).length, 0);
  assert.equal(wpReq.filter(q => q.pathname.startsWith('/wp-json/wp/v2/media')).length, 0);
  assert.equal(c.r.nodes[NAMES.download], undefined);
});

test('(c) download 404: draft without image, report says why, nothing uploaded', { skip, timeout: 300000 }, async () => {
  const c = await runCase('c-download-404', {
    commons: { ...CM_OK, ['/files/' + PICK_FILE]: { status: 404, raw: 'Not Found', contentType: 'text/html' } },
  });
  const wpReq = assertNoImage(c, 'failed');
  assert.match(c.out.image_report.reason, /^download failed: HTTP 404|the photo was not uploaded|not a JPEG/);
  assert.equal(fileReqs(c.r).length, 1);
  assert.equal(wpReq.filter(q => q.pathname.startsWith('/wp-json/wp/v2/media')).length, 0);
});

test('(c2) download returns an HTML page with status 200: not uploaded', { skip, timeout: 300000 }, async () => {
  const c = await runCase('c2-download-html', {
    commons: { ...CM_OK, ['/files/' + PICK_FILE]: { raw: '<html>blocked</html>', contentType: 'text/html' } },
  });
  const wpReq = assertNoImage(c, 'failed');
  assert.match(c.out.image_report.reason, /not a JPEG, PNG or WebP image \(text\/html\)/);
  assert.equal(wpReq.filter(q => q.pathname.startsWith('/wp-json/wp/v2/media')).length, 0);
});

for (const [label, errors, re] of [
  ['d1-upload-401', { 'media.create': { status: 401 } }, /^upload to WordPress failed: HTTP 401/],
  ['d2-upload-413', { 'media.create': { status: 413 } }, /^upload to WordPress failed: HTTP 413/],
  ['d3-upload-403', { 'media.create': { status: 403 } }, /^upload to WordPress failed: HTTP 403/],
]) {
  test(`(d) ${label}: draft without image, no alt text call`, { skip, timeout: 300000 }, async () => {
    const c = await runCase(label, { wp: { errors } });
    const wpReq = assertNoImage(c, 'failed');
    assert.match(c.out.image_report.reason, re);
    assert.equal(wpReq.filter(q => q.pathname === '/wp-json/wp/v2/media' && q.method === 'POST').length, 1);
    assert.equal(wpReq.filter(q => /^\/wp-json\/wp\/v2\/media\/\d+/.test(q.pathname)).length, 0, 'no alt text update');
    assert.equal(c.media.length, 0);
    assert.equal(c.r.nodes[NAMES.alt], undefined);
  });
}

test('(e) alt text update 500: the draft still gets featured_media and the credit', { skip, timeout: 300000 }, async () => {
  const c = await runCase('e-alt-500', { wp: { errors: { 'media.update': { status: 500 } } } });
  const { out, postBody, post, media, rendered } = c;
  assert.equal(media.length, 1);
  assert.equal(out.featured_media, media[0].id);
  assert.equal(postBody.featured_media, media[0].id);
  assert.equal(post.featured_media_result, 'set');
  assert.ok(postBody.content.startsWith(rendered.content + '\n\n<!-- wp:paragraph {"fontSize":"small"} -->'));
  assert.equal(out.image_report.status, 'attached');
  assert.equal(out.image_report.alt_text_set, false);
  assert.match(out.image_report.reason, /^alt text and caption were not set: HTTP 500.*; the featured image is attached$/);
});

test('(f1) Wikimedia-sourced Openverse pick not in the Commons search: confirmed by one imageinfo lookup', { skip, timeout: 300000 }, async () => {
  const c = await runCase('f1-lookup-ok', { commons: { 're:^pageids:': { json: { batchcomplete: true, query: { pages: [PAGE_148] } } } } });
  const look = lookupReqs(c.r);
  assert.equal(look.length, 1);
  assert.deepEqual(Object.keys(look[0].query).sort(), ['action', 'format', 'formatversion', 'iiextmetadatafilter', 'iiextmetadatalanguage', 'iiprop', 'pageids', 'prop'].sort());
  assert.match(look[0].query.pageids, /^148213907(\|\d+)*$/);
  assert.equal(look[0].headers['user-agent'], UA);
  assert.equal(c.out.image_report.status, 'attached');
  assert.equal(c.out.image_report.licence_check.status, 'confirmed');
  assert.equal(c.out.image_report.licence_check.lookup, 'ok');
  assert.equal(c.postBody.featured_media, c.media[0].id);
});

test('(f2) the Commons lookup shows a disallowed licence: the pick is dropped and a non-Wikimedia alternate is used', { skip, timeout: 300000 }, async () => {
  const nc = JSON.parse(JSON.stringify(PAGE_148));
  const em = nc.imageinfo[0].extmetadata;
  em.LicenseShortName = { value: 'CC BY-NC-SA 4.0' };
  em.License = { value: 'cc-by-nc-sa-4.0' };
  em.LicenseUrl = { value: 'https://creativecommons.org/licenses/by-nc-sa/4.0' };
  em.UsageTerms = { value: 'Creative Commons Attribution-NonCommercial-ShareAlike 4.0' };
  const c = await runCase('f2-lookup-nc', { commons: { 're:^pageids:': { json: { batchcomplete: true, query: { pages: [nc] } } } } });
  assert.equal(lookupReqs(c.r).length, 1);
  const lc = c.out.image_report.licence_check;
  assert.equal(lc.checked[0].id, 'ed296e8f-1cb3-5e22-825d-ddbd552c338c');
  assert.equal(lc.checked[0].result, 'rejected');
  assert.match(lc.checked[0].reason, /Commons: licence NC\/ND \(Commons lookup\)/);
  const files = fileReqs(c.r).map(q => q.pathname);
  assert.ok(!files.includes('/files/' + PICK_FILE), 'the rejected photo is never downloaded');
  // All three Wikimedia rows went into ONE lookup; the two the lookup did not return are skipped; the Flickr
  // alternate (no lookup needed) is used.
  assert.equal(lookupReqs(c.r)[0].query.pageids, '148213907|150337412|118904562');
  assert.deepEqual(lc.checked.map(e => e.result), ['rejected', 'skipped', 'skipped', 'used']);
  assert.equal(lc.status, 'alternate used');
  assert.equal(c.out.image_report.status, 'attached');
  assert.equal(c.out.image_report.landing_url, 'https://www.flickr.com/photos/187361540@N04/52790466118');
  assert.equal(c.out.image_report.license_name, 'CC0 1.0');
  assert.equal(c.postBody.featured_media, c.media[0].id);
  assert.ok(c.postBody.content.endsWith('<p class="has-small-font-size">Photo: <a href="https://www.flickr.com/photos/187361540@N04/52790466118">Rolex Submariner</a> by <a href="https://www.flickr.com/photos/187361540@N04">Open Watch Photos</a>, <a href="https://creativecommons.org/publicdomain/zero/1.0/">CC0 1.0</a>, via Flickr.</p>\n<!-- /wp:paragraph -->'));
});

test('(g) Anthropic 500: no photo is used, the draft is created without featured_media', { skip, timeout: 300000 }, async () => {
  const c = await runCase('g-anthropic-500', { anthropic: { __default__: { status: 500, message: 'E2E: overloaded' } } });
  const wpReq = assertNoImage(c, 'no_image');
  assert.match(c.out.image_report.reason, /watch extraction failed/);
  assert.ok(c.out.image_report.extract_error.length > 0);
  assert.equal(fileReqs(c.r).length, 0);
  assert.equal(wpReq.filter(q => q.pathname.startsWith('/wp-json/wp/v2/media')).length, 0);
});

test('(h) test mode (Live mode? false): the image chain does not run at all', { skip, timeout: 300000 }, async () => {
  let wpMock = null;
  const r = await runWorkflow({
    workflow: testWorkflow({ mode: 'test' }),
    fixtures: ANTHROPIC_OK,
    mocks: {
      openverse: { fixtures: OV_OK }, commons: { fixtures: CM_OK },
      wordpress: { start: async o => { wpMock = await startWordpressMock(o); return { url: wpMock.url + '/wp-json', requests: wpMock.requests, close: () => wpMock.close() }; }, rewrite: 'https://watchcentro.com/wp-json', port: PREFERRED_PORT },
    },
    credentials: [CREDENTIAL('{{mock:wordpress}}')],
  });
  assert.equal(r.ok, true);
  assert.ok(r.nodes['Respond: test draft']);
  for (const n of FRAGMENT.nodes) assert.equal(r.nodes[n.name], undefined, `${n.name} must not run in test mode`);
  assert.equal(r.mock_requests.filter(q => q.path && q.path.startsWith('/v1/messages')).length, 0, 'no Anthropic call');
  assert.equal((r.mocks.openverse.requests || []).length, 0);
  assert.equal((r.mocks.commons.requests || []).length, 0);
  assert.equal((r.mocks.wordpress.requests || []).length, 0);
  assert.equal(wpMock.state.media.size, 0);
});

