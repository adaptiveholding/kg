// Image finder, step 2c: turn the LLM's watch list into an ordered list of image search queries.
// Output per item: {source, post_title, watches, image_queries, dropped_watches, dropped_queries, extract_error}.
const MAX_QUERIES = 6;
const GENERIC_QUERY = 'luxury wristwatch';
// The prep node is read with a literal $('Image: prep post text') call (see prepFor) rather than a
// name held in a variable, so n8n updates the reference by itself if that node is ever renamed.
// Marketplaces, dealers, auction houses and platforms are never "brands" (compared without spaces or
// punctuation, so "Chrono 24", "Christies" and "chrono24.com" match too).
const DENYLIST = [
  'Chrono24', 'eBay', 'WatchCharts', "Bob's Watches", 'Phillips', "Christie's", "Sotheby's", 'Bonhams',
  'Antiquorum', 'Heritage Auctions', 'Reddit', 'Instagram', 'Facebook', 'YouTube', 'TikTok', 'Twitter',
  'Discord', 'WhatsApp', 'Telegram', 'Hodinkee', 'WatchUSeek', 'Rolex Forums', 'Jomashop', 'Crown & Caliber',
  'Watchfinder', 'WatchBox', 'The 1916 Company', 'Grailzee', 'StockX', 'The RealReal', '1stDibs', 'Amazon',
  'Craigslist', 'Watches of Switzerland', 'Tourneau', 'Watch Centro', 'WatchCentro', 'WatchRecon',
  'Swiss Watch Expo', 'Bezel', 'Watchexchange', 'r/Watchexchange',
];
// Short names a post (or the LLM, against prompt rule 2) may use. A brand given as a short name becomes
// the full name, and a leading short name is removed from model / model_family ("AP Royal Oak").
const BRAND_ALIASES = {
  'Audemars Piguet': ['AP', 'Audemars'],
  'Jaeger-LeCoultre': ['JLC', 'Jaeger'],
  'Vacheron Constantin': ['VC', 'Vacheron'],
  'Patek Philippe': ['PP', 'Patek'],
  'Grand Seiko': ['GS'],
  'A. Lange & Söhne': ['Lange', 'Lange & Söhne'],
};

const PROMINENCE = ['primary', 'secondary', 'passing'];
const GENERIC = { q: GENERIC_QUERY, level: 'generic', brand: '', model_family: '', model: '', reference: '', prominence: '', watch_index: -1 };
// Words that say nothing about which watch is meant ("the Speedy", "the watch").
const STOPWORDS = new Set(['the', 'a', 'an', 'this', 'that', 'watch', 'watches', 'wristwatch']);

const norm = s => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').trim();
const compact = s => norm(s).replace(/ /g, '');
const DENY = DENYLIST.map(compact);
const isDenied = brand => { const b = compact(brand); return b !== '' && DENY.some(d => b.startsWith(d)); };
const str = v => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

const ALIAS_TO_BRAND = {};
for (const [brand, aliases] of Object.entries(BRAND_ALIASES)) for (const a of aliases) ALIAS_TO_BRAND[norm(a)] = brand;
const aliasesOf = brand => BRAND_ALIASES[ALIAS_TO_BRAND[norm(brand)] ?? brand] ?? [];

// Word-bounded containment on normalized text, so 'AP' does not match inside 'cheap'.
const hasWord = (hayNorm, needle) => { const n = norm(needle); return n !== '' && (' ' + hayNorm + ' ').includes(' ' + n + ' '); };

// "Rolex Submariner Date" with brand "Rolex" -> "Submariner Date" (token-wise, diacritics-insensitive).
function stripBrand(text, brand) {
  const want = norm(brand).split(' ').filter(Boolean);
  if (!want.length) return text;
  const tokens = [...text.matchAll(/[\p{L}\p{M}\p{N}]+/gu)];
  if (tokens.length < want.length) return text;
  for (let k = 0; k < want.length; k++) if (norm(tokens[k][0]) !== want[k]) return text;
  const last = tokens[want.length - 1];
  return text.slice(last.index + last[0].length).replace(/^[^\p{L}\p{N}]+/u, '').trim();
}

