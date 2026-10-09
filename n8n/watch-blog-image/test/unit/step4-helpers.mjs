// Helpers for the step 4 to 6 unit tests: the three new Code bodies, real n8n 2.42.5 HTTP Request items for the
// download / upload / alt text nodes, and node maps that describe which branch an item took to "Image: hand back post".
import vm from 'node:vm';
import { runCode, readText, clone } from './harness.mjs';

export const PLAN_CODE = readText('src/plan-licence-check.js');
export const CONFIRM_CODE = readText('src/confirm-licence.js');
export const HANDBACK_CODE = readText('src/hand-back-post.js');

export const N = {
  build: 'Image: build queries',
  commonsSearch: 'Image: search Commons',
  pick: 'Image: pick photo',
  plan: 'Image: plan licence check',
  lookup: 'Image: look up licence on Commons',
  confirm: 'Image: confirm licence',
  download: 'Image: download photo',
  upload: 'Image: upload to WordPress',
  alt: 'Image: set alt text and caption',
};

/** Real item JSON from n8n 2.42.5 (see the file's _about). */
export const WP = JSON.parse(readText('test/fixtures/n8n/wordpress-items.json'));
/** The real "Render WP blocks" output for the steel fixture post. */
export const SOURCE = JSON.parse(readText('test/fixtures/rendered-posts.json')).steel;

/** Top-level declarations (function NAME / const NAME =) of a Code body, verbatim. */
export function declaration(src, name) {
  const lines = src.split('\n');
  const start = lines.findIndex(l => l.startsWith(`function ${name}(`) || l.startsWith(`const ${name} =`));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && lines[end] !== '' && !/^[^\s})\]]/.test(lines[end])) end++;
  return lines.slice(start, end).join('\n');
}
/** The text between two marker lines (inclusive). */
export function between(src, startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  const b = src.indexOf(endMarker, a);
  if (a < 0 || b < 0) return null;
  return src.slice(a, b + endMarker.length);
}
export const CREDIT_START = '// --- Credit line: this block is identical';
export const CREDIT_END = '// --- End of credit line ---';

/** The credit-line helpers of a Code body as functions: {esc, cleanText, safeUrl, creditHtml, creditBlock}. */
export function creditHelpers(code = HANDBACK_CODE) {
  const block = between(code, CREDIT_START, CREDIT_END);
  const ctx = vm.createContext({});
  return vm.runInContext(`${block}\n({ esc, cleanText, safeUrl, creditHtml, creditBlock })`, ctx);
}

/** A picked image (step 3 shape) with patches. */
export function image(patch = {}) {
  return {
    provider: 'openverse', source_name: 'Wikimedia Commons', id: 'ed296e8f-1cb3-5e22-825d-ddbd552c338c',
    title: 'Rolex Submariner Date 126610LN', creator: 'Horologium42', creator_url: 'https://commons.wikimedia.org/wiki/User:Horologium42',
    license: 'by-sa', license_version: '4.0', license_name: 'CC BY-SA 4.0', license_url: 'https://creativecommons.org/licenses/by-sa/4.0/',
    landing_url: 'https://commons.wikimedia.org/w/index.php?curid=148213907',
    file_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4c/Rolex_Submariner_Date_126610LN.jpg/1920px-Rolex_Submariner_Date_126610LN.jpg',
    width: 1920, height: 1440, extension: 'jpg', mime: 'image/jpeg', attribution_required: true,
    query: { rank: 0, q: 'Rolex Submariner Date', level: 'model', watch_index: 0 }, score: 53, reasons: [],
    alt_text: 'Rolex Submariner Date watch',
    credit_text: 'Photo: "Rolex Submariner Date 126610LN" by Horologium42, CC BY-SA 4.0, via Wikimedia Commons',
    download_filename: 'rolex-submariner-date-watch-openverse-ed296e8f1cb3.jpg',
    recent_keys: ['commons:148213907', 'openverse:ed296e8f-1cb3-5e22-825d-ddbd552c338c'],
    ...patch,
  };
}
export const FLICKR_ALT = image({
  provider: 'openverse', source_name: 'Flickr', id: 'a765171e-3b3a-5da9-9e17-ebaae6a89b6f', title: 'Rolex Submariner Date on the wrist',
  creator: 'chronoshots', creator_url: 'https://www.flickr.com/photos/41894170373@N01', license: 'by', license_version: '2.0',
  license_name: 'CC BY 2.0', license_url: 'https://creativecommons.org/licenses/by/2.0/',
  landing_url: 'https://www.flickr.com/photos/41894170373@N01/53218846721',
  file_url: 'https://live.staticflickr.com/65535/53218846721_9c1e4b7a2f_b.jpg', width: 1024, height: 683,
  credit_text: 'Photo: "Rolex Submariner Date on the wrist" by chronoshots, CC BY 2.0, via Flickr',
  download_filename: 'rolex-submariner-date-watch-openverse-a765171e3b3a.jpg', recent_keys: ['flickr:53218846721'],
});
export const COMMONS_ALT = image({
  provider: 'commons', source_name: 'Wikimedia Commons', id: '34418877', title: 'Rolex Submariner Date 116610LN Uhrenmesse 2014',
  creator: 'Kronograph', creator_url: 'https://commons.wikimedia.org/wiki/User:Kronograph', license: 'by-sa', license_version: '3.0',
  license_name: 'CC BY-SA 3.0 DE', license_url: 'https://creativecommons.org/licenses/by-sa/3.0/de/',
  landing_url: 'https://commons.wikimedia.org/wiki/File:Rolex_Submariner_Date_116610LN_Uhrenmesse_2014.jpg',
  file_url: 'https://upload.wikimedia.org/wikipedia/commons/c/cb/Rolex_Submariner_Date_116610LN_Uhrenmesse_2014.jpg',
  download_filename: 'rolex-submariner-date-watch-commons-34418877.jpg', recent_keys: ['commons:34418877'],
});

