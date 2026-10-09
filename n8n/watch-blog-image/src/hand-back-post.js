// Image finder, steps 5 and 6: hand the post back to "WordPress: create draft", with the featured image when the
// photo was uploaded. This is the exit of the fragment. It is wired from every place the image chain can end:
//   "Image: has photo?" false, "Image: photo OK?" false, "Image: uploaded?" false, "Image: set alt text and caption".
// Output, exactly one item per input item: the original "Render WP blocks" item (the `source` that step 2 kept)
// with every field byte-identical, plus
//   featured_media: the media id, ONLY when the upload succeeded (absent otherwise, so JSON.stringify drops it)
//   content:        source.content + a small-print credit paragraph, ONLY when the image is attached
//   image_report:   {status: attached | no_image | failed, reason, media_id, source_url, credit_text, license_name,
//                    landing_url, provider, photo_title, alt_text_set, licence_check, search_summary, extract_error}
// pairedItem {item: i} keeps .item references to Render WP blocks working in the nodes after it.
// Which steps ran for an item is read with itemMatching (a node that is not on the item's path throws); with a
// single post, an executed node is on the path. A failed alt text update keeps the featured image.
// When the photo is attached, its keys are added to $getWorkflowStaticData('global').imageFinder.recent (step 3
// reads that list: a recently used photo scores -40). This node only runs on the Live mode? true branch, a run
// that "Record run id" also saves static data in. Nothing here throws.

// --- Config ---------------------------------------------------------------------------------------
// Same limits as the "Image: photo OK?" IF node (keep them in step).
const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
const PHOTO_MIMES = ['image/jpeg', 'image/png', 'image/webp'];
// Record an attached photo in the static data (see above), keeping the newest RECENT_LIMIT entries.
const REMEMBER_USED = true;
const RECENT_LIMIT = 30;

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const toCode = v => { const n = typeof v === 'string' ? parseInt(v, 10) : v; return Number.isInteger(n) && n >= 100 && n <= 599 ? n : 0; };
const mediaId = v => (Number.isInteger(v) && v > 0 ? v : (typeof v === 'string' && /^[1-9]\d{0,14}$/.test(v) ? Number(v) : null));

