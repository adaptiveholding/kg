// Image finder, step 3d: choose one openly licensed, relevant photo per post from the Openverse and
// Wikimedia Commons results of every query.
// Reads $('Image: build queries') (posts), $('Image: split queries') (one item per query) and the two
// search nodes (one response item per query, same order; pairedItem is the fallback when the order breaks).
// Output, one item per post: {source, post_title, watches, image_queries, image, image_error, alternates, search_log}.
// Choice: the lowest query rank that has a usable photo, then the highest score. Nothing here throws.

// --- Config ---------------------------------------------------------------------------------------
// Sizes in px. A known width below MIN_WIDTH, or width / height outside [MIN_ASPECT, MAX_ASPECT], is rejected;
// PREFERRED_WIDTH or more scores +10.
const MIN_WIDTH = 1000;
const PREFERRED_WIDTH = 1600;
const MIN_ASPECT = 0.66;
const MAX_ASPECT = 2.4;
const ALLOWED_EXT = ['jpg', 'jpeg', 'png', 'webp'];
// Chosen photos remembered in the workflow static data (a photo seen again scores -40).
const RECENT_LIMIT = 30;
const MAX_ALTERNATES = 3;
// Wikimedia files wider than this are fetched as a thumbnail of this width (one of Wikimedia's thumbnail steps).
const COMMONS_THUMB_WIDTH = 1920;
// -15 each (singular forms; a plural "s"/"es" also matches). Checked in title, human tags, description, categories.
const NEGATIVE_TERMS = [
  'box', 'papers', 'boutique', 'store', 'shop', 'movement', 'caliber', 'calibre', 'caseback', 'case back', 'strap',
  'pocket watch', 'clock', 'illustration', 'drawing', 'sketch', 'diagram', 'render', 'rendering', 'cgi', '3d',
  'painting', 'artwork', 'packaging', 'auction', 'repair', 'disassembled',
];
// Rejected when present in title, human tags, description or categories. A human tag that merely contains one of
// them ("fakerolex", "rolexlogo", "replicawatch") counts too. Printed matter (adverts, posters, catalogues) is
// rejected rather than penalised: the photo's licence does not cover the ad or poster it reproduces.
const HARD_EXCLUDE_TERMS = [
  'replica', 'replika', 'fake', 'counterfeit', 'knockoff', 'knock off', 'superclone', 'clone', 'homage', 'imitation',
  'lookalike', 'faux', 'bootleg', 'not a rolex', 'notarolex', 'rep watch', 'repwatch', 'chinese copy',
  'logo', 'logotype', 'wordmark', 'emblem', 'clipart', 'clip art', 'cake', 'toy', 'lego', 'tattoo', 'sticker',
  'screenshot', 'meme', 'smartwatch', 'apple watch', 'applewatch',
  'advert', 'advertisement', 'advertising', 'poster', 'billboard', 'magazine', 'brochure', 'catalog', 'catalogue',
];
// Also rejected for brand and generic queries, where nothing else says the photo shows a wristwatch.
const BRAND_LEVEL_EXCLUDE_TERMS = ['pocket watch', 'pocketwatch', 'clock', 'sundial', 'stopwatch'];
// Openverse categories that are not photographs (null and "photograph" pass).
const REJECT_CATEGORIES = ['illustration', 'digitized_artwork'];
// Commons restriction-* values that reject a file ("trademarked" is normal for product photos and stays allowed).
const REJECT_RESTRICTIONS = ['personality'];
// Commons "License" codes of public domain logos, shapes and other works too simple for copyright: not photos.
const REJECT_COMMONS_LICENSE = /^pd-(textlogo|logo|shape|trivial|ineligible)/i;
// Words that make a photo a watch photo. Any word containing "watch" also counts (moonwatch, divewatch), except
// watching, watchtower, watchmaker, smartwatch and the like. "diver" alone does not count (scuba photos), nor
// German "Uhr" ("10 Uhr") or French "montre" ("shows"). Brand and generic queries need one of these in the title,
// human tags, description or categories (machine tags do not count there, and neither do WEAK_WATCH_WORDS).
const WATCH_WORDS = [
  'watch', 'wristwatch', 'timepiece', 'chronograph', 'chronometer', 'dial', 'bezel', 'wristshot', 'horology',
  'horological', 'armbanduhr', 'reloj', 'orologio',
];
// Count only for model and family queries, where the brand and model words already matched (a phone has a dial too).
const WEAK_WATCH_WORDS = ['dial', 'bezel'];
// Brands that are also everyday words or other products. Model and family queries need a watch word or a
// tag/category naming brand + family ("Omega Speedmaster"), so "Omega Centauri in the constellation Centaurus"
// does not pass for "Omega Constellation". (Brand queries need a watch word for every brand.)
const AMBIGUOUS_BRANDS = [
  'Omega', 'Tudor', 'Zenith', 'Hamilton', 'Oris', 'Ball', 'Sinn', 'Rado', 'Mido', 'Doxa', 'Fortis', 'Glycine', 'Eterna',
  'Citizen', 'Swatch', 'Hermes', 'Chanel', 'Gucci', 'Dior', 'Montblanc', 'Tiffany', 'Tiffany & Co.', 'Louis Vuitton',
  'Bulgari', 'Bvlgari', 'Porsche Design',
];
// Watch brands. A photo whose TITLE names one of these (or a brand from the post's watches) but not the query's
// brand is another brand's watch ("Tudor Submariner" for "Rolex Submariner") and is rejected.
const WATCH_BRANDS = [
  'Rolex', 'Tudor', 'Omega', 'Patek Philippe', 'Audemars Piguet', 'Vacheron Constantin', 'A. Lange & Söhne',
  'Jaeger-LeCoultre', 'Cartier', 'Breguet', 'Blancpain', 'IWC', 'Panerai', 'Breitling', 'TAG Heuer', 'Hublot', 'Zenith',
  'Longines', 'Tissot', 'Hamilton', 'Seiko', 'Grand Seiko', 'Citizen', 'Casio', 'G-Shock', 'Swatch', 'Oris',
  'Bell & Ross', 'Chopard', 'Bulgari', 'Bvlgari', 'Richard Mille', 'Ulysse Nardin', 'Girard-Perregaux', 'F.P. Journe',
  'H. Moser & Cie', 'Glashütte Original', 'Nomos', 'Sinn', 'Doxa', 'Rado', 'Mido', 'Certina', 'Frederique Constant',
  'Raymond Weil', 'Montblanc', 'Christopher Ward', 'Squale', 'Invicta', 'Steinhart', 'Parnis', 'Pagani Design',
  'San Martin', 'Seestern', 'Heimdallr', 'Corum', 'Piaget', 'Jaquet Droz', 'Parmigiani', 'MB&F',
  'Bremont', 'Fortis', 'Junghans', 'Stowa', 'Laco', 'Timex', 'Orient', 'Vostok', 'Raketa', 'Glycine', 'Eterna',
];
// Same short names as step 2 ("Image: build queries").
const BRAND_ALIASES = {
  'Audemars Piguet': ['AP', 'Audemars'],
  'Jaeger-LeCoultre': ['JLC', 'Jaeger'],
  'Vacheron Constantin': ['VC', 'Vacheron'],
  'Patek Philippe': ['PP', 'Patek'],
  'Grand Seiko': ['GS'],
  'A. Lange & Söhne': ['Lange', 'Lange & Söhne'],
};
// Words of a multi-word brand that do not identify it on their own.
const BRAND_COMMON_WORDS = [
  'grand', 'original', 'tag', 'richard', 'bell', 'ross', 'royal', 'swiss', 'international', 'watch', 'watches',
  'company', 'sohne', 'sons', 'freres', 'geneve', 'geneva', 'glashutte', 'philippe', 'constantin', 'louis', 'maurice',
  'raymond', 'frederique', 'constant', 'christopher', 'ward', 'carl', 'design', 'military', 'lange', 'seiko', 'san',
  'martin', 'shock', 'cie',
];
// Openverse source codes -> display names (from /v1/images/stats/); other codes are shown title-cased.
const SOURCE_NAMES = {
  flickr: 'Flickr', wikimedia: 'Wikimedia Commons', stocksnap: 'StockSnap.io', rawpixel: 'Rawpixel', nappy: 'Nappy',
  wordpress: 'WP Photo Directory', geographorguk: 'Geograph Britain and Ireland', inaturalist: 'iNaturalist', nasa: 'NASA',
  animaldiversity: 'Animal Diversity Web', bio_diversity: 'Biodiversity Heritage Library', brooklynmuseum: 'Brooklyn Museum',
  clevelandmuseum: 'Cleveland Museum of Art', capl: 'Culturally Authentic Pictorial Lexicon', spacex: 'SpaceX',
  deviantart: 'DeviantArt', svgsilh: 'SVG Silh', digitaltmuseum: 'Digitalt Museum', thingiverse: 'Thingiverse',
  thorvaldsensmuseum: 'Thorvaldsens Museum', worms: 'World Register of Marine Species', nypl: 'New York Public Library',
  floraon: 'Flora-On', met: 'Metropolitan Museum of Art', mccordmuseum: 'McCord Museum', museumsvictoria: 'Museums Victoria',
  phylopic: 'PhyloPic', rijksmuseum: 'Rijksmuseum', sciencemuseum: 'Science Museum - UK', sketchfab: 'Sketchfab',
  woc_tech: 'WOCinTech Chat', smithsonian_american_history_museum: 'Smithsonian Institution: National Museum of American History',
  smithsonian_air_and_space_museum: 'Smithsonian Institution: National Air and Space Museum',
  smithsonian_cooper_hewitt_museum: 'Smithsonian Institution: Cooper Hewitt Smithsonian Design Museum',
  smithsonian_institution_archives: 'Smithsonian Institution Archives', smithsonian_libraries: 'Smithsonian Institution: Smithsonian Libraries',
};
// Write each chosen photo to $getWorkflowStaticData('global').imageFinder.recent here? Off by default: n8n saves the
// WHOLE static data object at the end of every non-editor run, so a run that writes here (a Watch Centro test run
// included) can overwrite the liveRunIds that an overlapping live run saved, and a test pick would count as "used".
// Step 5 records the photo once it is really used, on the live branch (image.recent_keys). Reading is always on.
const REMEMBER_CHOSEN = false;

