// Steps 4-6 fragment and the full image-finder fragment: wiring, HTTP Request parameters as verified in real
// n8n 2.42.5 and the WordPress source (test/e2e/README.md), no clashes with Watch Centro, and the one-line
// change to a COPY of the real "WordPress: create draft" node.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readText } from './harness.mjs';
import {
  buildStep4Fragment, NAMES, OUTPUTS, USER_AGENT, COMMONS_EXTMETADATA, WORDPRESS_CREDENTIALS, MAX_PHOTO_BYTES,
  CREATE_DRAFT_PATCH, patchCreateDraft,
} from '../../build.mjs';

const load = rel => JSON.parse(readText(rel));
const step4 = load(OUTPUTS.step4);
const all = load(OUTPUTS.cumulative);
const byName = Object.fromEntries(all.nodes.map(n => [n.name, n]));
const headers = n => Object.fromEntries(n.parameters.headerParameters.parameters.map(p => [p.name, p.value]));
const WC_FILE = '/tmp/claude-0/-home-user-kg/aacd8074-0737-5f90-8758-10d665169dbb/scratchpad/watchcentro.json';
const SUMMARY = load('test/fixtures/watchcentro/workflow-summary.json');
const CREATE_DRAFT = load('test/fixtures/watchcentro/create-draft-node.json');
const realWc = fs.existsSync(WC_FILE) ? JSON.parse(fs.readFileSync(WC_FILE, 'utf8')) : null;

test('step 4-6 nodes: names, types, versions, fixed ids', () => {
  assert.deepEqual(step4, buildStep4Fragment());
  assert.deepEqual(step4.nodes.map(n => [n.name, n.type, n.typeVersion]), [
    [NAMES.plan, 'n8n-nodes-base.code', 2],
    [NAMES.needsLookup, 'n8n-nodes-base.if', 2.2],
    [NAMES.lookup, 'n8n-nodes-base.httpRequest', 4.2],
    [NAMES.confirm, 'n8n-nodes-base.code', 2],
    [NAMES.hasPhoto, 'n8n-nodes-base.if', 2.2],
    [NAMES.download, 'n8n-nodes-base.httpRequest', 4.2],
    [NAMES.photoOk, 'n8n-nodes-base.if', 2.2],
    [NAMES.upload, 'n8n-nodes-base.httpRequest', 4.2],
    [NAMES.uploaded, 'n8n-nodes-base.if', 2.2],
    [NAMES.alt, 'n8n-nodes-base.httpRequest', 4.2],
    [NAMES.handBack, 'n8n-nodes-base.code', 2],
    [NAMES.sticky4, 'n8n-nodes-base.stickyNote', 1],
  ]);
  for (const n of step4.nodes) {
    assert.match(n.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, n.name);
    assert.ok(n.name.startsWith('Image'), n.name);
    if (n.type === 'n8n-nodes-base.code') assert.equal(n.parameters.mode, 'runOnceForAllItems');
    if (n.type === 'n8n-nodes-base.httpRequest') assert.equal(n.onError, 'continueRegularOutput', n.name);
  }
});

test('full fragment: entry is prep post text, exit is hand back post, every node reachable', () => {
  const targets = new Set();
  const sources = new Set(Object.keys(all.connections));
  for (const byType of Object.values(all.connections)) for (const outs of Object.values(byType)) for (const o of outs) for (const c of o) targets.add(c.node);
  const work = all.nodes.filter(n => n.type !== 'n8n-nodes-base.stickyNote');
  assert.deepEqual(work.filter(n => !targets.has(n.name)).map(n => n.name), [NAMES.prep, NAMES.model]);
  assert.deepEqual(work.filter(n => !sources.has(n.name)).map(n => n.name), [NAMES.handBack]);
  // Fan-in to hand back post: every place the image chain can stop.
  const into = Object.entries(all.connections).flatMap(([src, b]) => (b.main || []).flatMap((o, idx) => o.filter(c => c.node === NAMES.handBack).map(() => `${src}#${idx}`)));
  assert.deepEqual(into.sort(), [`${NAMES.alt}#0`, `${NAMES.hasPhoto}#1`, `${NAMES.photoOk}#1`, `${NAMES.uploaded}#1`].sort());
  assert.deepEqual(all.connections[NAMES.needsLookup].main, [[{ node: NAMES.lookup, type: 'main', index: 0 }], [{ node: NAMES.confirm, type: 'main', index: 0 }]]);
  assert.deepEqual(all.connections[NAMES.pick].main, [[{ node: NAMES.plan, type: 'main', index: 0 }]]);
});

