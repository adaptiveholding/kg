// Image finder, step 4b: confirm the licence of a Wikimedia-sourced Openverse pick on Commons, then fix the photo.
// Input: one item per post, either the "Image: plan licence check" item itself (no lookup was needed) or the
// answer of "Image: look up licence on Commons" (the plan item is then read through pairedItem).
// The picked image and its alternates are tried in order. A Commons pick or a non-Wikimedia Openverse row is used
// as it is (step 3 checked it). A Wikimedia-sourced Openverse row is used only when its Commons page (from this
// run's search, else from the lookup) passes the step 3 rules again: licence CC0 / public domain / CC BY /
// CC BY-SA, no NC/ND, not NonFree, licence fields that agree, no public domain logo or shape, no "personality"
// restriction, and the page must show the same file. Its licence and creator are then taken from Commons (the
// licensor's requested credit wins, as in step 3) and credit_text is rebuilt. Rows that cannot be confirmed are
// skipped; when none is left the post gets no image.
// Output, one item per input item: {source, post_title, watches, image_queries, image, image_error, alternates,
// search_log, extract_error, licence_check: {status, lookup, checked}, media_update}. media_update is the JSON body
// of "Image: set alt text and caption": {alt_text, caption, title, description}. Nothing here throws.

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const PHOTO_EXTENSIONS = ['jpg', 'png', 'webp'];

