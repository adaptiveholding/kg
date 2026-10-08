// Helpers for the step 3 unit tests: fixtures, record factories, and a runner that wires the Code-node
// bodies the way n8n does (build queries -> split -> Openverse -> Commons -> pick), with one HTTP item
// per split item and pairedItem {item: k} on each, exactly as HTTP Request 4.2 emits them.
import { runCode, readText, clone, SPLIT_CODE, PICK_CODE, BUILD_NODE, SPLIT_NODE, OPENVERSE_NODE, COMMONS_NODE } from './harness.mjs';

export const fx = rel => JSON.parse(readText('test/fixtures/' + rel));
export const OV = name => fx('openverse/' + name);
export const CM = name => fx('commons/' + name);
/** Real n8n 2.42.5 HTTP Request 4.2 item JSON for failures (see the file's _about). */
export const N8N = fx('n8n/http-request-items.json');

export const ovPage = (...results) => ({ result_count: results.length, page_count: results.length ? 1 : 0, page_size: 20, page: 1, results });
export const cmPages = (...pages) => (pages.length ? { batchcomplete: true, query: { pages } } : { batchcomplete: true });

const OV_SUB = OV('search-rolex-submariner.json').results;
const CM_SUB = CM('search-rolex-submariner.json').query.pages;
/** Openverse record i of search-rolex-submariner.json, shallow-patched. */
export const ovRec = (i, patch = {}) => ({ ...clone(OV_SUB[i]), ...patch });
/** Commons page with the given index from search-rolex-submariner.json; meta patches extmetadata values (null deletes). */
export function cmRec(index, { page = {}, info = {}, meta = {} } = {}) {
  const p = clone(CM_SUB.find(x => x.index === index));
  Object.assign(p, page);
  const ii = p.imageinfo && p.imageinfo[0];
  if (ii) {
    Object.assign(ii, info);
    for (const [k, v] of Object.entries(meta)) {
      if (v === null) delete ii.extmetadata[k];
      else ii.extmetadata[k] = { value: v, source: 'commons-desc-page', hidden: '' };
    }
  }
  return p;
}

export const W_SUB = { brand: 'Rolex', model_family: 'Submariner', model: 'Submariner Date', reference: '126610LN', mentioned_as: 'Submariner Date 126610LN', prominence: 'primary' };
export const query = (q, level, patch = {}) => ({
  q, level, brand: 'Rolex', model_family: level === 'brand' || level === 'generic' ? '' : 'Submariner',
  model: level === 'brand' || level === 'generic' ? '' : 'Submariner Date',
  reference: level === 'brand' || level === 'generic' ? '' : '126610LN', prominence: level === 'generic' ? '' : 'primary',
  watch_index: level === 'generic' ? -1 : 0, ...(level === 'generic' ? { brand: '' } : {}), ...patch,
});
export const Q_MODEL = query('Rolex Submariner Date', 'model');
export const Q_FAMILY = query('Rolex Submariner', 'family');
export const Q_BRAND = query('Rolex watch', 'brand');
export const Q_GENERIC = query('luxury wristwatch', 'generic');
/** A post as "Image: build queries" emits it. */
export const post = (queries, patch = {}) => ({
  source: { title: 'Watch market report', slug: 'watch-market-report' }, post_title: 'Watch market report',
  watches: [W_SUB], image_queries: queries, dropped_watches: [], dropped_queries: 0, extract_error: '', ...patch,
});

// spec: function (splitJson, k) -> json, or {q: value, __default__: value}; value: fixture file name, object, or undefined.
function respond(spec, provider, s, k) {
  let v = typeof spec === 'function' ? spec(s, k) : (spec && Object.hasOwn(spec, s.q) ? spec[s.q] : spec && spec.__default__);
  if (v === undefined) v = 'search-empty.json';
  if (typeof v === 'string' && v.endsWith('.json')) return fx(provider + '/' + v);
  return clone(v);
}

/**
 * Run split + pick like n8n would. Returns {out (pick items), json (pick jsons), splits, ov, cm, staticData}.
 * openverse / commons: response specs (see respond). ovItems / cmItems: replace the generated HTTP items.
 * nodes: patch the $() node map (e.g. {[OPENVERSE_NODE]: {items: [], executed: false}}).
 */
export async function pipeline({ posts, openverse, commons, staticData = {}, ovItems, cmItems, nodes = {}, code = PICK_CODE } = {}) {
  const postItems = posts.map((json, i) => ({ json, pairedItem: { item: i } }));
  const splits = await runCode(SPLIT_CODE, { input: postItems });
  const ov = ovItems ? ovItems(splits) : splits.map((s, k) => ({ json: respond(openverse, 'openverse', s.json, k), pairedItem: { item: k } }));
  const cm = cmItems ? cmItems(splits, ov) : ov.map((o, k) => ({ json: respond(commons, 'commons', splits[k] ? splits[k].json : {}, k), pairedItem: { item: k } }));
  const map = { [BUILD_NODE]: postItems, [SPLIT_NODE]: splits, [OPENVERSE_NODE]: ov, [COMMONS_NODE]: cm, ...nodes };
  const out = await runCode(code, { input: cm, nodes: map, staticData });
  return { out, json: out.map(o => o.json), splits, ov, cm, staticData };
}

/** One post, one query: the given Openverse and Commons responses for it. */
export async function single(q, ovResponse, cmResponse, opts = {}) {
  const r = await pipeline({
    posts: [post([q])], openverse: () => ovResponse, commons: () => cmResponse, ...opts,
  });
  return r.json[0];
}