// Also drop a leading short name ("AP Royal Oak"), unless only a number would be left ("Lange 1").
function stripBrandNames(text, brand) {
  const t = stripBrand(text, brand);
  if (t !== text) return t;
  for (const a of aliasesOf(brand)) {
    const s = stripBrand(text, a);
    if (s !== text && !/^\d/.test(s)) return s;
  }
  return text;
}

// --- Parsing the LLM reply ----------------------------------------------------------------------

const tryJson = s => {
  try { return JSON.parse(s); } catch (e) { /* try without trailing commas */ }
  try { return JSON.parse(s.replace(/,\s*([}\]])/g, '$1')); } catch (e) { return undefined; }
};
const isEntry = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const watchesIn = v => {
  if (isEntry(v) && Array.isArray(v.watches)) return v.watches;
  if (Array.isArray(v) && v.length && v.every(isEntry)) return v; // a bare array of watch objects
  return undefined;
};

// End index of the balanced {...} or [...] starting at i (string-aware), or -1.
function closeOf(text, i) {
  let depth = 0;
  let inStr = false;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (inStr) {
      if (c === '\\') j++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { if (--depth === 0) return j; }
  }
  return -1;
}

// Lenient fallbacks after the house-style parse: the ```json fence alone, then every balanced
// {...} in order (a bare [...] only before the first '{'), each also retried without trailing commas.
function findWatches(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) { const w = watchesIn(tryJson(fence[1].trim())); if (w) return w; }
  const firstBrace = text.indexOf('{');
  let tries = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c !== '{' && !(c === '[' && (firstBrace < 0 || i < firstBrace))) continue;
    if (++tries > 200) break;
    const j = closeOf(text, i);
    if (j < 0) continue;
    const w = watchesIn(tryJson(text.slice(i, j + 1)));
    if (w) return w;
  }
  return undefined;
}

// Last resort for a damaged or cut-off reply: keep every complete {...} entry that parses on its own.
function salvageEntries(text) {
  const k = text.indexOf('"watches"');
  const part = k >= 0 ? text.slice(k) : text;
  return [...part.matchAll(/\{[^{}]*\}/g)].map(m => tryJson(m[0])).filter(v => isEntry(v) && typeof v.brand === 'string');
}

function parseExtract(json) {
  if (json === null || typeof json !== 'object') return { error: 'LLM item is empty' };
  if (Array.isArray(json.watches)) return { watches: json.watches };
  const raw = json.text ?? json.output;
  if (raw === undefined || raw === null || raw === '') {
    if (json.error !== undefined) {
      const e = json.error;
      const msg = typeof e === 'string' ? e : (e && typeof e.message === 'string' ? e.message : JSON.stringify(e));
      return { error: 'LLM error: ' + String(msg).slice(0, 300) };
    }
    return { error: 'LLM returned no text (item keys: ' + Object.keys(json).slice(0, 8).join(', ') + ')' };
  }
  if (typeof raw === 'object') {
    const w = watchesIn(raw);
    return w ? { watches: w } : { error: 'LLM JSON has no "watches" array' };
  }
  const text = String(raw);
  // House style first: strip fences, slice the first '{' to the last '}'.
  let body = text.replace(/^```(?:json)?/m, '').replace(/```\s*$/m, '').trim();
  const a = body.indexOf('{'), b = body.lastIndexOf('}');
  if (a >= 0 && b > a) body = body.slice(a, b + 1);
  let parsed;
  try { parsed = JSON.parse(body); } catch (e) { parsed = undefined; }
  if (parsed !== undefined && Array.isArray(parsed?.watches)) return { watches: parsed.watches };
  const found = findWatches(text);
  if (found) return { watches: found };
  const saved = salvageEntries(text);
  if (saved.length) {
    return { watches: saved, error: `LLM JSON was invalid or cut off; kept ${saved.length} complete watch entr${saved.length === 1 ? 'y' : 'ies'}` };
  }
  return { error: parsed !== undefined ? 'LLM JSON has no "watches" array' : 'LLM did not return valid JSON: ' + text.slice(0, 200) };
}

