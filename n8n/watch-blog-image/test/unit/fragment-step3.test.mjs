// Step 3 and cumulative fragments: in sync with build.mjs, wired as specified, HTTP Request 4.2 parameters
// exactly as verified against the Openverse / Commons sources and real n8n 2.42.5 (see test/e2e/README.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readText, SPLIT_CODE, PICK_CODE } from './harness.mjs';
import {
  buildFragment, buildStep3Fragment, buildImageFinder, buildAll, validate, NAMES, OUTPUTS, USER_AGENT, COMMONS_EXTMETADATA,
} from '../../build.mjs';

const load = rel => JSON.parse(readText(rel));
const step2 = load(OUTPUTS.step2);
const step3 = load(OUTPUTS.step3);
const all = load(OUTPUTS.cumulative);
const byName = Object.fromEntries(all.nodes.map(n => [n.name, n]));
const params = n => Object.fromEntries(n.parameters.queryParameters.parameters.map(p => [p.name, p.value]));
const headers = n => Object.fromEntries(n.parameters.headerParameters.parameters.map(p => [p.name, p.value]));

test('every generated file is in sync with build.mjs (run "npm run build" to refresh)', () => {
  assert.deepEqual(Object.keys(buildAll()), [OUTPUTS.step2, OUTPUTS.step3, OUTPUTS.cumulative]);
  assert.deepEqual(step3, buildStep3Fragment());
  assert.deepEqual(all, buildImageFinder());
  assert.deepEqual(step2, buildFragment());
});

test('cumulative fragment = step 2 + step 3 nodes, unchanged, plus the build queries -> split queries link', () => {
  assert.deepEqual(Object.keys(all), ['nodes', 'connections', 'pinData']);
  assert.deepEqual(all.nodes, [...step2.nodes, ...step3.nodes]);
  assert.deepEqual(all.connections, {
    ...step2.connections,
    [NAMES.build]: { main: [[{ node: NAMES.split, type: 'main', index: 0 }]] },
    ...step3.connections,
  });
  const chain = [NAMES.prep, NAMES.llm, NAMES.build, NAMES.split, NAMES.openverse, NAMES.commons, NAMES.pick];
  for (let i = 0; i < chain.length - 1; i++) {
    assert.deepEqual(all.connections[chain[i]].main, [[{ node: chain[i + 1], type: 'main', index: 0 }]], chain[i]);
  }
  assert.equal(all.connections[NAMES.pick], undefined, 'pick photo is the end of the fragment');
});

test('step 3 nodes: names, types, versions no newer than Watch Centro, fixed ids, positions right of step 2', () => {
  assert.deepEqual(step3.nodes.map(n => [n.name, n.type, n.typeVersion]), [
    [NAMES.split, 'n8n-nodes-base.code', 2],
    [NAMES.openverse, 'n8n-nodes-base.httpRequest', 4.2],
    [NAMES.commons, 'n8n-nodes-base.httpRequest', 4.2],
    [NAMES.pick, 'n8n-nodes-base.code', 2],
    [NAMES.sticky3, 'n8n-nodes-base.stickyNote', 1],
  ]);
  const ids = new Set(all.nodes.map(n => n.id));
  assert.equal(ids.size, all.nodes.length);
  const maxX2 = Math.max(...step2.nodes.filter(n => n.type !== 'n8n-nodes-base.stickyNote').map(n => n.position[0]));
  for (const n of step3.nodes) {
    assert.match(n.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, n.name);
    assert.ok(n.position.every(v => Number.isInteger(v) && v % 20 === 0), n.name);
    assert.ok(n.position[1] >= 660, `${n.name} sits below the Watch Centro main row`);
    if (n.type !== 'n8n-nodes-base.stickyNote') assert.ok(n.position[0] > maxX2, `${n.name} is right of step 2`);
  }
  assert.ok(step3.nodes.every(n => n.name.startsWith('Image')));
});