// --- Copied verbatim from pick-photo.js (the step 3 rules; a unit test keeps the copies identical) ------------
const REJECT_RESTRICTIONS = ['personality'];
const REJECT_COMMONS_LICENSE = /^pd-(textlogo|logo|shape|trivial|ineligible)/i;
const str = v => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : (typeof v === 'number' ? String(v) : ''));
const norm = s => String(s ?? '').replace(/ß/g, 'ss').replace(/[øØ]/g, 'o').replace(/[æÆ]/g, 'ae')
  .replace(/[œŒ]/g, 'oe').replace(/[łŁ]/g, 'l').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').trim();
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    const v = ENTITIES[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}
function htmlText(s) {
  if (s === null || s === undefined || typeof s === 'object') return '';
  let t = String(s).slice(0, 6000);
  t = t.replace(/<(div|span)\b[^>]*display\s*:\s*none[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  t = t.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' ');
  return decodeEntities(t).replace(/\s+/g, ' ').trim();
}
function plain(s, max) {
  let t = String(s ?? '').replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ').replace(/[\u2012-\u2015\u2212]/g, '-')
    .replace(/["\u201c\u201d\u201e]/g, "'").replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (max && t.length > max) t = t.slice(0, max - 3).replace(/\s+\S*$/, '') + '...';
  return t;
}
const isHttp = u => typeof u === 'string' && /^https?:\/\/[^\s/]+/i.test(u.trim());
const absUrl = u => {
  const s = decodeEntities(String(u || '').trim());
  if (s.startsWith('//')) return 'https:' + s;
  if (s.startsWith('/wiki/') || s.startsWith('/w/')) return 'https://commons.wikimedia.org' + s;
  return s;
};
function safeDecode(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }
function normUrl(u) {
  const m = String(u || '').trim().match(/^(?:[a-z]+:)?\/\/(?:www\.)?([^/?#]+)([^?#]*)/i);
  if (!m) return '';
  let path = safeDecode(m[2]).replace(/\/+$/, '');
  const host = m[1].toLowerCase();
  if (host === 'upload.wikimedia.org') {
    const t = path.match(/^(\/[^/]+\/[^/]+)\/thumb(\/[0-9a-f]\/[0-9a-f]{2}\/[^/]+)\/[^/]+$/i);
    if (t) path = t[1] + t[2];
  }
  return (host + path).toLowerCase();
}
function parseLicenseName(raw) {
  const s = String(raw ?? '').toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (/^public domain mark\b/.test(s) || /^pdm\b/.test(s)) return { code: 'pdm', version: '1.0', jur: '' };
  if (s === 'pd' || /^pd[- ]/.test(s) || /^public domain\b/.test(s)) return { code: 'pd', version: '', jur: '' };
  const t = s.split(/[\s,;/-]+/).filter(Boolean);
  if (t.some(x => ['nc', 'nd', 'noncommercial', 'noderivs', 'noderivatives'].includes(x))) return { code: 'ncnd', version: '', jur: '' };
  if (t[0] === 'cc0' || (t[0] === 'cc' && (t[1] === 'zero' || t[1] === '0'))) return { code: 'cc0', version: '1.0', jur: '' };
  if (t[0] === 'cc' && t[1] === 'pd') return { code: 'pd', version: '', jur: '' };
  if (t[0] !== 'cc') return { code: 'other', version: '', jur: '' };
  let i = 1;
  const attrs = [];
  while (i < t.length && (t[i] === 'by' || t[i] === 'sa')) attrs.push(t[i++]);
  const code = attrs.join('-');
  if (code !== 'by' && code !== 'by-sa') return { code: 'other', version: '', jur: '' };
  if (i < t.length && !/^\d+(\.\d+)*$/.test(t[i]) && !/^([a-z]{2}|igo|scotland)$/.test(t[i])) return { code: 'other', version: '', jur: '' };
  let version = '';
  while (i < t.length && /^\d+(\.\d+)*$/.test(t[i])) { if (!version) version = t[i]; i++; } // "3.0-2.5-2.0-1.0" -> 3.0
  const jur = i < t.length && /^([a-z]{2}|igo|scotland)$/.test(t[i]) ? t[i] : '';
  return { code, version, jur };
}
function parseLicenseUrl(raw) {
  const u = String(raw ?? '').trim().toLowerCase();
  if (!u) return null;
  const m = u.match(/creativecommons\.org\/(licenses|publicdomain)\/([a-z0-9+-]+)(?:\/(\d+(?:\.\d+)*))?(?:\/([a-z]{2,8}))?(?=[/?#]|$)/);
  if (!m) return { code: 'noncc', version: '', jur: '' };
  const jur = m[4] && !['deed', 'legalcode'].includes(m[4]) ? m[4] : '';
  if (m[1] === 'publicdomain') return { code: m[2] === 'zero' ? 'cc0' : (m[2] === 'mark' ? 'pdm' : 'pd'), version: m[3] || '', jur: '' };
  const parts = m[2].split('-');
  if (parts.some(x => x === 'nc' || x === 'nd')) return { code: 'ncnd', version: m[3] || '', jur };
  if (m[2] === 'cc0') return { code: 'cc0', version: m[3] || '1.0', jur: '' };
  if (m[2] === 'by' || m[2] === 'by-sa') return { code: m[2], version: m[3] || '', jur };
  return { code: 'other', version: m[3] || '', jur };
}
const family = l => (l.code === 'pd' || l.code === 'pdm' ? 'pd' : l.code);
const ALLOWED_CODES = ['by', 'by-sa', 'cc0', 'pd', 'pdm'];
const jurLabel = j => (j === 'scotland' ? 'Scotland' : j.toUpperCase());
function licenseFields(l, givenUrl) {
  const url = isHttp(givenUrl) ? givenUrl.trim() : '';
  if (l.code === 'cc0') return { license: 'cc0', license_version: '1.0', license_name: 'CC0 1.0', license_url: url || 'https://creativecommons.org/publicdomain/zero/1.0/' };
  if (l.code === 'pdm') return { license: 'pdm', license_version: '1.0', license_name: 'Public Domain Mark 1.0', license_url: url || 'https://creativecommons.org/publicdomain/mark/1.0/' };
  if (l.code === 'pd') return { license: 'pdm', license_version: '', license_name: 'Public domain', license_url: url };
  const label = l.code === 'by' ? 'CC BY' : 'CC BY-SA';
  const name = [label, l.version, l.jur ? jurLabel(l.jur) : ''].filter(Boolean).join(' ');
  const built = l.version ? `https://creativecommons.org/licenses/${l.code}/${l.version}/${l.jur ? l.jur + '/' : ''}` : '';
  return { license: l.code, license_version: l.version, license_name: name, license_url: url || built };
}
function decideLicense(names, url, usageTerms, nonFree) {
  const parsed = names.map(parseLicenseName).filter(Boolean);
  const fromUrl = parseLicenseUrl(url);
  const all = fromUrl ? parsed.concat([fromUrl]) : parsed;
  if (!parsed.length) return { reject: 'licence', detail: 'licence unknown' };
  if (all.some(l => l.code === 'ncnd') || /non-?commercial|no-?deriv/i.test(String(usageTerms || ''))) return { reject: 'licence', detail: 'licence NC/ND' };
  if (/^(true|1|yes)$/i.test(String(nonFree ?? '').trim())) return { reject: 'licence', detail: 'non-free file' };
  const lic = parsed[0];
  if (!ALLOWED_CODES.includes(lic.code)) return { reject: 'licence', detail: 'licence not allowed' };
  if (parsed.some(l => family(l) !== family(lic))) return { reject: 'licence', detail: 'licence fields disagree' };
  if (fromUrl) {
    if (fromUrl.code === 'noncc' ? lic.code !== 'pd' : family(fromUrl) !== family(lic)) return { reject: 'licence', detail: 'licence URL disagrees' };
  }
  const merged = { code: lic.code, version: lic.version || (fromUrl && fromUrl.version) || '', jur: lic.jur || (fromUrl && fromUrl.jur) || '' };
  if (merged.code === 'by' || merged.code === 'by-sa') {
    const other = parsed.find(l => l.version);
    if (!merged.version && other) merged.version = other.version;
    if (!merged.jur) { const j = parsed.find(l => l.jur); if (j) merged.jur = j.jur; }
  }
  return { lic: merged };
}
const UNKNOWN_CREATOR = new RegExp('^(unknown( author| photographer| artist)?|author unknown|anonymous|anonym[eo]?|anonimo|' +
  'anon\\.?|unbekannte?r?( (autor|fotograf|urheber))?|(auteur |photographe )?inconnue?|(autor |fotografo )?desconocido|' +
  '(autore |fotografo )?sconosciuto|onbekend|okand|nieznany|not provided|n\\/?a|none|-+|\\?+)$', 'i');
function cleanCreator(s) {
  let t = htmlText(s);
  const m = t.match(/^The original uploader was (.+?) at (.+?)\.?$/i);
  if (m) t = `${m[1]} at ${m[2]}`;
  if (!t || UNKNOWN_CREATOR.test(norm(t)) || UNKNOWN_CREATOR.test(t) || /lacking author information/i.test(t)) return '';
  return plain(t, 120);
}
function requestedCredit(html) {
  let t = htmlText(html).replace(/^(?:©|\(c\)|copyright)\s*/i, '');
  t = t.replace(/^(?:photo(?:graph)?|foto(?:grafie)?|image|picture|bild|credit)s?\s*(?::\s*|by\s+|von\s+|de\s+)(?:by\s+)?/i, '');
  const parts = t.split(/\s+[/|]\s+/).map(x => x.trim()).filter(x => x &&
    !/^(via |from )?wikimedia commons$/i.test(x) && !/^(own work|eigenes werk)$/i.test(x) &&
    (parseLicenseName(x) || { code: 'other' }).code === 'other');
  return cleanCreator(parts.join(' / '));
}
function artistUrl(html) {
  const m = String(html || '').match(/<a\b[^>]*\bhref="([^"]+)"/i);
  if (!m) return '';
  let u = absUrl(m[1]);
  const red = u.match(/^https:\/\/commons\.wikimedia\.org\/w\/index\.php\?title=(User:[^&]+)&action=edit&redlink=1/);
  if (red) u = 'https://commons.wikimedia.org/wiki/' + red[1];
  return isHttp(u) ? u : '';
}
const curidOf = u => { const m = String(u || '').match(/commons\.wikimedia\.org\/w\/index\.php\?(?:[^#]*&)?curid=(\d+)/i); return m ? m[1] : ''; };
function creditFor(c) {
  const title = plain(c.title, 120);
  const creator = plain(c.creator, 80) || 'Unknown author';
  const head = title ? `Photo: "${title}"` : 'Photo';
  if (c.license === 'cc0' || c.license === 'pdm') {
    const by = creator !== 'Unknown author' ? ' by ' + creator : '';
    return `${head}${by} (${c.license_name}), via ${c.source_name}`;
  }
  return `${head} by ${creator}, ${c.license_name}, via ${c.source_name}`;
}
const toCode = v => { const n = typeof v === 'string' ? parseInt(v, 10) : v; return Number.isInteger(n) && n >= 100 && n <= 599 ? n : 0; };
function n8nErrorLabel(err) {
  if (typeof err === 'string') return /json/i.test(err) ? 'invalid JSON' : plain(err, 60) || 'request failed';
  if (!err || typeof err !== 'object') return 'request failed';
  if (err.name === 'SsrfBlockedIpError') return 'blocked by SSRF protection';
  const status = toCode(err.status) || toCode(err.httpCode) || toCode(err.statusCode);
  if (status) return 'HTTP ' + status;
  const msg = String(err.message || err.description || '');
  const m = msg.match(/^(\d{3}) - /) || msg.match(/status code (\d{3})/i);
  if (m) return 'HTTP ' + m[1];
  const code = typeof err.code === 'string' ? err.code : '';
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || /timeout|timed out/i.test(msg)) return 'timeout';
  if (code) return code;
  return msg ? plain(msg, 60) : 'request failed';
}

// Download host allowlist (SSRF guard): file_url comes from Openverse/Commons data, so only https URLs on the known
// image CDNs are fetched. Anything else (plain http, internal addresses, other hosts) is skipped like a bad licence.
const DOWNLOAD_HOSTS = ['upload.wikimedia.org'];
const DOWNLOAD_HOST_SUFFIXES = ['.staticflickr.com'];
function downloadAllowed(u) {
  const m = String(u || '').trim().match(/^https:\/\/([a-z0-9.-]+)(?::443)?(?:[/?#]|$)/i);
  if (!m) return false;
  const h = m[1].toLowerCase();
  return DOWNLOAD_HOSTS.includes(h) || DOWNLOAD_HOST_SUFFIXES.some(sfx => h.endsWith(sfx) && h.length > sfx.length);
}

// --- Same as in plan-licence-check.js (a unit test keeps the copies identical) ----------------------------------
const hostOf = u => ((String(u || '').match(/^https?:\/\/([^/?#]+)/i) || [])[1] || '').toLowerCase();

// An Openverse row whose file lives on Wikimedia Commons.
function isWikimediaRow(c) {
  if (!isObj(c) || c.provider !== 'openverse') return false;
  return c.source_name === 'Wikimedia Commons' || hostOf(c.file_url) === 'upload.wikimedia.org' || curidOf(c.landing_url) !== '';
}

// Pages of a Commons API answer (formatversion 2 list or 1 object; plain or neverError/fullResponse item).
function pagesOf(json) {
  if (!isObj(json)) return [];
  let body = json;
  if (Number.isInteger(json.statusCode) && ('body' in json || 'data' in json)) {
    body = 'body' in json ? json.body : json.data;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { return []; } }
  }
  if (!isObj(body) || !isObj(body.query) || !body.query.pages || typeof body.query.pages !== 'object') return [];
  const pages = Array.isArray(body.query.pages) ? body.query.pages : Object.values(body.query.pages);
  return pages.filter(p => isObj(p));
}

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
  const u = v.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
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

// --- Commons lookup -----------------------------------------------------------------------------------------
// The lookup item -> {ok, error, pages: Map(pageid -> page)}. n8n failure items, non-2xx full responses and
// MediaWiki errors (HTTP 200 with {error: {code, info}}) are errors.
function readLookup(json) {
  const fail = error => ({ ok: false, error, pages: new Map() });
  if (!isObj(json)) return fail('empty response');
  let body = json;
  if (toCode(json.statusCode) && ('body' in json || 'data' in json || 'headers' in json)) {
    const code = toCode(json.statusCode);
    if (code < 200 || code >= 300) return fail('HTTP ' + code);
    body = 'body' in json ? json.body : json.data;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { return fail('non-JSON response'); } }
  }
  if (!isObj(body)) return fail('empty response');
  if (body.error !== undefined && body.error !== null) {
    const e = body.error;
    if (isObj(e) && typeof e.code === 'string' && e.info !== undefined && !e.name) return fail('API ' + e.code);
    return fail(n8nErrorLabel(e));
  }
  if (!isObj(body.query) && !('batchcomplete' in body)) return fail('unexpected response');
  const pages = new Map();
  for (const p of pagesOf(body)) {
    const id = p.pageid === undefined || p.pageid === null ? '' : String(p.pageid);
    if (id && !pages.has(id)) pages.set(id, p);
  }
  return { ok: true, error: '', pages };
}

// The step 3 Commons rules for one page against candidate c -> {image} (c with Commons licence and creator) or {reason}.
function verdict(page, c) {
  if (!isObj(page) || (page.missing !== undefined && page.missing !== false) || page.invalid) return { reason: 'file not found on Commons' };
  const ii = Array.isArray(page.imageinfo) ? page.imageinfo[0] : null;
  if (!isObj(ii)) return { reason: 'no file info on Commons' };
  const em = isObj(ii.extmetadata) ? ii.extmetadata : {};
  const meta = k => {
    const v = em[k];
    if (isObj(v)) return v.value === null || v.value === undefined ? '' : String(v.value);
    return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
  };
  const d = decideLicense([meta('LicenseShortName'), meta('License')], meta('LicenseUrl'), meta('UsageTerms'), meta('NonFree'));
  if (d.reject) return { reason: 'Commons: ' + d.detail };
  if (REJECT_COMMONS_LICENSE.test(meta('License').trim())) return { reason: 'Commons: public domain logo or simple shape' };
  const restrictions = meta('Restrictions').toLowerCase().split('|').map(s => s.trim()).filter(Boolean);
  const bad = restrictions.find(x => REJECT_RESTRICTIONS.includes(x));
  if (bad) return { reason: 'Commons: restriction ' + bad };
  const onCommons = normUrl(absUrl(str(ii.url)));
  const here = normUrl(c.file_url);
  if (onCommons && here && onCommons !== here) return { reason: 'the Commons page shows another file' };
  const artist = meta('Artist');
  const creator = requestedCredit(meta('Attribution')) || cleanCreator(artist);
  const image = {
    ...c,
    creator: creator || c.creator || 'Unknown author',
    creator_url: artistUrl(artist) || (creator && creator !== c.creator ? '' : c.creator_url),
    ...licenseFields(d.lic, meta('LicenseUrl')),
  };
  image.attribution_required = d.lic.code === 'by' || d.lic.code === 'by-sa' || /^true$/i.test(meta('AttributionRequired').trim());
  image.credit_text = creditFor(image);
  return { image };
}

// --- Output fields -------------------------------------------------------------------------------------------
// ASCII-only name with a photo extension: WordPress reads only a plain filename="..." and decides the file type by
// its extension (plus the bytes); Node rejects non-Latin-1 header values.
function safeFilename(img) {
  const raw = String(img.extension || '').toLowerCase();
  const ext = PHOTO_EXTENSIONS.includes(raw === 'jpeg' ? 'jpg' : raw) ? (raw === 'jpeg' ? 'jpg' : raw) : 'jpg';
  const base = String(img.download_filename || '').replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 90).replace(/[-_]+$/, '');
  return (base || 'watch-photo') + '.' + ext;
}
// Body of "Image: set alt text and caption". alt_text and title are plain text (WordPress runs alt_text through
// sanitize_text_field, which drops tags and %xx octets, and strips tags from titles for Author accounts); caption
// and description keep their links (kses allows <a href> for every role).
function mediaUpdate(img) {
  const credit = creditHtml(img);
  const landing = safeUrl(img.landing_url);
  const flat = (v, max) => cleanText(v, max).replace(/[<>]/g, '').replace(/%(?=[0-9a-f]{2})/gi, '% ');
  return {
    alt_text: flat(img.alt_text, 200),
    caption: credit,
    title: flat(img.title, 150) || flat(img.alt_text, 150),
    description: '<p>' + credit + '</p>' + (landing ? '\n<p>Source: <a href="' + esc(landing) + '">' + esc(landing) + '</a></p>' : ''),
  };
}

function confirm(plan, lookup) {
  const lc = isObj(plan.licence_check) ? plan.licence_check : {};
  const searchPages = isObj(lc.search_pages) ? lc.search_pages : {};
  const base = { ...plan };
  delete base.licence_check;
  delete base.media_update;
  const lookupStatus = lookup ? (lookup.ok ? 'ok' : lookup.error) : 'not needed';
  const checked = [];
  if (!isObj(plan.image)) {
    return { ...base, image: null, alternates: [], licence_check: { status: 'no photo', lookup: lookupStatus, checked }, media_update: null };
  }
  const cands = [plan.image].concat(Array.isArray(plan.alternates) ? plan.alternates : []).filter(isObj);
  let chosen = null;
  let at = -1;
  for (let k = 0; k < cands.length && !chosen; k++) {
    const c = cands[k];
    const entry = { provider: String(c.provider || ''), id: String(c.id ?? ''), pageid: '', result: 'skipped', reason: '' };
    checked.push(entry);
    if (!downloadAllowed(c.file_url)) { entry.result = 'rejected'; entry.reason = 'file URL not on the download allowlist'; continue; }
    if (!isWikimediaRow(c)) {
      entry.result = 'used';
      entry.reason = c.provider === 'commons' ? 'licence read from Commons by the search' : 'not a Wikimedia Commons file';
      chosen = c;
      at = k;
      break;
    }
    entry.pageid = curidOf(c.landing_url);
    if (!entry.pageid) { entry.reason = 'no Commons page id in the landing URL'; continue; }
    let page = isObj(searchPages[entry.pageid]) ? searchPages[entry.pageid] : null;
    let via = 'search';
    if (!page && lookup && lookup.ok && lookup.pages.has(entry.pageid)) { page = lookup.pages.get(entry.pageid); via = 'lookup'; }
    if (!page) {
      entry.reason = !lookup ? 'not looked up on Commons' : (lookup.ok ? 'not found on Commons' : 'Commons lookup failed: ' + lookup.error);
      continue;
    }
    const v = verdict(page, c);
    if (!v.image) { entry.result = 'rejected'; entry.reason = v.reason + ' (Commons ' + via + ')'; continue; }
    entry.result = 'used';
    entry.reason = 'licence confirmed by the Commons ' + via;
    chosen = v.image;
    at = k;
  }
  if (!chosen) {
    const why = checked.map(e => `${e.provider} ${e.id}: ${e.reason}`).join('; ');
    return {
      ...base, image: null, image_error: plain('no picked photo passed the Commons licence check: ' + why, 900), alternates: [],
      licence_check: { status: 'rejected', lookup: lookupStatus, checked }, media_update: null,
    };
  }
  const image = { ...chosen, download_filename: safeFilename(chosen) };
  const confirmed = checked[checked.length - 1].reason.startsWith('licence confirmed');
  const status = at > 0 ? 'alternate used' : (confirmed ? 'confirmed' : 'not needed');
  return {
    ...base, image, image_error: '', alternates: cands.slice(at + 1),
    licence_check: { status, lookup: lookupStatus, checked }, media_update: mediaUpdate(image),
  };
}

// --- Main ------------------------------------------------------------------------------------------------------
const items = $input.all();
const isPlanItem = j => isObj(j) && isObj(j.licence_check) && 'image' in j && 'source' in j;
// The plan item behind lookup answer i (pairedItem); with a single item, the only plan item.
function planFor(i) {
  try {
    const it = $('Image: plan licence check').itemMatching(i);
    if (it && isPlanItem(it.json)) return it.json;
  } catch (e) { /* fall through */ }
  if (items.length === 1) {
    try {
      const all = $('Image: plan licence check').all();
      if (all.length === 1 && all[0] && isPlanItem(all[0].json)) return all[0].json;
    } catch (e) { /* not executed */ }
  }
  return null;
}

const out = [];
items.forEach((item, i) => {
  const json = item && item.json;
  let result;
  try {
    if (isPlanItem(json)) result = confirm(json, null);
    else {
      const plan = planFor(i);
      result = plan ? confirm(plan, readLookup(json))
        : { image: null, image_error: 'licence check failed: the picked photo was not found', alternates: [], licence_check: { status: 'failed', lookup: '', checked: [] }, media_update: null };
    }
  } catch (e) {
    const base = isPlanItem(json) ? { ...json } : {};
    delete base.licence_check;
    result = {
      ...base, image: null, image_error: 'licence check failed: ' + plain(e && e.message ? e.message : String(e), 200), alternates: [],
      licence_check: { status: 'failed', lookup: '', checked: [] }, media_update: null,
    };
  }
  out.push({ json: result, pairedItem: { item: i } });
});
return out;