// --- Cleaning and checking each watch -----------------------------------------------------------

function cleanWatch(w) {
  const o = w !== null && typeof w === 'object' ? w : {};
  let brand = str(o.brand);
  brand = ALIAS_TO_BRAND[norm(brand)] ?? brand;
  const model_family = stripBrandNames(str(o.model_family), brand);
  let model = stripBrandNames(str(o.model), brand);
  if (!model) model = model_family;
  const p = str(o.prominence).toLowerCase();
  return {
    brand, model_family, model, reference: str(o.reference), mentioned_as: str(o.mentioned_as),
    prominence: PROMINENCE.includes(p) ? p : 'passing',
  };
}

// mentioned_as without leading/trailing filler words ("the Speedy" -> "speedy"); '' if nothing is left.
function mentionNeedle(mentioned) {
  const t = norm(mentioned).split(' ').filter(Boolean);
  while (t.length && STOPWORDS.has(t[0])) t.shift();
  while (t.length && STOPWORDS.has(t[t.length - 1])) t.pop();
  return t.join(' ');
}

// Two-tier check against the post text. The brand needs the brand, a short name or mentioned_as.
// A model needs its own evidence: model, model_family, a real reference (3+ chars with a digit), or a
// mentioned_as that has more than brand names and filler words in it.
// Returns 'keep', 'brand-only' or 'drop'.
function guard(w, hay) {
  const mention = mentionNeedle(w.mentioned_as);
  const mentionSeen = mention !== '' && hasWord(hay, mention);
  const brandWords = new Set([w.brand, ...aliasesOf(w.brand)].flatMap(x => norm(x).split(' ')));
  const mentionNamesModel = mention.split(' ').some(t => t && !brandWords.has(t) && !STOPWORDS.has(t));
  const ref = norm(w.reference);
  const refOk = /\d/.test(ref) && ref.replace(/ /g, '').length >= 3;
  const brandSeen = mentionSeen || [w.brand, ...aliasesOf(w.brand)].some(x => hasWord(hay, x));
  const modelSeen = hasWord(hay, w.model) || hasWord(hay, w.model_family) || (refOk && hasWord(hay, w.reference)) ||
    (mentionSeen && mentionNamesModel);
  if (!brandSeen && !modelSeen) return 'drop';
  if (!modelSeen && (w.model_family || w.model || w.reference)) return 'brand-only';
  return 'keep';
}

// The prep item for LLM item i: follow the paired-item chain, else take the same index.
function prepFor(i) {
  try { const m = $('Image: prep post text').itemMatching(i); if (m && m.json) return m.json; } catch (e) { /* fall back */ }
  try { const a = $('Image: prep post text').all()[i]; if (a && a.json) return a.json; } catch (e) { /* no prep data */ }
  return null;
}

// --- Queries ------------------------------------------------------------------------------------