/** A "Image: pick photo" item json. */
export function pickJson(img = image(), alternates = [], patch = {}) {
  return {
    source: clone(SOURCE), post_title: SOURCE.title,
    watches: [{ brand: 'Rolex', model_family: 'Submariner', model: 'Submariner Date', reference: '126610LN', mentioned_as: 'Submariner Date 126610LN', prominence: 'primary' }],
    image_queries: [{ q: 'Rolex Submariner Date', level: 'model' }],
    image: img, image_error: img ? '' : 'no licence-safe relevant photo found for 4 queries; openverse: 4x HTTP 429; commons: 0 results in 4 searches, 0 passed',
    alternates, search_log: [
      { rank: 0, q: 'Rolex Submariner Date', provider: 'openverse', status: 'ok', results: 4, passed: 4 },
      { rank: 0, q: 'Rolex Submariner Date', provider: 'commons', status: 'error', http_error: 'HTTP 503', results: 0, passed: 0 },
    ],
    ...patch,
  };
}

/** A Commons imageinfo page (formatversion 2) for a file, with extmetadata values. */
export function commonsPage(pageid, file, meta = {}, patch = {}) {
  const em = {};
  const defaults = {
    LicenseShortName: 'CC BY-SA 4.0', License: 'cc-by-sa-4.0', LicenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0',
    UsageTerms: 'Creative Commons Attribution-Share Alike 4.0', AttributionRequired: 'true', Restrictions: '',
    Artist: '<a href="//commons.wikimedia.org/wiki/User:Horologium42" title="User:Horologium42">Horologium42</a>',
  };
  for (const [k, v] of Object.entries({ ...defaults, ...meta })) if (v !== null) em[k] = { value: v, source: 'commons-desc-page', hidden: '' };
  return {
    pageid: Number(pageid), ns: 6, title: 'File:' + file.replace(/_/g, ' '), imagerepository: 'local',
    imageinfo: [{
      size: 2000000, width: 4032, height: 3024,
      url: `https://upload.wikimedia.org/wikipedia/commons/4/4c/${file}?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=original`,
      descriptionurl: `https://commons.wikimedia.org/wiki/File:${file}`, descriptionshorturl: `https://commons.wikimedia.org/w/index.php?curid=${pageid}`,
      mime: 'image/jpeg', extmetadata: em,
    }],
    ...patch,
  };
}
export const PAGE_148 = (meta, patch) => commonsPage(148213907, 'Rolex_Submariner_Date_126610LN.jpg', meta, patch);
export const lookupAnswer = (...pages) => ({ batchcomplete: true, query: { pages } });