test('no node name or id collides with Watch Centro (real export when present, else the recorded names)', () => {
  const names = realWc ? realWc.nodes.map(n => n.name) : SUMMARY.names;
  const ids = realWc ? realWc.nodes.map(n => n.id) : [];
  if (realWc) assert.deepEqual(SUMMARY.names, names, 'test/fixtures/watchcentro/workflow-summary.json is stale');
  for (const n of all.nodes) {
    assert.ok(!names.includes(n.name), n.name);
    assert.ok(!ids.includes(n.id), n.id);
  }
  // typeVersions no newer than the ones Watch Centro uses.
  if (realWc) {
    const max = {};
    for (const n of realWc.nodes) max[n.type] = Math.max(max[n.type] || 0, n.typeVersion);
    for (const n of all.nodes) assert.ok(n.typeVersion <= max[n.type], `${n.name} ${n.type} ${n.typeVersion}`);
  }
});

test('Commons lookup: one imageinfo request by page id, step 3 User-Agent and extmetadata fields', () => {
  const n = byName[NAMES.lookup];
  assert.equal(n.parameters.url, 'https://commons.wikimedia.org/w/api.php');
  assert.deepEqual(Object.fromEntries(n.parameters.queryParameters.parameters.map(p => [p.name, p.value])), {
    action: 'query', format: 'json', formatversion: '2', pageids: "={{ $json.licence_check.lookup_pageids.slice(0, 50).join('|') }}",
    prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiextmetadatafilter: COMMONS_EXTMETADATA.join('|'), iiextmetadatalanguage: 'en',
  });
  assert.deepEqual(headers(n), { 'User-Agent': USER_AGENT });
  assert.ok(n.parameters.options.timeout > 0);
});

test('download, upload and alt text parameters', () => {
  const dl = byName[NAMES.download];
  assert.equal(dl.parameters.url, '={{ $json.image.file_url }}');
  assert.deepEqual(headers(dl), { 'User-Agent': USER_AGENT });
  assert.deepEqual(dl.parameters.options.response, { response: { responseFormat: 'file', outputPropertyName: 'photo' } });
  assert.equal(dl.parameters.options.timeout, 30000);
  assert.equal(dl.credentials, undefined);

  const up = byName[NAMES.upload];
  assert.equal(up.parameters.method, 'POST');
  assert.equal(up.parameters.url, 'https://watchcentro.com/wp-json/wp/v2/media');
  assert.equal(up.parameters.authentication, 'predefinedCredentialType');
  assert.equal(up.parameters.nodeCredentialType, 'wordpressApi');
  assert.deepEqual(up.credentials, { wordpressApi: { id: 'LPEXDGdEBrfFA7NC', name: 'WatchCentro' } });
  assert.deepEqual(up.credentials, CREATE_DRAFT.credentials, 'same credential as WordPress: create draft');
  assert.deepEqual(WORDPRESS_CREDENTIALS, CREATE_DRAFT.credentials);
  assert.deepEqual(headers(up), {
    'Content-Type': '={{ $binary.photo.mimeType }}',
    'Content-Disposition': '=attachment; filename="{{ $json.image.download_filename }}"',
  });
  assert.equal(up.parameters.contentType, 'binaryData');
  assert.equal(up.parameters.inputDataFieldName, 'photo');
  assert.equal(up.parameters.options.timeout, 60000);
  assert.equal(up.parameters.options.response, undefined, 'default response handling: failures become error items');

  const alt = byName[NAMES.alt];
  assert.equal(alt.parameters.url, '=https://watchcentro.com/wp-json/wp/v2/media/{{ $json.id }}');
  assert.equal(alt.parameters.specifyBody, 'json');
  assert.equal(alt.parameters.jsonBody, `={{ JSON.stringify($('${NAMES.confirm}').item.json.media_update) }}`);
  assert.ok(!alt.parameters.jsonBody.includes(NAMES.upload), 'never reference the upload node from an HTTP parameter');
  assert.deepEqual(alt.credentials, CREATE_DRAFT.credentials);
});