// --- Credit line: this block is identical in confirm-licence.js and hand-back-post.js (a unit test checks) ---
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ESCAPES[ch]);
// One line of plain text: no control or invisible direction characters, no em or en dashes (house rule), bounded.
function cleanText(v, max) {
  let t = typeof v === 'string' ? v : (typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
  t = t.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ')
    .replace(/[\u2012-\u2015\u2212]/g, '-').replace(/\s+/g, ' ').trim();
  if (max && t.length > max) t = t.slice(0, max - 3).replace(/\s+\S*$/, '') + '...';
  return t;
}
// The URL when it is an absolute http(s) URL that is safe in a double-quoted href, else ''. Rejects javascript:,
// data: and other schemes, protocol-relative and relative URLs, user:password@ hosts, odd hosts, whitespace,
// quotes, angle brackets, backslashes and invisible direction characters.
function safeUrl(v) {
  if (typeof v !== 'string') return '';
  const u = v.trim();
  if (!u || u.length > 2000) return '';
  if (/[\u0000- \u007f-\u009f"<>\\`\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/.test(u)) return '';
  const m = u.match(/^https?:\/\/([^/?#]*)(?:[/?#]|$)/i);
  if (!m || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?::\d{1,5})?$/i.test(m[1])) return '';
  return u;
}
// "Photo: <a href=landing>title</a> by <a href=creator_url>creator</a>, <a href=license_url>licence</a>, via source."
// A part is linked only when its URL passes safeUrl; every value is escaped. CC0 and public domain photos without
// a known creator leave out "by ...".
function creditHtml(img) {
  const link = (url, text) => (safeUrl(url) ? `<a href="${esc(safeUrl(url))}">${esc(text)}</a>` : esc(text));
  const pd = img.license === 'cc0' || img.license === 'pdm';
  let creator = cleanText(img.creator, 100);
  if (pd && /^unknown author$/i.test(creator)) creator = '';
  if (!pd && !creator) creator = 'Unknown author';
  const licence = cleanText(img.license_name, 60);
  const source = cleanText(img.source_name, 80);
  let html = 'Photo: ' + link(img.landing_url, cleanText(img.title, 150) || 'Untitled');
  if (creator) html += ' by ' + (/^unknown author$/i.test(creator) ? esc(creator) : link(img.creator_url, creator));
  if (licence) html += ', ' + link(img.license_url, licence);
  if (source) html += ', via ' + esc(source);
  return html + '.';
}
// The credit as one small-print paragraph block, like the disclaimer at the end of "Render WP blocks".
const creditBlock = img => '<!-- wp:paragraph {"fontSize":"small"} -->\n<p class="has-small-font-size">' + creditHtml(img) +
  '</p>\n<!-- /wp:paragraph -->';
// --- End of credit line ---

// --- HTTP results ----------------------------------------------------------------------------------------------
// Text of an error body: a WordPress {code, message} object, an HTML page (its <title>) or plain text.
function bodyText(body) {
  if (isObj(body)) {
    const code = cleanText(body.code, 60);
    const msg = cleanText(String(typeof body.message === 'string' ? body.message : '').replace(/<[^>]*>/g, ' '), 160);
    return [code, msg].filter(Boolean).join(': ');
  }
  if (typeof body !== 'string') return '';
  const title = body.match(/<title[^>]*>([^<]*)<\/title>/i);
  if (title) return cleanText(title[1], 120).replace(/^\d{3}\s+/, '');
  if (/<[a-z!]/i.test(body)) return '';
  return cleanText(body, 120);
}
// An n8n HTTP Request error (AxiosError.toJSON() without credentials, NodeApiError with credentials, or a string)
// -> short label such as "HTTP 401 rest_cannot_create: Sorry, ...", "timeout", "connection refused".
function errorLabel(err) {
  if (typeof err === 'string') return cleanText(err, 200) || 'request failed';
  if (!isObj(err)) return 'request failed';
  const cause = isObj(err.cause) ? err.cause : {};
  const texts = [cause.message, err.message].filter(t => typeof t === 'string');
  let status = toCode(err.status) || toCode(err.httpCode) || toCode(err.statusCode);
  let body = null;
  for (const t of texts) {
    const m = t.match(/^(\d{3}) - ([\s\S]*)$/);
    if (!m) continue;
    status = status || toCode(m[1]);
    try { body = JSON.parse(m[2]); if (typeof body === 'string' && /^[[{]/.test(body.trim())) body = JSON.parse(body); } catch (e) { body = m[2]; }
    break;
  }
  if (status) {
    const text = bodyText(body) || bodyText(err.description);
    return 'HTTP ' + status + (text ? ' ' + text : '');
  }
  const all = texts.concat([String(err.code || '')]).join(' ');
  if (/ECONNABORTED|ETIMEDOUT|timeout|timed out/i.test(all)) return 'timeout';
  if (/ECONNREFUSED|refused/i.test(all)) return 'connection refused';
  if (/ENOTFOUND|EAI_AGAIN/i.test(all)) return 'host not found';
  if (/ECONNRESET|socket hang up/i.test(all)) return 'connection reset';
  return cleanText(texts[0] || err.code || '', 160) || 'request failed';
}
// One HTTP Request output item -> {ok, status, body} or {ok: false, error}. Handles plain bodies, the
// neverError + fullResponse shape {body | data, headers, statusCode} and onError failure items {error}.
function httpResult(json) {
  if (!isObj(json)) return { ok: false, error: 'no response' };
  if (toCode(json.statusCode) && ('body' in json || 'data' in json || 'headers' in json)) {
    const status = toCode(json.statusCode);
    let body = 'body' in json ? json.body : json.data;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { /* HTML or text */ } }
    if (status >= 200 && status < 300) return { ok: true, status, body };
    const text = bodyText(body);
    return { ok: false, error: 'HTTP ' + status + (text ? ' ' + text : '') };
  }
  if (json.error !== undefined && json.error !== null) return { ok: false, error: errorLabel(json.error) };
  return { ok: true, status: 0, body: json };
}
// Why a download is not uploaded ('' when it is fine). Mirrors the "Image: photo OK?" condition.
function photoProblem(bin) {
  if (!isObj(bin)) return 'the download holds no file';
  const mime = String(bin.mimeType || '').toLowerCase().split(';')[0].trim();
  if (!PHOTO_MIMES.includes(mime)) return 'the download is not a JPEG, PNG or WebP image (' + (cleanText(mime, 60) || 'unknown type') + ')';
  const bytes = Number(bin.bytes);
  if (!Number.isFinite(bytes) || bytes <= 0) return 'the download is empty or its size is unknown';
  if (bytes > MAX_PHOTO_BYTES) return `the photo is too large (${(bytes / 1048576).toFixed(1)} MB, limit ${MAX_PHOTO_BYTES / 1048576} MB)`;
  return '';
}

// --- Report pieces ---------------------------------------------------------------------------------------------
function searchSummary(log) {
  if (!Array.isArray(log) || !log.length) return 'no searches';
  const by = {};
  for (const e of log) {
    if (!isObj(e)) continue;
    const p = cleanText(e.provider, 20) || 'unknown';
    const s = (by[p] = by[p] || { n: 0, ok: 0, results: 0, passed: 0, errors: {} });
    s.n++;
    if (e.status === 'ok') { s.ok++; s.results += Number(e.results) || 0; s.passed += Number(e.passed) || 0; }
    if (e.status === 'error') { const k = cleanText(e.http_error, 60) || 'error'; s.errors[k] = (s.errors[k] || 0) + 1; }
  }
  return Object.entries(by).map(([p, s]) => {
    const errs = Object.entries(s.errors).map(([k, n]) => `${n}x ${k}`);
    return `${p}: ${s.n} ${s.n === 1 ? 'search' : 'searches'}, ${s.ok} ok, ${s.results} results, ${s.passed} passed` + (errs.length ? ', errors: ' + errs.join(', ') : '');
  }).join('; ');
}
function licenceSummary(lc) {
  if (!isObj(lc)) return { status: '', lookup: '', checked: [] };
  return {
    status: cleanText(lc.status, 40), lookup: cleanText(lc.lookup, 120),
    checked: (Array.isArray(lc.checked) ? lc.checked : []).filter(isObj).map(e => ({
      provider: cleanText(e.provider, 20), id: cleanText(e.id, 80), result: cleanText(e.result, 20), reason: cleanText(e.reason, 300),
    })),
  };
}

function rememberUsed(img) {
  if (!REMEMBER_USED) return;
  try {
    const keys = (Array.isArray(img.recent_keys) ? img.recent_keys : []).filter(k => typeof k === 'string' && k);
    if (!keys.length || typeof $getWorkflowStaticData !== 'function') return;
    const g = $getWorkflowStaticData('global');
    if (!isObj(g)) return;
    if (!isObj(g.imageFinder)) g.imageFinder = {};
    const old = Array.isArray(g.imageFinder.recent) ? g.imageFinder.recent : [];
    const kept = old.filter(r => {
      const rk = typeof r === 'string' ? [r] : (isObj(r) ? [r.key].concat(Array.isArray(r.keys) ? r.keys : []) : []);
      return !rk.some(k => keys.includes(k));
    });
    kept.push({ key: keys[0], keys, at: new Date().toISOString() });
    g.imageFinder.recent = kept.slice(-RECENT_LIMIT); // a new array, so n8n sees the change
  } catch (e) { /* best effort */ }
}

// --- Which steps ran for an item ----------------------------------------------------------------------------------
const inputs = $input.all();
// One post in this execution ("Image: pick photo" emits one item per post): every executed node is on its path.
const singlePost = (() => {
  try { const a = $('Image: pick photo').all(); return Array.isArray(a) && a.length === 1 && inputs.length === 1; } catch (e) { return false; }
})();
// The item of a node on input item i's path, or null when that node did not run for it.
function onPath(get, i) {
  let node;
  try { node = get(); if (!node || node.isExecuted === false) return null; } catch (e) { return null; }
  try { const it = node.itemMatching(i); if (it && isObj(it.json)) return it; } catch (e) { /* not on this item's path */ }
  if (!singlePost) return null;
  try {
    const all = node.all();
    return Array.isArray(all) && all.length === 1 && all[0] && isObj(all[0].json) ? all[0] : null;
  } catch (e) { return null; }
}
const confirmNode = () => $('Image: confirm licence');
const planNode = () => $('Image: plan licence check');
const pickNode = () => $('Image: pick photo');
const downloadNode = () => $('Image: download photo');
const uploadNode = () => $('Image: upload to WordPress');
const altNode = () => $('Image: set alt text and caption');

// The post state (source, image, ...) for item i: the confirm node, else earlier nodes, else the item itself.
function postFor(item, i) {
  for (const get of [confirmNode, planNode, pickNode]) {
    const it = onPath(get, i);
    if (it && isObj(it.json.source)) return it.json;
  }
  return item && isObj(item.json) && isObj(item.json.source) ? item.json : null;
}

// --- Main ----------------------------------------------------------------------------------------------------
// The report with every key; status and reason are set by the caller.
function makeReport(post) {
  const img = post && isObj(post.image) ? post.image : null;
  return {
    status: 'failed', reason: '', media_id: null, source_url: '',
    credit_text: img ? cleanText(img.credit_text, 400) : '', license_name: img ? cleanText(img.license_name, 60) : '',
    landing_url: img ? safeUrl(img.landing_url) : '', provider: img ? cleanText(img.provider, 20) : '',
    photo_title: img ? cleanText(img.title, 150) : '', alt_text_set: null,
    licence_check: licenceSummary(post && post.licence_check), search_summary: searchSummary(post && post.search_log),
    extract_error: cleanText(post && post.extract_error, 300),
  };
}

function handBack(item, i) {
  const post = postFor(item, i);
  if (!post) {
    const own = item && isObj(item.json) ? { ...item.json } : {};
    delete own.error;
    const report = makeReport(null);
    report.reason = 'the post was not found in the image finder nodes';
    return { ...own, image_report: report };
  }
  const source = post.source;
  const img = isObj(post.image) ? post.image : null;
  const report = makeReport(post);
  const done = (status, reason) => { report.status = status; report.reason = cleanText(reason, 900); return { ...source, image_report: report }; };

  if (!img) return done('no_image', post.image_error || 'no photo was picked');
  const dl = onPath(downloadNode, i);
  if (!dl) return done('failed', 'the photo was not downloaded');
  const dlRes = httpResult(dl.json);
  if (!dlRes.ok && !(dl.binary && dl.binary.photo)) return done('failed', 'download failed: ' + dlRes.error);
  const bin = (item && item.binary && item.binary.photo) || (dl.binary && dl.binary.photo) || null;
  const problem = photoProblem(bin);
  const up = onPath(uploadNode, i);
  if (!up) return done('failed', problem || 'the photo was not uploaded');
  const upRes = httpResult(up.json);
  if (!upRes.ok) return done('failed', 'upload to WordPress failed: ' + upRes.error);
  const media = isObj(upRes.body) ? upRes.body : {};
  const id = mediaId(media.id);
  if (!id) return done('failed', 'WordPress answered the upload without a media id');
  report.media_id = id;
  report.source_url = safeUrl(media.source_url);

  const alt = onPath(altNode, i);
  let warning = '';
  if (!alt) { report.alt_text_set = false; warning = 'alt text and caption were not set (the update did not run)'; }
  else {
    const altRes = httpResult(alt.json);
    report.alt_text_set = altRes.ok;
    if (!altRes.ok) warning = 'alt text and caption were not set: ' + altRes.error;
  }
  const content = typeof source.content === 'string' ? source.content : '';
  const out = { ...source, content: content + (content ? '\n\n' : '') + creditBlock(img), featured_media: id };
  report.status = 'attached';
  report.reason = warning ? cleanText(warning + '; the featured image is attached', 900) : '';
  rememberUsed(img);
  return { ...out, image_report: report };
}

const result = [];
inputs.forEach((item, i) => {
  let json;
  try { json = handBack(item, i); } catch (e) {
    let base = {};
    try { const post = postFor(item, i); base = post ? { ...post.source } : {}; } catch (e2) { base = {}; }
    let report;
    try { report = makeReport(null); } catch (e3) { report = { status: 'failed', reason: '', media_id: null, source_url: '' }; }
    report.reason = 'hand back failed: ' + String(e && e.message ? e.message : e).slice(0, 200);
    json = { ...base, image_report: report };
  }
  result.push({ json, pairedItem: { item: i } });
});
return result;