test('Code nodes carry src/split-queries.js and src/pick-photo.js verbatim (runOnceForAllItems)', () => {
  assert.deepEqual(byName[NAMES.split].parameters, { mode: 'runOnceForAllItems', jsCode: SPLIT_CODE.trimEnd() });
  assert.deepEqual(byName[NAMES.pick].parameters, { mode: 'runOnceForAllItems', jsCode: PICK_CODE.trimEnd() });
  for (const name of [NAMES.split, NAMES.pick]) {
    const code = byName[name].parameters.jsCode;
    assert.doesNotMatch(code, /\brequire\(|structuredClone|—/);
  }
  // pick reads the four upstream nodes by literal name (n8n renames these references itself)
  for (const ref of [NAMES.build, NAMES.split, NAMES.openverse, NAMES.commons]) {
    assert.ok(byName[NAMES.pick].parameters.jsCode.includes(`$('${ref}').all()`), ref);
  }
});

test('Openverse node: GET /v1/images/ with q, the four licences, page_size 20, never "mature" or "extension"', () => {
  const n = byName[NAMES.openverse];
  assert.equal(n.parameters.url, 'https://api.openverse.org/v1/images/', 'trailing slash: /v1/images is a 301');
  assert.equal(n.parameters.method, undefined, 'GET is the default');
  assert.equal(n.parameters.authentication, undefined, 'no credential by default');
  assert.deepEqual(params(n), { q: '={{ $json.q }}', license: 'by,by-sa,cc0,pdm', page_size: '20' });
  assert.ok(!('mature' in params(n)), 'mature=false would TURN ON sensitive results (media_serializers.py)');
  // The indexer's "extension" is url.split('.')[-1]; for ".../X.jpg?utm_source=commons.wikimedia.org&..." that is
  // "org&utm_campaign=...", so extension=jpg,... would silently drop Wikimedia rows (review finding).
  assert.ok(!('extension' in params(n)));
  assert.deepEqual(headers(n), { 'User-Agent': USER_AGENT, Accept: 'application/json' });
  assert.deepEqual(n.parameters.options, { batching: { batch: { batchSize: 1, batchInterval: 3500 } }, timeout: 20000 });
  assert.equal(n.onError, 'continueRegularOutput');
  assert.equal(n.retryOnFail, undefined, 'retryOnFail would re-run every item and retry 429s');
});

test('Commons node: generator=search in the File namespace, bitmap only, imageinfo with the needed extmetadata', () => {
  const n = byName[NAMES.commons];
  assert.equal(n.parameters.url, 'https://commons.wikimedia.org/w/api.php');
  assert.deepEqual(params(n), {
    action: 'query', format: 'json', formatversion: '2', generator: 'search',
    gsrsearch: "={{ $('Image: split queries').item.json.q }} filetype:bitmap",
    gsrnamespace: '6', gsrlimit: '20', prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: '1920',
    iiextmetadatafilter: COMMONS_EXTMETADATA.join('|'), iiextmetadatalanguage: 'en',
  });
  assert.ok(!('maxlag' in params(n)), 'maxlag would turn a lag spike into a lost search (HTTP 200 error, no retry)');
  assert.deepEqual(headers(n), { 'User-Agent': USER_AGENT });
  assert.match(USER_AGENT, /^[A-Za-z]+\/\d+\.\d+ \(\+https:\/\/\S+\)$/, 'app/version plus a contact URL (Wikimedia UA policy)');
  assert.doesNotMatch(USER_AGENT, /GPTBot|CCBot|anthropic|axios|python|java/i);
  assert.deepEqual(n.parameters.options, { batching: { batch: { batchSize: 1, batchInterval: 1000 } }, timeout: 20000 });
  assert.equal(n.onError, 'continueRegularOutput');
  assert.equal(n.retryOnFail, undefined);
  // every extmetadata field the pick reads is requested
  for (const f of PICK_CODE.matchAll(/meta\('([A-Za-z]+)'\)/g)) assert.ok(COMMONS_EXTMETADATA.includes(f[1]), f[1]);
});

test('validate() rejects unknown $() references, newer type versions and Watch Centro names', () => {
  const s3 = buildStep3Fragment();
  assert.throws(() => validate(s3), /references unknown node \$\('Image: build queries'\)/);
  const newer = buildImageFinder();
  newer.nodes.find(n => n.name === NAMES.openverse).typeVersion = 4.3;
  assert.throws(() => validate(newer), /newer than Watch Centro/);
  const clash = buildImageFinder();
  clash.nodes[0].name = 'Render WP blocks';
  assert.throws(() => validate(clash), /collides with Watch Centro/);
});

test('no em dashes anywhere in the generated files (house rule)', () => {
  for (const rel of Object.values(OUTPUTS)) assert.ok(!readText(rel).includes('—'), rel);
});

// The read-only Watch Centro export lives outside the repo; compare against it when it is available.
const WC = process.env.WATCH_CENTRO_JSON ||
  '/tmp/claude-0/-home-user-kg/aacd8074-0737-5f90-8758-10d665169dbb/scratchpad/watchcentro.json';
test('no node name or id collides with the Watch Centro export; type versions are ones it already uses', {
  skip: !fs.existsSync(WC) && `Watch Centro export not found (set WATCH_CENTRO_JSON)`,
}, () => {
  const wc = JSON.parse(fs.readFileSync(WC, 'utf8'));
  const wcNames = new Set(wc.nodes.map(n => n.name));
  const wcIds = new Set(wc.nodes.map(n => n.id));
  for (const n of all.nodes) {
    assert.ok(!wcNames.has(n.name), `name collision: ${n.name}`);
    assert.ok(!wcIds.has(n.id), `id collision: ${n.id}`);
    const used = wc.nodes.filter(w => w.type === n.type).map(w => w.typeVersion);
    if (used.length) assert.ok(n.typeVersion <= Math.max(...used), `${n.name}: ${n.typeVersion} > ${Math.max(...used)}`);
  }
  // build.mjs keeps its own copy of the names for the build-time check; it must list them all.
  const src = readText('build.mjs');
  for (const name of wcNames) assert.ok(src.includes(JSON.stringify(name).slice(1, -1)), `build.mjs WATCH_CENTRO_NAMES lacks ${name}`);
  assert.equal(wc.settings.executionOrder, 'v1');
});