// --- Text helpers ---------------------------------------------------------------------------------
const str = v => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : (typeof v === 'number' ? String(v) : ''));
const norm = s => String(s ?? '').replace(/ß/g, 'ss').replace(/[øØ]/g, 'o').replace(/[æÆ]/g, 'ae')
  .replace(/[œŒ]/g, 'oe').replace(/[łŁ]/g, 'l').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').trim();
const compact = s => norm(s).replace(/ /g, '');
const pad = s => ' ' + s + ' ';
const hasPhrase = (padded, phraseNorm) => phraseNorm !== '' && padded.includes(' ' + phraseNorm + ' ');
const hasTerm = (padded, termNorm) => hasPhrase(padded, termNorm) || hasPhrase(padded, termNorm + 's') || hasPhrase(padded, termNorm + 'es');
// German spellings: "Söhne" may be written "Soehne", "Glashütte" "Glashuette" (and the reverse).
const umlauts = s => String(s).replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue');
const variants = s => [...new Set([norm(s), norm(umlauts(s)), norm(s).replace(/([aou])e/g, '$1')])].filter(Boolean);
const TOKEN_STOP = new Set(['the', 'a', 'an', 'and', 'of', 'de', 'la', 'le', 'watch', 'watches']);
const tokensOf = s => norm(s).split(' ').filter(t => t && !TOKEN_STOP.has(t));

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
// Commons extmetadata values are HTML; hidden Wikidata labels ("label QS:...") are dropped.
function htmlText(s) {
  if (s === null || s === undefined || typeof s === 'object') return '';
  let t = String(s).slice(0, 6000);
  t = t.replace(/<(div|span)\b[^>]*display\s*:\s*none[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  t = t.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' ');
  return decodeEntities(t).replace(/\s+/g, ' ').trim();
}
// Plain text for alt and credit lines: no URLs, no em or en dashes, no double quotes, bounded length.
function plain(s, max) {
  let t = String(s ?? '').replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ').replace(/[\u2012-\u2015\u2212]/g, '-')
    .replace(/["\u201c\u201d\u201e]/g, "'").replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (max && t.length > max) t = t.slice(0, max - 3).replace(/\s+\S*$/, '') + '...';
  return t;
}
const FILE_EXT_RE = /\.(jpe?g|png|gif|tiff?|svg|webp|bmp|xcf|psd|ogg|ogv|webm|wav|mp3|mp4|pdf|djvu)$/i;
const cleanTitle = t => htmlText(t).replace(/^file:\s*/i, '').replace(FILE_EXT_RE, '').trim();
const isHttp = u => typeof u === 'string' && /^https?:\/\/[^\s/]+/i.test(u.trim());
const absUrl = u => {
  const s = decodeEntities(String(u || '').trim());
  if (s.startsWith('//')) return 'https:' + s;
  if (s.startsWith('/wiki/') || s.startsWith('/w/')) return 'https://commons.wikimedia.org' + s;
  return s;
};
function safeDecode(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }
function urlPath(u) {
  const m = String(u || '').match(/^[a-z]+:\/\/[^/?#]+([^?#]*)/i);
  return m ? m[1] : '';
}
function extOf(u) {
  const last = safeDecode(urlPath(u) || String(u || '')).split('/').pop() || '';
  const m = last.match(/\.([a-z0-9]{2,5})$/i);
  return m ? m[1].toLowerCase() : '';
}
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];
// Lower-cased host + path without scheme, "www.", query or trailing slash; Wikimedia thumbnails map to their original.
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

// --- Brands and relevance ---------------------------------------------------------------------------
const ALIAS_TO_BRAND = {};
for (const [brand, aliases] of Object.entries(BRAND_ALIASES)) {
  ALIAS_TO_BRAND[norm(brand)] = brand;
  for (const a of aliases) ALIAS_TO_BRAND[norm(a)] = brand;
}
const COMMON_SET = new Set(BRAND_COMMON_WORDS);
const AMBIGUOUS = new Set(AMBIGUOUS_BRANDS.map(norm));
const WATCH_NORMS = WATCH_WORDS.map(norm);
const STRONG_WATCH_NORMS = WATCH_WORDS.filter(w => !WEAK_WATCH_WORDS.includes(w)).map(norm);
const NEG_NORMS = NEGATIVE_TERMS.map(t => [t, norm(t)]);
const EXCL_NORMS = HARD_EXCLUDE_TERMS.map(t => [t, norm(t)]);
const LEVEL_EXCL_NORMS = BRAND_LEVEL_EXCLUDE_TERMS.map(t => [t, norm(t)]);
const canonOf = b => ALIAS_TO_BRAND[norm(b)] || b;
// Spellings or lines of one brand: never "another brand" of each other.
const SAME_BRANDS = [['Bulgari', 'Bvlgari'], ['Casio', 'G-Shock']].map(g => g.map(norm));
const sameBrand = (a, b) => norm(canonOf(a)) === norm(canonOf(b)) ||
  SAME_BRANDS.some(g => g.includes(norm(canonOf(a))) && g.includes(norm(canonOf(b))));

// Ways the query brand can be named. famSrc: two-letter short names (AP, VC, GS) only count as "<short> <family>"
// ("AP Royal Oak"), never alone ("The Royal Oak pub" tagged "ap").
function brandNeedles(brand, level, famSrc) {
  const canonical = canonOf(brand);
  const out = new Set([...variants(brand), ...variants(canonical)]);
  for (const a of BRAND_ALIASES[canonical] || []) {
    if (compact(a).length <= 2) {
      if (level !== 'brand' && famSrc) for (const v of variants(a + ' ' + famSrc)) out.add(v);
      continue;
    }
    for (const v of variants(a)) out.add(v);
  }
  const toks = norm(canonical).split(' ').filter(Boolean);
  if (toks.length > 1) for (const t of toks) if (t.length >= 4 && !COMMON_SET.has(t)) out.add(t);
  return [...out].filter(Boolean);
}
// Ways another brand can be named in a title (short names of 3+ characters, distinctive words).
const rivalCache = new Map();
function rivalNeedles(brand) {
  const key = norm(brand);
  if (!rivalCache.has(key)) {
    const canonical = canonOf(brand);
    const out = new Set([...variants(brand), ...variants(canonical)]);
    for (const a of BRAND_ALIASES[canonical] || []) if (compact(a).length >= 3) for (const v of variants(a)) out.add(v);
    const toks = norm(canonical).split(' ').filter(Boolean);
    if (toks.length > 1) for (const t of toks) if (t.length >= 4 && !COMMON_SET.has(t)) out.add(t);
    rivalCache.set(key, [...out].filter(Boolean));
  }
  return rivalCache.get(key);
}

// Text of one candidate. `full` (positive evidence) also has machine tags; `strict` (exclusions, penalties) does not;
// `named` (where a brand must be named) is the title plus human tags / Commons categories, without descriptions.
function textInfo(title, humanTags, machineTags, extra) {
  const human = humanTags.map(norm).filter(Boolean);
  const machine = machineTags.map(norm).filter(Boolean);
  const strictText = norm([title, human.join(' '), extra].join(' '));
  return {
    full: pad(norm([strictText, machine.join(' ')].join(' '))),
    strict: pad(strictText),
    named: pad(norm([title, human.join(' ')].join(' '))),
    title: pad(norm(title)),
    tags: human.concat(machine).map(t => t.replace(/ /g, '')),
    strictTags: human.map(t => t.replace(/ /g, '')),
  };
}
// Flickr-style concatenated tags ("rolexsubmariner"): a whole name of 4+ characters may sit inside a tag, a single
// word only from 5 characters ("nodate" must not prove "date").
const tagIncludes = (info, c) => c.length >= 4 && info.tags.some(t => t.includes(c));
const tokenIn = (info, t) => hasPhrase(info.full, t) || (t.length >= 5 && tagIncludes(info, t));
const namedIn = (info, phrase) => {
  const c = phrase.replace(/ /g, '');
  return hasPhrase(info.named, phrase) || (c.length >= 4 && info.strictTags.some(t => t.includes(c)));
};
const isWatchToken = t => t.includes('watch') &&
  !/watch(ing|ed|ers?|towers?|m[ae]n|dogs?|ful|list|words?|keepers?|mak(er|ers|ing)|bands?)$/.test(t) &&
  !/^(bird|whale|night|smart|apple|stop|s)watch/.test(t);
// strong: title, human tags, description and categories only, and not "dial" or "bezel" alone.
function hasWatchWord(info, strong) {
  const text = strong ? info.strict : info.full;
  const tags = strong ? info.strictTags : info.tags;
  return (strong ? STRONG_WATCH_NORMS : WATCH_NORMS).some(w => hasTerm(text, w)) || text.split(' ').some(isWatchToken) ||
    tags.some(t => isWatchToken(t) || t.includes('chronograph'));
}
// Terms in the text, or a human tag that is (or, loose, contains) the term: "fakerolex", "rolexlogo".
// "meme" is only matched whole ("mementomori" is a watch theme).
function termsIn(info, list, loose) {
  const hits = [];
  for (const [label, n] of list) {
    const c = n.replace(/ /g, '');
    const tagHit = info.strictTags.some(t => t === c || t === c + 's' || (loose && c.length >= 4 && c !== 'meme' && t.includes(c)));
    if (hasTerm(info.strict, n) || tagHit) hits.push(label);
  }
  return hits;
}
// The title names another watch brand and not the query brand ("Tudor Submariner" for "Rolex Submariner").
function rivalInTitle(info, q, postBrands) {
  const own = brandNeedles(q.brand, 'model', q.model_family || q.model);
  if (own.some(n => hasPhrase(info.title, n))) return '';
  for (const b of WATCH_BRANDS.concat(postBrands || [])) {
    if (!b || sameBrand(b, q.brand)) continue;
    if (rivalNeedles(b).some(n => hasPhrase(info.title, n))) return b;
  }
  return '';
}

// Level rules: model/family need the brand (named in title, tags or categories), every family token and no other
// brand in the title; brand needs the brand and a watch word; generic a watch word.
function relevance(info, q, postBrands) {
  const r = { ok: false, modelHit: false, refHit: false, watchWord: hasWatchWord(info, false), strongWatch: hasWatchWord(info, true), rival: '' };
  const level = q.level;
  if (level === 'generic' || !q.brand) {
    r.ok = r.strongWatch;
    return r;
  }
  const famSrc = q.model_family || q.model;
  if (!brandNeedles(q.brand, level, famSrc).some(n => namedIn(info, n))) return r;
  r.rival = rivalInTitle(info, q, postBrands);
  if (r.rival) return r;
  const canonical = canonOf(q.brand);
  const ambiguous = AMBIGUOUS.has(norm(canonical)) || AMBIGUOUS.has(norm(q.brand));
  if (level === 'brand') { r.ok = r.strongWatch; return r; }
  const famOk = !famSrc || variants(famSrc).some(v => {
    const toks = v.split(' ').filter(t => t && !TOKEN_STOP.has(t));
    return toks.every(t => tokenIn(info, t)) || tagIncludes(info, v.replace(/ /g, ''));
  });
  if (!famOk) return r;
  if (ambiguous && !r.watchWord) {
    const named = [canonical, q.brand].flatMap(b => variants(b + ' ' + famSrc)).map(v => v.replace(/ /g, ''));
    if (!info.strictTags.some(t => named.some(n => t.startsWith(n)))) return r;
  }
  r.ok = true;
  const famToks = new Set(tokensOf(famSrc));
  const brandToks = new Set(tokensOf(canonical).concat(tokensOf(q.brand)));
  const extra = tokensOf(q.model).filter(t => !famToks.has(t) && !brandToks.has(t));
  // Model words beyond the family must appear as words, or the whole name inside a tag ("submarinerdate").
  r.modelHit = extra.length > 0 && (extra.every(t => hasPhrase(info.full, t)) ||
    tagIncludes(info, compact(q.model)) || tagIncludes(info, compact(famSrc + ' ' + extra.join(' '))));
  const ref = norm(q.reference);
  if (/\d/.test(ref) && ref.replace(/ /g, '').length >= 3) {
    const c = ref.replace(/ /g, '');
    r.refHit = hasPhrase(info.full, ref) || hasPhrase(info.full, c) || info.tags.some(t => t === c || (c.length >= 5 && t.includes(c)));
  }
  return r;
}

// --- Licences ---------------------------------------------------------------------------------------
// Parses "CC BY-SA 3.0 de", "CC-BY-SA-3.0", "cc-by-sa-4.0", "CC0", "Public domain", "CC BY-NC 2.0", ...
// code: by | by-sa | cc0 | pd | pdm | ncnd | other.
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
// creativecommons.org licence URL -> same shape; any other URL -> {code: 'noncc'}.
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
// Final licence fields: license (cc0 | pdm | by | by-sa), version, name, url.
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
// Combine the licence fields a provider gives; returns {lic} or {reject}.
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

// --- Creators ---------------------------------------------------------------------------------------
// "No author given", in the languages Commons files use most.
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
// Commons "Attribution": the credit the licensor asks for ("Foto: Kronograph / Wikimedia Commons / CC BY-SA 3.0 DE").
// CC BY / BY-SA require that requested name, so it wins over Artist. The "Photo:" label and the parts that only
// repeat the source or the licence are dropped (the credit line adds those itself).
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

// --- Ids and dedupe keys ----------------------------------------------------------------------------
function flickrIdOf(...urls) {
  for (const u of urls) {
    const s = String(u || '');
    let m = s.match(/flickr\.com\/photos\/[^/]+\/(\d{5,})/i);
    if (m) return m[1];
    m = s.match(/staticflickr\.com\/(?:\d+\/)+(\d{5,})_[0-9a-f]+/i);
    if (m) return m[1];
  }
  return '';
}
// Flickr2Commons file names end in "(<Flickr photo id>)".
const flickrIdInTitle = t => { const m = String(t || '').match(/\((\d{8,13})\)\s*$/); return m ? m[1] : ''; };
const curidOf = u => { const m = String(u || '').match(/commons\.wikimedia\.org\/w\/index\.php\?(?:[^#]*&)?curid=(\d+)/i); return m ? m[1] : ''; };

// https://upload.wikimedia.org/wikipedia/commons/4/4c/Name.jpg -> .../thumb/4/4c/Name.jpg/1920px-Name.jpg
function wikimediaThumb(url, width) {
  const m = String(url || '').match(/^(https:\/\/upload\.wikimedia\.org\/[^/]+\/[^/]+)\/([0-9a-f]\/[0-9a-f]{2})\/([^/?#]+)(?:[?#].*)?$/i);
  if (!m || m[3].length > 160 || !['jpg', 'jpeg', 'png'].includes(extOf(m[3]))) return '';
  return `${m[1]}/thumb/${m[2]}/${m[3]}/${width}px-${m[3]}`;
}
const thumbPx = u => { const m = urlPath(u).match(/\/thumb\/.*\/(\d+)px-[^/]+$/); return m ? Number(m[1]) : 0; };
// Wikimedia files wider than COMMONS_THUMB_WIDTH: use (or build) that thumbnail; real thumb size is
// COMMONS_THUMB_WIDTH x round(h * COMMONS_THUMB_WIDTH / w). imageinfo thumbwidth/thumbheight are NOT the pixel size.
function wikimediaFile(url, thumburl, w, h) {
  if (!(w > COMMONS_THUMB_WIDTH && h > 0)) return { file_url: url, width: w, height: h };
  const tw = COMMONS_THUMB_WIDTH;
  const th = Math.round(h * tw / w);
  if (thumburl && thumbPx(thumburl) === tw && extOf(thumburl) === extOf(url)) return { file_url: thumburl, width: tw, height: th };
  const built = wikimediaThumb(url, tw);
  return built ? { file_url: built, width: tw, height: th } : { file_url: url, width: w, height: h };
}

// --- Provider records -> candidates ------------------------------------------------------------------
const posInt = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : null);
// ident: who the photo is (ids, URLs, title, size), so a rejection can also veto its copy at the other provider.
const reject = (category, detail, ident) => ({ reject: category, detail: detail || category, ident: ident || null });
// Rejections that say something about the photo itself. Openverse indexes Commons and Flickr, and Commons holds
// Flickr copies, so the same photo with one of these verdicts at one provider is dropped at the other one too
// (Commons knows restrictions, NonFree and licence reviews that Openverse does not carry).
const VETO_REJECTS = ['licence', 'personality', 'mature', 'excluded term', 'not a photo'];

// Checks shared by both providers once a record is normalised.
function commonChecks(c) {
  if (!isHttp(c.file_url) || !isHttp(c.landing_url)) return reject('missing url', '', c);
  if (!c.extension || !ALLOWED_EXT.includes(c.extension) || (c.mime && !ALLOWED_MIME.includes(c.mime))) return reject('file type', 'file type ' + (c.extension || c.mime || 'unknown'), c);
  if (c._ow !== null && c._ow < MIN_WIDTH) return reject('too small', '', c);
  if (c._ow !== null && c._oh !== null) {
    const a = c._ow / c._oh;
    if (a < MIN_ASPECT || a > MAX_ASPECT) return reject('aspect', '', c);
  }
  const ex = termsIn(c._info, EXCL_NORMS, true);
  if (ex.length) return reject('excluded term', 'excluded term ' + ex[0], c);
  return null;
}

function fromOpenverse(r, pos) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return reject('bad record');
  const url = absUrl(str(r.url));
  const landing = absUrl(str(r.foreign_landing_url));
  const ow = posInt(r.width);
  const oh = posInt(r.height);
  const title = plain(cleanTitle(r.title), 300);
  const isWikimedia = /(^|\.)upload\.wikimedia\.org$/i.test((url.match(/^https?:\/\/([^/]+)/i) || [])[1] || '');
  const curid = curidOf(landing);
  const ident = {
    provider: 'openverse', id: str(r.id), title, landing_url: landing, file_url: url, _origUrl: url, _ow: ow, _oh: oh,
    _commonsId: curid, _flickrId: flickrIdOf(landing, url) || (isWikimedia || curid ? flickrIdInTitle(title) : ''),
  };
  // Openverse license codes: cc0, pdm, by, by-sa (the request asks for these), by-nc, by-nd, ... (rejected).
  const code = str(r.license).toLowerCase();
  const name = code === 'cc0' || code === 'pdm' ? code : (code ? 'cc ' + code + ' ' + str(r.license_version) : '');
  const d = decideLicense([name], r.license_url, '', '');
  if (d.reject) return reject(d.reject, d.detail, ident);
  if (r.mature === true || (Array.isArray(r.unstable__sensitivity) && r.unstable__sensitivity.length)) return reject('mature', '', ident);
  const category = str(r.category).toLowerCase();
  if (REJECT_CATEGORIES.includes(category)) return reject('not a photo', 'category ' + category, ident);
  // filetype is often null (older Flickr rows); the URL extension is what Openverse's own extension filter uses.
  const urlExt = extOf(url);
  const ft = str(r.filetype).toLowerCase();
  const extension = ft && !ALLOWED_EXT.includes(ft) ? ft : (urlExt || ft);
  const source = str(r.source || r.provider).toLowerCase();
  const tags = Array.isArray(r.tags) ? r.tags.filter(t => t && typeof t === 'object' && typeof t.name === 'string') : [];
  const human = tags.filter(t => t.accuracy === null || t.accuracy === undefined).map(t => t.name);
  const machine = tags.filter(t => !(t.accuracy === null || t.accuracy === undefined)).map(t => t.name);
  const file = isWikimedia && ow && oh ? wikimediaFile(url, '', ow, oh) : { file_url: url, width: ow, height: oh };
  const creator = cleanCreator(r.creator);
  const sourceName = SOURCE_NAMES[source] || (source ? source.replace(/_/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b[a-z]/g, x => x.toUpperCase()) : 'Openverse');
  const c = {
    ...ident,
    source_name: sourceName, creator, creator_url: isHttp(r.creator_url) ? r.creator_url.trim() : '',
    ...licenseFields(d.lic, r.license_url),
    landing_url: landing, file_url: file.file_url, width: file.width, height: file.height,
    extension, mime: MIME[extension] || '', attribution_required: d.lic.code === 'by' || d.lic.code === 'by-sa',
    _pos: pos,
    _info: textInfo(str(r.title), human.concat(category ? [category.replace(/_/g, ' ')] : []), machine, ''),
  };
  return commonChecks(c) || { cand: c };
}

function fromCommons(page, pos) {
  if (!page || typeof page !== 'object' || Array.isArray(page)) return reject('bad record');
  const ii = Array.isArray(page.imageinfo) ? page.imageinfo[0] : null;
  if (!ii || typeof ii !== 'object') return reject('no file info');
  const em = ii.extmetadata && typeof ii.extmetadata === 'object' ? ii.extmetadata : {};
  const meta = k => {
    const v = em[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) return v.value === null || v.value === undefined ? '' : String(v.value);
    return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
  };
  const rawTitle = str(page.title);
  const title = plain(cleanTitle(rawTitle), 300);
  const ow = posInt(ii.width);
  const oh = posInt(ii.height);
  const url = absUrl(str(ii.url));
  const ident = {
    provider: 'commons', id: page.pageid === undefined || page.pageid === null ? '' : String(page.pageid), title,
    landing_url: absUrl(str(ii.descriptionurl || ii.descriptionshorturl)), file_url: url, _origUrl: url, _ow: ow, _oh: oh,
    _commonsId: page.pageid ? String(page.pageid) : curidOf(ii.descriptionshorturl),
    _flickrId: flickrIdInTitle(title) || flickrIdOf(meta('Credit').match(/href="([^"]+)"/i)?.[1] || ''),
  };
  const d = decideLicense([meta('LicenseShortName'), meta('License')], meta('LicenseUrl'), meta('UsageTerms'), meta('NonFree'));
  if (d.reject) return reject(d.reject, d.detail, ident);
  if (REJECT_COMMONS_LICENSE.test(meta('License').trim())) return reject('licence', 'public domain logo or simple shape', ident);
  const restrictions = meta('Restrictions').toLowerCase().split('|').map(s => s.trim()).filter(Boolean);
  const bad = restrictions.find(x => REJECT_RESTRICTIONS.includes(x));
  if (bad) return reject('personality', 'restriction ' + bad, ident);
  const extension = extOf(rawTitle) || extOf(url);
  const file = wikimediaFile(url, absUrl(str(ii.thumburl)), ow, oh);
  const mime = str(ii.mime).toLowerCase();
  const categories = meta('Categories').split('|').map(s => s.trim()).filter(Boolean);
  const description = [htmlText(meta('ObjectName')), htmlText(meta('ImageDescription'))].join(' ');
  const artist = meta('Artist');
  const c = {
    ...ident,
    source_name: 'Wikimedia Commons',
    creator: requestedCredit(meta('Attribution')) || cleanCreator(artist), creator_url: artistUrl(artist),
    ...licenseFields(d.lic, meta('LicenseUrl')),
    file_url: file.file_url, width: file.width, height: file.height,
    extension, mime: ALLOWED_MIME.includes(mime) ? mime : (mime || MIME[extension] || ''),
    attribution_required: d.lic.code === 'by' || d.lic.code === 'by-sa' || /^true$/i.test(meta('AttributionRequired').trim()),
    _pos: pos,
    _info: textInfo(rawTitle.replace(/^file:/i, '').replace(FILE_EXT_RE, ''), categories, [], description),
  };
  return commonChecks(c) || { cand: c };
}

function keysOf(c) {
  const keys = new Set();
  if (c._commonsId) keys.add('commons:' + c._commonsId);
  if (c._flickrId) keys.add('flickr:' + c._flickrId);
  for (const u of [c._origUrl, c.file_url]) { const n = normUrl(u); if (n) keys.add('file:' + n); }
  const l = normUrl(c.landing_url);
  if (l && !curidOf(c.landing_url)) keys.add('page:' + l);
  const t = norm(c.title);
  if (t && c._ow && c._oh) keys.add('td:' + t + '|' + c._ow + 'x' + c._oh);
  if (c.id) keys.add(c.provider + ':' + c.id);
  return [...keys];
}
const primaryKey = keys => keys.find(k => k.startsWith('commons:')) || keys.find(k => k.startsWith('flickr:')) ||
  keys.find(k => k.startsWith('file:')) || keys[0] || '';
// Keys worth remembering (title + size and landing pages are dedupe-only), the primary key first.
function recentKeysOf(c) {
  const keys = c._keys.filter(k => !k.startsWith('td:') && !k.startsWith('page:'));
  const key = primaryKey(c._keys);
  return [key].concat(keys.filter(k => k !== key)).filter(Boolean);
}

// --- Scoring ----------------------------------------------------------------------------------------
function scoreOf(c, q, rel, recent) {
  let score = 0;
  const reasons = [];
  const add = (n, why) => { score += n; reasons.push((n > 0 ? '+' : '') + n + ' ' + why); };
  if (rel.modelHit) add(20, 'model tokens present');
  if (rel.refHit) add(15, 'reference ' + q.reference);
  const known = c.width !== null && c.height !== null;
  if (known && c.width >= PREFERRED_WIDTH) add(10, 'width >= ' + PREFERRED_WIDTH);
  if (known && c.width / c.height >= 1.2 && c.width / c.height <= 2.0) add(5, 'landscape');
  if (c.provider === 'openverse') add(3, 'openverse');
  for (const t of termsIn(c._info, NEG_NORMS, false)) add(-15, 'negative term ' + t);
  if (!known) add(-10, 'unknown dimensions');
  if (c._creatorUnknown && c.attribution_required) add(-10, 'creator unknown');
  if (c._keys.some(k => recent.has(k))) add(-40, 'recently used');
  return { score, reasons };
}

const PROVIDER_ORDER = { openverse: 0, commons: 1 };
const better = (a, b) => (a.query.rank - b.query.rank) || (b.score - a.score) ||
  (PROVIDER_ORDER[a.provider] - PROVIDER_ORDER[b.provider]) || (a._pos - b._pos) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// --- Output fields of a chosen photo ------------------------------------------------------------------
function altFor(q, c) {
  if (q.level === 'generic' || !q.brand) return 'Luxury wristwatch';
  if (q.level === 'brand') return plain(q.brand + ' watch', 150);
  let name = q.model_family || q.model;
  if (q.model && (q.level === 'model' || c._modelHit || !q.model_family)) {
    name = q.model_family && !hasPhrase(pad(norm(q.model)), norm(q.model_family)) ? q.model_family + ' ' + q.model : q.model;
  }
  let alt = plain(q.brand + ' ' + name, 140);
  if (!/\bwatch(es)?$/i.test(alt)) alt += ' watch';
  return alt;
}
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
const slug = s => norm(s).replace(/ /g, '-');
function filenameFor(alt, c) {
  const ext = c.extension === 'jpeg' ? 'jpg' : (c.extension || 'jpg');
  const id = String(c.id).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
  const tail = '-' + c.provider + (id ? '-' + id : '') + '.' + ext;
  const base = slug(alt).slice(0, Math.max(1, 80 - tail.length)).replace(/-+$/, '');
  return (base || 'watch') + tail;
}
function present(c) {
  const out = {
    provider: c.provider, source_name: c.source_name, id: c.id, title: c.title, creator: c.creator,
    creator_url: c.creator_url, license: c.license, license_version: c.license_version, license_name: c.license_name,
    license_url: c.license_url, landing_url: c.landing_url, file_url: c.file_url, width: c.width, height: c.height,
    extension: c.extension, mime: c.mime, attribution_required: c.attribution_required, query: c.query,
    score: c.score, reasons: c.reasons,
  };
  out.alt_text = altFor(c._q, c);
  out.credit_text = creditFor(c);
  out.download_filename = filenameFor(out.alt_text, c);
  // What step 5 records in the static data once the photo is really used (see REMEMBER_CHOSEN).
  out.recent_keys = recentKeysOf(c);
  return out;
}

// --- Responses -----------------------------------------------------------------------------------------
const toCode = v => { const n = typeof v === 'string' ? parseInt(v, 10) : v; return Number.isInteger(n) && n >= 100 && n <= 599 ? n : 0; };
// n8n failure item ({error: AxiosError.toJSON()} etc.) -> short label such as "HTTP 429", "timeout", "ECONNRESET".
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
// One response item -> {status: ok|error|skipped, http_error?, records}.
function readResponse(json, provider) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { status: 'error', http_error: 'empty response', records: [] };
  let body = json;
  // neverError + fullResponse: {body | data, headers, statusCode, statusMessage}
  if (toCode(json.statusCode) && ('body' in json || 'data' in json || 'headers' in json)) {
    const code = toCode(json.statusCode);
    if (code < 200 || code >= 300) return { status: 'error', http_error: 'HTTP ' + code, records: [] };
    body = 'body' in json ? json.body : json.data;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { return { status: 'error', http_error: 'non-JSON response', records: [] }; } }
    if (!body || typeof body !== 'object') return { status: 'error', http_error: 'empty response', records: [] };
  }
  if (typeof body.post_index === 'number' && typeof body.q === 'string') return { status: 'skipped', records: [] }; // node disabled: input passed through
  if (body.error !== undefined && body.error !== null) {
    const e = body.error;
    if (provider === 'commons' && e && typeof e === 'object' && typeof e.code === 'string' && e.info !== undefined && !e.name) {
      return { status: 'error', http_error: 'API ' + e.code, records: [] }; // MediaWiki error (HTTP 200)
    }
    return { status: 'error', http_error: n8nErrorLabel(e), records: [] };
  }
  if (typeof body.data === 'string') return { status: 'error', http_error: 'non-JSON response', records: [] };
  if (provider === 'openverse') {
    if (Array.isArray(body.results)) return { status: 'ok', records: body.results };
    if (body.detail !== undefined) {
      const t = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail);
      return { status: 'error', http_error: /throttled/i.test(t) ? 'HTTP 429' : 'API error: ' + plain(t, 60), records: [] };
    }
    return { status: 'error', http_error: 'unexpected response', records: [] };
  }
  if (Array.isArray(body.results)) return { status: 'skipped', records: [] }; // Commons node disabled: Openverse passed through
  const q = body.query && typeof body.query === 'object' ? body.query : null;
  if (q && q.pages && typeof q.pages === 'object') {
    // formatversion=2 gives a list, formatversion=1 an object keyed by page id. The list is NOT in
    // relevance order: sort by "index" (1-based search position).
    const pages = (Array.isArray(q.pages) ? q.pages : Object.values(q.pages)).filter(p => p && typeof p === 'object');
    const idx = (p, i) => (Number.isFinite(p.index) ? p.index : 1e9 + i);
    const order = pages.map((p, i) => [idx(p, i), i, p]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(x => x[2]);
    return { status: 'ok', records: order };
  }
  if ('batchcomplete' in body || 'continue' in body || 'query' in body || 'warnings' in body) return { status: 'ok', records: [] };
  return { status: 'error', http_error: 'unexpected response', records: [] };
}

// --- Node data -----------------------------------------------------------------------------------------
// .all() throws when the node has not run; null then means "not executed".
function nodeItems(read) {
  try { const a = read(); return Array.isArray(a) ? a : null; } catch (e) { return null; }
}
function pairedIndex(item) {
  const p = item && item.pairedItem;
  const one = Array.isArray(p) ? p[0] : p;
  if (typeof one === 'number' && Number.isInteger(one)) return one;
  if (one && typeof one === 'object' && Number.isInteger(one.item)) return one.item;
  return null;
}
// For each item of a node, the index of its parent item (pairedItem first, else the same position).
function parentIndexes(items, parentCount) {
  return items.map((it, j) => {
    const pi = pairedIndex(it);
    if (pi !== null && pi >= 0 && pi < parentCount) return pi;
    return j < parentCount ? j : -1;
  });
}

function emptyStats() { return { errors: {}, skipped: 0, ok: 0, results: 0, passed: 0, rejects: {} }; }
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
function providerSummary(name, s) {
  const parts = Object.entries(s.errors).map(([e, n]) => `${n}x ${e}`);
  if (s.skipped) parts.push(`${s.skipped}x skipped`);
  if (s.ok) {
    const top = Object.entries(s.rejects).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([r, n]) => `${r} ${n}`);
    parts.push(`${plural(s.results, 'result', 'results')} in ${plural(s.ok, 'search', 'searches')}, ${s.passed} passed` + (top.length ? ` (${top.join(', ')})` : ''));
  }
  return `${name}: ${parts.join(', ') || 'no searches'}`;
}

function pickForPost(entries, recent, postBrands) {
  const search_log = [];
  const stats = { openverse: emptyStats(), commons: emptyStats() };
  const candidates = [];
  const vetoed = new Set();
  const count = (s, why) => { s.rejects[why] = (s.rejects[why] || 0) + 1; };
  for (const e of entries) {
    const q = e.query;
    for (const provider of ['openverse', 'commons']) {
      const items = e[provider];
      const s = stats[provider];
      const read = (items || []).map(it => readResponse(it && it.json, provider));
      const ok = read.filter(x => x.status === 'ok');
      const err = read.find(x => x.status === 'error');
      if (!ok.length) {
        if (err) {
          search_log.push({ rank: q.rank, q: q.q, provider, status: 'error', http_error: err.http_error, results: 0, passed: 0 });
          s.errors[err.http_error] = (s.errors[err.http_error] || 0) + 1;
        } else {
          search_log.push({ rank: q.rank, q: q.q, provider, status: 'skipped', results: 0, passed: 0 });
          s.skipped++;
        }
        continue;
      }
      const records = ok.flatMap(x => x.records);
      const log = { rank: q.rank, q: q.q, provider, status: 'ok', results: records.length, passed: 0 };
      search_log.push(log);
      s.ok++;
      s.results += records.length;
      records.forEach((rec, pos) => {
        let res;
        try { res = provider === 'openverse' ? fromOpenverse(rec, pos) : fromCommons(rec, pos); } catch (err) { res = reject('bad record'); }
        if (res.reject) {
          count(s, res.reject);
          if (res.ident && VETO_REJECTS.includes(res.reject)) for (const k of keysOf(res.ident)) vetoed.add(k);
          return;
        }
        const c = res.cand;
        const rel = relevance(c._info, q, postBrands);
        if (!rel.ok) { count(s, rel.rival ? 'other brand' : 'not relevant'); return; }
        if ((q.level === 'brand' || q.level === 'generic' || !q.brand) && termsIn(c._info, LEVEL_EXCL_NORMS, true).length) {
          count(s, 'not a wristwatch');
          return;
        }
        c._creatorUnknown = !c.creator;
        if (!c.creator) c.creator = 'Unknown author';
        c._modelHit = rel.modelHit;
        c._q = q;
        c._keys = keysOf(c);
        c._log = log;
        c.query = { rank: q.rank, q: q.q, level: q.level, watch_index: q.watch_index };
        const sc = scoreOf(c, q, rel, recent);
        c.score = sc.score;
        c.reasons = sc.reasons;
        candidates.push(c);
        log.passed++;
        s.passed++;
      });
    }
  }
  // A copy of a photo that the other provider rejected (licence, personality, mature, excluded term) is dropped too.
  for (let i = candidates.length - 1; i >= 0; i--) {
    const c = candidates[i];
    if (!c._keys.some(k => vetoed.has(k))) continue;
    candidates.splice(i, 1);
    c._log.passed--;
    stats[c.provider].passed--;
    count(stats[c.provider], 'copy rejected elsewhere');
  }
  // Same photo from both providers (Openverse indexes Commons and Flickr) or from two queries: keep the better copy.
  candidates.sort(better);
  const seen = new Set();
  const kept = [];
  for (const c of candidates) {
    const dup = c._keys.some(k => seen.has(k));
    for (const k of c._keys) seen.add(k);
    if (!dup) kept.push(c);
  }
  if (!kept.length) {
    const n = entries.length;
    const image_error = n
      ? `no licence-safe relevant photo found for ${plural(n, 'query', 'queries')}; ` + ['openverse', 'commons'].map(p => providerSummary(p, stats[p])).join('; ')
      : 'no image queries for this post';
    return { image: null, image_error, alternates: [], search_log, chosen: null };
  }
  return {
    image: present(kept[0]), image_error: '', alternates: kept.slice(1, 1 + MAX_ALTERNATES).map(present),
    search_log, chosen: kept[0],
  };
}

// --- Main ----------------------------------------------------------------------------------------------
const posts = nodeItems(() => $('Image: build queries').all()) || [];
const splits = nodeItems(() => $('Image: split queries').all()) || [];
const ovItems = nodeItems(() => $('Image: search Openverse').all());
const cmItems = nodeItems(() => $('Image: search Commons').all());

// Recently chosen photos: $getWorkflowStaticData('global').imageFinder.recent = [{key, keys, at}]. Read only, unless
// REMEMBER_CHOSEN is on: even repairing a missing list would be a write, and n8n then saves the whole static data.
let store = null;
try {
  const g = $getWorkflowStaticData('global');
  if (g && typeof g === 'object') {
    if (REMEMBER_CHOSEN) {
      if (!g.imageFinder || typeof g.imageFinder !== 'object' || Array.isArray(g.imageFinder)) g.imageFinder = {};
      if (!Array.isArray(g.imageFinder.recent)) g.imageFinder.recent = [];
    }
    if (g.imageFinder && typeof g.imageFinder === 'object' && Array.isArray(g.imageFinder.recent)) store = g.imageFinder;
  }
} catch (e) { /* no static data: nothing is remembered */ }
// Photos chosen earlier in this execution (two posts of one run never share a photo, whatever REMEMBER_CHOSEN is).
const chosenThisRun = new Set();
const recentSet = () => {
  const s = new Set(chosenThisRun);
  for (const r of store && Array.isArray(store.recent) ? store.recent : []) {
    if (typeof r === 'string') s.add(r);
    else if (r && typeof r === 'object') {
      if (typeof r.key === 'string') s.add(r.key);
      if (Array.isArray(r.keys)) for (const k of r.keys) if (typeof k === 'string') s.add(k);
    }
  }
  return s;
};
function remember(c) {
  try {
    const keys = recentKeysOf(c);
    for (const k of keys) chosenThisRun.add(k);
    if (!REMEMBER_CHOSEN || !store) return;
    const old = Array.isArray(store.recent) ? store.recent : [];
    const kept = old.filter(r => {
      const rk = typeof r === 'string' ? [r] : (r && typeof r === 'object' ? [r.key].concat(Array.isArray(r.keys) ? r.keys : []) : []);
      return !rk.some(k => keys.includes(k));
    });
    kept.push({ key: keys[0], keys, at: new Date().toISOString() });
    store.recent = kept.slice(-RECENT_LIMIT); // a new array, so n8n sees the change
  } catch (e) { /* remembering is best effort */ }
}

// Which query (split item) each search response belongs to, and which post each query belongs to.
function alignment() {
  const ovSplit = ovItems ? parentIndexes(ovItems, splits.length) : [];
  const cmSplit = cmItems
    ? cmItems.map((it, j) => {
      const pi = pairedIndex(it);
      const viaOv = ovItems ? (pi !== null && pi >= 0 && pi < ovItems.length ? ovSplit[pi] : (j < ovSplit.length ? ovSplit[j] : -1))
        : (pi !== null && pi < splits.length ? pi : (j < splits.length ? j : -1));
      return viaOv === undefined ? -1 : viaOv;
    })
    : [];
  // Post of each query: its post_index, else its pairedItem, else (one post) post 0.
  const splitPost = splits.map((s, k) => {
    const pi = s && s.json && typeof s.json === 'object' ? s.json.post_index : undefined;
    if (Number.isInteger(pi) && pi >= 0 && (!posts.length || pi < posts.length)) return pi;
    const pp = pairedIndex(s);
    if (pp !== null && pp >= 0 && (!posts.length || pp < posts.length)) return pp;
    return posts.length <= 1 ? 0 : -1;
  });
  return { ovSplit, cmSplit, splitPost };
}
let al = null;
try { al = alignment(); } catch (e) { al = null; }
// pairedItem of post p: every search item of its queries (they all trace back to post p upstream). A post without
// queries has no input item to point at.
function inputsOf(p) {
  try {
    if (!al) return [];
    const ks = new Set(al.splitPost.map((pp, k) => (pp === p ? k : -1)).filter(k => k >= 0));
    if (!cmItems) return [...ks];
    return al.cmSplit.map((sk, i) => (ks.has(sk) ? i : -1)).filter(i => i >= 0);
  } catch (e) { return []; }
}
const postBrandsOf = pj => (Array.isArray(pj.watches) ? pj.watches : []).map(w => (w && typeof w.brand === 'string' ? w.brand : '')).filter(Boolean);

const out = [];
try {
  if (!al) throw new Error('could not match the search responses to their queries');
  const { ovSplit, cmSplit, splitPost } = al;
  const nPosts = Math.max(posts.length, ...splitPost.map(p => p + 1), 0);
  const byPost = Array.from({ length: nPosts }, () => []);
  splits.forEach((s, k) => {
    const p = splitPost[k];
    if (p < 0 || p >= nPosts) return;
    const j = s && s.json && typeof s.json === 'object' ? s.json : {};
    const postQueries = posts[p] && posts[p].json && Array.isArray(posts[p].json.image_queries) ? posts[p].json.image_queries : [];
    const rank = Number.isInteger(j.rank) ? j.rank : k;
    const base = postQueries[rank] && typeof postQueries[rank] === 'object' ? postQueries[rank] : {};
    const pick = f => (typeof j[f] === 'string' ? j[f] : str(base[f]));
    const query = {
      rank, q: pick('q'), level: pick('level') || 'generic', brand: pick('brand'), model_family: pick('model_family'),
      model: pick('model'), reference: pick('reference'),
      watch_index: Number.isInteger(j.watch_index) ? j.watch_index : (Number.isInteger(base.watch_index) ? base.watch_index : -1),
    };
    byPost[p].push({
      query,
      openverse: ovItems ? ovItems.filter((_, i) => ovSplit[i] === k) : null,
      commons: cmItems ? cmItems.filter((_, i) => cmSplit[i] === k) : null,
    });
  });

  for (let p = 0; p < nPosts; p++) {
    const pj = posts[p] && posts[p].json && typeof posts[p].json === 'object' ? posts[p].json : {};
    const entries = byPost[p].sort((a, b) => a.query.rank - b.query.rank);
    let result;
    try {
      result = pickForPost(entries, recentSet(), postBrandsOf(pj));
      if (result.chosen) remember(result.chosen);
    } catch (e) {
      result = { image: null, image_error: 'pick photo failed: ' + plain(e && e.message ? e.message : String(e), 200), alternates: [], search_log: [] };
    }
    out.push({
      json: {
        source: pj.source === undefined ? null : pj.source,
        post_title: typeof pj.post_title === 'string' ? pj.post_title : '',
        watches: Array.isArray(pj.watches) ? pj.watches : [],
        image_queries: Array.isArray(pj.image_queries) ? pj.image_queries : [],
        image: result.image, image_error: result.image_error, alternates: result.alternates, search_log: result.search_log,
      },
      pairedItem: inputsOf(p).map(i => ({ item: i })),
    });
  }
} catch (e) {
  out.length = 0;
  posts.forEach((it, p) => {
    const pj = it && it.json && typeof it.json === 'object' ? it.json : {};
    out.push({
      json: {
        source: pj.source === undefined ? null : pj.source, post_title: typeof pj.post_title === 'string' ? pj.post_title : '',
        watches: Array.isArray(pj.watches) ? pj.watches : [], image_queries: Array.isArray(pj.image_queries) ? pj.image_queries : [],
        image: null, image_error: 'pick photo failed: ' + plain(e && e.message ? e.message : String(e), 200), alternates: [], search_log: [],
      },
      pairedItem: inputsOf(p).map(i => ({ item: i })),
    });
  });
}
return out;