test('IF conditions: strict boolean, Watch Centro style', () => {
  const cond = n => byName[n].parameters.conditions.conditions[0].leftValue;
  for (const n of [NAMES.needsLookup, NAMES.hasPhoto, NAMES.photoOk, NAMES.uploaded]) {
    const c = byName[n].parameters.conditions;
    assert.equal(c.options.typeValidation, 'strict');
    assert.deepEqual(c.conditions[0].operator, { type: 'boolean', operation: 'true', singleValue: true });
    assert.equal(c.conditions[0].rightValue, true);
  }
  assert.match(cond(NAMES.photoOk), new RegExp(`<= ${MAX_PHOTO_BYTES}\\b`));
  assert.match(cond(NAMES.photoOk), /'image\/jpeg','image\/png','image\/webp'/);
  assert.equal(cond(NAMES.uploaded), "={{ typeof $json.id === 'number' && $json.id > 0 }}");
});

test('photo OK? accepts a mimeType with parameters, like the hand back photoProblem (review fix)', () => {
  const expr = byName[NAMES.photoOk].parameters.conditions.conditions[0].leftValue.replace(/^=\{\{/, '').replace(/\}\}$/, '');
  const ok = bin => new Function('$binary', 'return (' + expr + ');')(bin);
  assert.equal(ok({ photo: { mimeType: 'image/jpeg; charset=binary', bytes: 3911 } }), true);
  assert.equal(ok({ photo: { mimeType: 'IMAGE/PNG', bytes: 10 } }), true);
  assert.equal(ok({ photo: { mimeType: 'text/html; charset=utf-8', bytes: 10 } }), false);
  assert.equal(ok({ photo: { mimeType: 'image/jpeg', bytes: MAX_PHOTO_BYTES + 1 } }), false);
  assert.equal(ok({}), false);
});

test('the hand back limits match the photo OK? IF node', () => {
  const code = byName[NAMES.handBack].parameters.jsCode;
  assert.match(code, /const MAX_PHOTO_BYTES = 15 \* 1024 \* 1024;/);
  assert.equal(MAX_PHOTO_BYTES, 15 * 1024 * 1024);
  assert.match(code, /const PHOTO_MIMES = \['image\/jpeg', 'image\/png', 'image\/webp'\];/);
});

// Evaluate the create-draft jsonBody expression the way n8n does for these plain $json reads.
const evalBody = (node, json) => JSON.parse(new Function('$json', `return ${node.parameters.jsonBody.replace(/^=\{\{/, '').replace(/\}\}$/, '')};`)(json));

test('create draft patch: a copy of the real node gets exactly one new line, featured_media only when set', () => {
  const real = realWc ? realWc.nodes.find(n => n.name === 'WordPress: create draft') : CREATE_DRAFT;
  if (realWc) assert.deepEqual(CREATE_DRAFT, real, 'test/fixtures/watchcentro/create-draft-node.json is stale');
  const patched = patchCreateDraft(real);
  assert.notEqual(patched, real);
  assert.ok(!real.parameters.jsonBody.includes('featured_media'), 'the original is not modified');
  const before = real.parameters.jsonBody.split('\n');
  const after = patched.parameters.jsonBody.split('\n');
  assert.equal(after.length, before.length + 1);
  const added = after.filter((l, i) => l !== before[i - (i > after.indexOf('  featured_media: $json.featured_media,') ? 1 : 0)]);
  assert.deepEqual(added, ['  featured_media: $json.featured_media,']);
  assert.equal(after[after.indexOf('  featured_media: $json.featured_media,') - 1], '  excerpt: $json.excerpt,');
  assert.deepEqual({ ...patched, parameters: { ...patched.parameters, jsonBody: '' } }, { ...real, parameters: { ...real.parameters, jsonBody: '' } });
  assert.equal(CREATE_DRAFT_PATCH.after, CREATE_DRAFT_PATCH.before + '  featured_media: $json.featured_media,\n');

  const post = { title: 'T', slug: 's', content: '<p>x</p>', excerpt: 'e', seo_title: 'S', meta_description: 'M', focus_keyphrase: 'F' };
  const with_ = evalBody(patched, { ...post, featured_media: 1001 });
  assert.equal(with_.featured_media, 1001);
  const without = evalBody(patched, post);
  assert.ok(!('featured_media' in without), 'undefined is dropped by JSON.stringify');
  assert.deepEqual(without, evalBody(real, post), 'without an image the body is byte-identical to today');
  assert.deepEqual(Object.keys(with_), ['title', 'slug', 'content', 'excerpt', 'featured_media', 'status', 'categories', 'tags', 'meta']);
  assert.throws(() => patchCreateDraft(patched), /already has featured_media/);
});