// Characters that are search operators on Openverse (simple_query_string) or carry no search value.
const cleanQ = q => q.replace(/["()|+*~&]/g, ' ').replace(/\s+/g, ' ').trim();

function buildQueries(watches) {
  const out = [];
  const seen = new Set();
  const add = (q, level, w) => {
    const text = cleanQ(q);
    const key = norm(text);
    if (!key || seen.has(key)) return;
    seen.add(key);
    const isBrand = level === 'brand';
    out.push({
      q: text, level, brand: w.brand,
      model_family: isBrand ? '' : w.model_family, model: isBrand ? '' : w.model, reference: isBrand ? '' : w.reference,
      prominence: w.prominence, watch_index: watches.indexOf(w),
    });
  };
  const models = w => {
    // "Pepsi" with family "GMT-Master II" searches as "GMT-Master II Pepsi".
    const withFamily = w.model_family && !hasWord(norm(w.model), w.model_family);
    if (w.model) add(withFamily ? `${w.brand} ${w.model_family} ${w.model}` : `${w.brand} ${w.model}`, 'model', w);
    if (w.model_family && norm(w.model_family) !== norm(w.model)) add(`${w.brand} ${w.model_family}`, 'family', w);
  };
  const brand = w => add(`${w.brand} watch`, 'brand', w);
  const by = p => watches.filter(w => w.prominence === p);
  by('primary').forEach(models);   // A: primary models and families
  by('secondary').forEach(models); // B: secondary models and families
  by('primary').forEach(brand);    // C: brands of primary watches
  by('passing').forEach(models);   // D: passing models and families
  watches.forEach(brand);          // E: all remaining brands
  return out;
}

function build(item, prep) {
  const post_title = prep && typeof prep.post_title === 'string' ? prep.post_title : '';
  const post_text = prep && typeof prep.post_text === 'string' ? prep.post_text : '';
  const { watches: rawWatches = [], error = '' } = parseExtract(item && item.json);

  // The guard is skipped when we have no post text to check against.
  const hay = post_text.trim() ? norm(post_title + ' ' + post_text) : null;
  const kept = [];
  const dropped_watches = [];
  for (const w of rawWatches.map(cleanWatch)) {
    let reason = '';
    if (!w.brand) reason = 'empty brand';
    else if (isDenied(w.brand)) reason = 'not a watch manufacturer (denylist)';
    else if (hay !== null) {
      const verdict = guard(w, hay);
      if (verdict === 'drop') reason = 'not found in post text';
      else if (verdict === 'brand-only') {
        // The brand is in the post but this model is not: search for the brand only.
        dropped_watches.push({ ...w, reason: 'model not found in post text (kept brand only)' });
        kept.push({ ...w, model_family: '', model: '', reference: '' });
        continue;
      }
    }
    if (reason) dropped_watches.push({ ...w, reason });
    else kept.push(w);
  }

  // Most prominent first (stable), then keep the first entry per brand + model.
  kept.sort((a, b) => PROMINENCE.indexOf(a.prominence) - PROMINENCE.indexOf(b.prominence));
  const seen = new Set();
  const watches = kept.filter(w => {
    const key = norm(w.brand + ' ' + w.model);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const all = buildQueries(watches);
  // Keep a slot for "<top brand> watch" so a miss on every model query still finds the right brand.
  const top = all.findIndex(q => q.level === 'brand' && q.watch_index === 0);
  if (MAX_QUERIES >= 2 && top >= MAX_QUERIES) all.splice(MAX_QUERIES - 1, 0, ...all.splice(top, 1));
  return {
    post_title, watches, dropped_watches, extract_error: error,
    image_queries: [...all.slice(0, MAX_QUERIES), { ...GENERIC }],
    dropped_queries: Math.max(0, all.length - MAX_QUERIES),
  };
}

return $input.all().map((item, i) => {
  const prep = prepFor(i);
  const source = prep && prep.source !== undefined ? prep.source : null;
  let out;
  try {
    out = build(item, prep);
  } catch (e) {
    out = {
      post_title: prep && typeof prep.post_title === 'string' ? prep.post_title : '',
      watches: [], dropped_watches: [], image_queries: [{ ...GENERIC }], dropped_queries: 0,
      extract_error: 'build queries failed: ' + (e && e.message ? e.message : String(e)),
    };
  }
  const { post_title, watches, image_queries, dropped_watches, dropped_queries, extract_error } = out;
  return {
    json: { source, post_title, watches, image_queries, dropped_watches, dropped_queries, extract_error },
    pairedItem: { item: i },
  };
});