/** Run "Image: plan licence check" on pick jsons. build: build-queries jsons (default: no extract error). */
export function runPlan(picks, { build, commonsItems, code = PLAN_CODE } = {}) {
  const nodes = {
    [N.build]: (build || picks.map(() => ({ extract_error: '' }))).map(json => ({ json })),
    [N.commonsSearch]: commonsItems === undefined ? { items: [], executed: false } : commonsItems.map(json => ({ json })),
  };
  return runCode(code, { input: picks.map((json, i) => ({ json, pairedItem: [{ item: i }] })), nodes });
}

/**
 * Run "Image: confirm licence". Either from the plan item (no lookup) or from a lookup answer, in which case
 * the plan item is reached with itemMatching like n8n does.
 */
export async function runConfirm(planJson, lookupJson, { code = CONFIRM_CODE, planNode } = {}) {
  if (lookupJson === undefined) return runCode(code, { input: [{ json: planJson, pairedItem: { item: 0 } }], nodes: {} });
  const nodes = { [N.plan]: planNode || [{ json: planJson, pairedItem: { item: 0 } }] };
  return runCode(code, { input: [{ json: lookupJson, pairedItem: { item: 0 } }], nodes });
}

/** Plan + confirm in one go: the lookup answer is only used when the plan asked for one. */
export async function planAndConfirm(pick, { lookup, build, commonsItems } = {}) {
  const [planItem] = await runPlan([pick], { build, commonsItems });
  const plan = planItem.json;
  const needed = plan.licence_check.lookup_pageids.length > 0;
  const lookupJson = needed ? (typeof lookup === 'function' ? lookup(plan.licence_check.lookup_pageids) : (lookup ?? lookupAnswer())) : undefined;
  const [out] = await runConfirm(plan, lookupJson);
  return { plan, out: out.json, item: out, lookupJson };
}

/** The confirm-node json for a post (what "Image: has photo?" sees). */
export async function confirmed(pick = pickJson()) {
  return (await planAndConfirm(pick, { commonsItems: [lookupAnswer(PAGE_148())] })).out;
}

const binaryOf = meta => ({ photo: { ...clone(WP.download_binary_meta), ...meta } });
const notRun = { items: [], executed: false };
const offPath = items => ({ items, itemMatching: 'throw' });

/**
 * Inputs and node map of "Image: hand back post" for one post that ended at `stage`:
 *   'no-photo'   from "Image: has photo?" false (input = confirm item)
 *   'download'   from "Image: photo OK?" false (input = download item: download json, binary unless failed)
 *   'upload'     from "Image: uploaded?" false (input = upload item)
 *   'alt'        from "Image: set alt text and caption" (input = alt item)
 * download: download item json (default: confirm json, i.e. success); binary: photo metadata patch or null.
 */
export function handBackSetup(conf, { stage, download, binary = {}, upload = WP.upload_201, alt = WP.alt_200, pickCount = 1, extraNodes = {} } = {}) {
  const confItem = { json: conf, pairedItem: { item: 0 } };
  const dlJson = download === undefined ? conf : download;
  const dlItem = { json: dlJson, pairedItem: { item: 0 } };
  if (binary !== null && !(isObj(dlJson) && dlJson.error)) dlItem.binary = binaryOf(binary);
  const upItem = { json: upload, pairedItem: { item: 0 } };
  const altItem = { json: alt, pairedItem: { item: 0 } };
  const pickItems = Array.from({ length: pickCount }, () => ({ json: conf }));
  const nodes = {
    [N.pick]: pickItems, [N.plan]: [confItem], [N.confirm]: [confItem],
    [N.download]: notRun, [N.upload]: notRun, [N.alt]: notRun,
  };
  let input;
  if (stage === 'no-photo') input = confItem;
  if (stage === 'download' || stage === 'upload' || stage === 'alt') nodes[N.download] = [dlItem];
  if (stage === 'download') input = { ...dlItem };
  if (stage === 'upload' || stage === 'alt') nodes[N.upload] = [upItem];
  if (stage === 'upload') input = upItem;
  if (stage === 'alt') { nodes[N.alt] = [altItem]; input = altItem; }
  if (!input) throw new Error('unknown stage ' + stage);
  return { input: [input], nodes: { ...nodes, ...extraNodes } };
}
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export async function runHandBack(conf, opts = {}) {
  const { input, nodes } = handBackSetup(conf, opts);
  const out = await runCode(opts.code || HANDBACK_CODE, { input: opts.input || input, nodes, staticData: opts.staticData });
  return out;
}

export { notRun, offPath, binaryOf };
