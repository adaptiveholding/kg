// Image finder, step 4a: decide whether the picked photo needs a licence lookup on Wikimedia Commons.
// Openverse indexes Commons, but its copy of a Commons file does not carry the file's Restrictions, NonFree flag or
// licence reviews. Such a row ("Wikimedia-sourced Openverse pick") is confirmed against Commons before it is used:
//   - by a Commons search result of the same page in this run (Image: search Commons), when there is one;
//   - otherwise by ONE imageinfo lookup (Image: look up licence on Commons) for the page ids listed here.
// Candidates are the picked image, then its alternates, in order. Ids are collected up to the first candidate
// that needs no lookup (a Commons pick, a non-Wikimedia Openverse row, or a row whose page this run's search
// already returned), because "Image: confirm licence" uses the first candidate that passes.
// Also: when the watch extraction failed and no watch is known (an Anthropic error, for example), the photo is
// dropped here (see USE_PHOTO_WITHOUT_WATCHES), so nothing is looked up, downloaded or uploaded.
// Output, one item per input item: the pick item plus
//   extract_error: from Image: build queries ('' on success)
//   licence_check: {lookup_pageids: ['148213907', ...], candidates: [{provider, id, pageid, check}], search_pages: {pageid: page}}
// check: 'not needed' | 'search' (page found in this run's search) | 'lookup' | 'no page id'. Nothing here throws.

// --- Config ---------------------------------------------------------------------------------------
// Use a photo picked from the generic query when step 2 could not read the post's watches (extract_error set and
// no watches)? false: the post gets no image, which keeps an LLM outage from putting a random wristwatch on a post.
const USE_PHOTO_WITHOUT_WATCHES = false;

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const curidOf = u => { const m = String(u || '').match(/commons\.wikimedia\.org\/w\/index\.php\?(?:[^#]*&)?curid=(\d+)/i); return m ? m[1] : ''; };
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
const hasFileInfo = p => isObj(p) && Array.isArray(p.imageinfo) && isObj(p.imageinfo[0]);

function nodeItems(read) {
  try { const a = read(); return Array.isArray(a) ? a : null; } catch (e) { return null; }
}

function plan(pick, searchPages) {
  const candidates = [pick.image].concat(Array.isArray(pick.alternates) ? pick.alternates : []).filter(isObj);
  const out = { lookup_pageids: [], candidates: [], search_pages: {} };
  let settled = false;
  for (const c of candidates) {
    const entry = { provider: String(c.provider || ''), id: String(c.id ?? ''), pageid: '', check: 'not needed' };
    out.candidates.push(entry);
    if (!isWikimediaRow(c)) { settled = true; break; }
    entry.pageid = curidOf(c.landing_url);
    if (!entry.pageid) { entry.check = 'no page id'; continue; }
    const page = searchPages.get(entry.pageid);
    if (page) {
      entry.check = 'search';
      out.search_pages[entry.pageid] = page;
      settled = true;
      break;
    }
    entry.check = 'lookup';
    if (!out.lookup_pageids.includes(entry.pageid)) out.lookup_pageids.push(entry.pageid);
  }
  out.settled = settled;
  return out;
}

const items = $input.all();
const posts = nodeItems(() => $('Image: build queries').all()) || [];
// Commons pages returned by this run's searches, by page id (only pages that carry file info).
const searchPages = new Map();
try {
  for (const it of nodeItems(() => $('Image: search Commons').all()) || []) {
    for (const p of pagesOf(it && it.json)) {
      const id = p.pageid === undefined || p.pageid === null ? '' : String(p.pageid);
      if (id && hasFileInfo(p) && !searchPages.has(id)) searchPages.set(id, p);
    }
  }
} catch (e) { /* no search data: every Wikimedia row is looked up */ }

const result = [];
items.forEach((item, i) => {
  const pick = item && isObj(item.json) ? item.json : {};
  let json;
  try {
    const post = posts.length === items.length && posts[i] && isObj(posts[i].json) ? posts[i].json
      : (posts.length === 1 && posts[0] && isObj(posts[0].json) ? posts[0].json : {});
    const extract_error = typeof post.extract_error === 'string' ? post.extract_error : '';
    const watches = Array.isArray(pick.watches) ? pick.watches : [];
    json = { ...pick, extract_error };
    if (pick.image && extract_error && !watches.length && !USE_PHOTO_WITHOUT_WATCHES) {
      json.image = null;
      json.alternates = [];
      json.image_error = 'watch extraction failed (' + extract_error.slice(0, 200) + '), so no photo is used';
    }
    json.licence_check = plan(json, searchPages);
  } catch (e) {
    json = {
      ...pick, image: null, alternates: [],
      image_error: 'licence check failed: ' + String(e && e.message ? e.message : e).slice(0, 200),
      licence_check: { lookup_pageids: [], candidates: [], search_pages: {}, settled: false },
    };
  }
  result.push({ json, pairedItem: { item: i } });
});
return result;
