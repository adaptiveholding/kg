// Image finder, step 2a: turn the incoming post item into {post_title, post_text, source}.
// The incoming item.json is passed through unchanged as `source` so it can be restored later.
// Leave the paths '' to auto-detect, or set dot paths (for example 'post.title', 'data.0.content').
const TITLE_PATH = '';
const BODY_PATH = '';
const MAX_CHARS = 15000;

const TITLE_KEYS = ['title', 'post_title', 'headline', 'seo_title'];
const SKIP_KEYS = new Set(['slug', 'status', 'id', 'url', 'link', 'guid', 'date', 'type']);
const MAX_DEPTH = 6;
const MIN_BODY = 200;

const isObj = v => v !== null && typeof v === 'object';

// Strings that hold JSON (optionally in ``` fences after a short preamble) are parsed so we can search inside them.
function asJson(s) {
  if (typeof s !== 'string') return undefined;
  const fenced = s.match(/```[a-z]*\s*([\s\S]*?)(?:```|$)/i);
  const t = (fenced && fenced.index < 200 ? fenced[1] : s).trim();
  if (!/^[[{]/.test(t)) return undefined;
  try { const v = JSON.parse(t); return isObj(v) ? v : undefined; } catch (e) { return undefined; }
}

function getPath(obj, path) {
  let v = obj;
  for (const k of path.split('.').filter(Boolean)) {
    if (typeof v === 'string') v = asJson(v);
    if (!isObj(v)) return undefined;
    v = v[k];
  }
  return v;
}

// Breadth-first walk, so shallow matches win over deep ones.
function bfs(root, visit) {
  let level = [root];
  for (let d = 0; d <= MAX_DEPTH && level.length; d++) {
    const next = [];
    for (let v of level) {
      if (typeof v === 'string') v = asJson(v);
      if (!isObj(v)) continue;
      const hit = visit(v);
      if (hit !== undefined) return hit;
      for (const [k, c] of Object.entries(v)) if (!SKIP_KEYS.has(k) && (isObj(c) || typeof c === 'string')) next.push(c);
    }
    level = next;
  }
  return undefined;
}

function titleOf(v) {
  if (typeof v === 'string' && v.trim()) return v;
  if (isObj(v) && typeof v.rendered === 'string' && v.rendered.trim()) return v.rendered;
  if (isObj(v) && typeof v.raw === 'string' && v.raw.trim()) return v.raw;
  return undefined;
}

function findTitle(root) {
  return bfs(root, o => {
    const keys = Object.keys(o);
    for (const want of TITLE_KEYS) {
      const k = keys.find(x => x.toLowerCase() === want);
      const t = k === undefined ? undefined : titleOf(o[k]);
      if (t !== undefined) return t;
    }
    return undefined;
  });
}

// The writer's structured post: {summary, takeaway, glance[], sections[{heading, paragraphs[]}], table, closing}.
function isWriterPost(o) {
  const secs = Array.isArray(o.sections) && o.sections.some(s => isObj(s) && (s.heading || Array.isArray(s.paragraphs)));
  return secs || (typeof o.summary === 'string' && typeof o.takeaway === 'string');
}

function writerText(p) {
  const out = [p.summary, p.takeaway];
  for (const g of Array.isArray(p.glance) ? p.glance : []) if (isObj(g)) out.push(`${g.label ?? ''}: ${g.value ?? ''}`);
  for (const s of Array.isArray(p.sections) ? p.sections : []) {
    if (!isObj(s)) continue;
    out.push(s.heading);
    if (Array.isArray(s.paragraphs)) out.push(...s.paragraphs);
  }
  const t = isObj(p.table) ? p.table : null;
  if (t) {
    out.push(t.caption);
    if (Array.isArray(t.headers)) out.push(t.headers.join(' | '));
    for (const r of Array.isArray(t.rows) ? t.rows : []) if (Array.isArray(r)) out.push(r.join(' | '));
  }
  out.push(p.closing);
  return out.filter(x => typeof x === 'string' && x.trim()).join('\n');
}

function collectStrings(v, out, depth) {
  if (depth > MAX_DEPTH) return out;
  if (typeof v === 'string') {
    const parsed = asJson(v);
    if (parsed) return collectStrings(parsed, out, depth + 1);
    if (v.trim() && !/^https?:\/\/\S+$/.test(v.trim())) out.push(v);
  } else if (Array.isArray(v)) {
    for (const c of v) collectStrings(c, out, depth + 1);
  } else if (isObj(v)) {
    for (const [k, c] of Object.entries(v)) if (!SKIP_KEYS.has(k)) collectStrings(c, out, depth + 1);
  }
  return out;
}

function findBody(root) {
  const post = bfs(root, o => (isWriterPost(o) ? o : undefined));
  if (post) return writerText(post);
  const all = collectStrings(root, [], 0);
  const longest = all.reduce((a, b) => (b.length > a.length ? b : a), '');
  return longest.length >= MIN_BODY ? longest : all.join('\n');
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '',
  rsquo: '\u2019', lsquo: '\u2018', ldquo: '\u201C', rdquo: '\u201D', sbquo: '\u201A', bdquo: '\u201E',
  ndash: '\u2013', mdash: '\u2014', hellip: '\u2026', bull: '\u2022', middot: '\u00B7',
  laquo: '\u00AB', raquo: '\u00BB', times: '\u00D7', deg: '\u00B0', trade: '\u2122', reg: '\u00AE', copy: '\u00A9',
  euro: '\u20AC', pound: '\u00A3', yen: '\u00A5', cent: '\u00A2',
  eacute: '\u00E9', Eacute: '\u00C9', egrave: '\u00E8', ecirc: '\u00EA', euml: '\u00EB', aacute: '\u00E1', agrave: '\u00E0',
  acirc: '\u00E2', auml: '\u00E4', Auml: '\u00C4', aring: '\u00E5', ccedil: '\u00E7', iacute: '\u00ED', iuml: '\u00EF',
  ntilde: '\u00F1', oacute: '\u00F3', ocirc: '\u00F4', ouml: '\u00F6', Ouml: '\u00D6', oslash: '\u00F8',
  uacute: '\u00FA', ucirc: '\u00FB', uuml: '\u00FC', Uuml: '\u00DC', szlig: '\u00DF',
};

// Single pass, so '&amp;lt;' becomes '&lt;' and not '<'.
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    const v = ENTITIES[e] ?? ENTITIES[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

const BLOCK_TAGS = 'p|div|h[1-6]|li|ul|ol|dl|dt|dd|tr|table|thead|tbody|tfoot|caption|figure|figcaption|blockquote|section|article|header|footer|aside|nav|main|pre|br|hr';

// Tag bodies exclude '<', so a stray '<' cannot make a match run on (and the scan stays linear).
// Markdown URLs may hold one level of parentheses, as in wiki/Rolex_(brand).
function toPlainText(s) {
  const text = String(s)
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/!\[[^\]]*\]\((?:[^()]|\([^()]*\))*\)/g, ' ')
    .replace(/\[([^\]]+)\]\((?:[^()\s]|\([^()\s]*\))*\)/g, '$1')
    .replace(/(<\/[a-z][a-z0-9]*\s*>)(?=<[a-z])/gi, '$1 ') // "<b>Rolex</b><i>Omega</i>" keeps two words
    .replace(new RegExp(`</?(?:${BLOCK_TAGS})\\b[^<>]*>`, 'gi'), '\n')
    .replace(/<\/?(?:td|th)\b[^<>]*>/gi, ' ')
    .replace(/<[a-z!/?][^<>]*>/gi, '');
  return decodeEntities(text)
    .replace(/[\u00AD\u200C\u200D\u2060\uFEFF]/g, '') // soft hyphen and other invisible joiners
    .replace(/[ \t\f\v\u00A0\u200B]+/g, ' ')
    .replace(/ *\n\s*/g, '\n')
    .trim();
}

function truncate(s) {
  if (s.length <= MAX_CHARS) return s;
  const cut = s.slice(0, MAX_CHARS);
  const sp = cut.lastIndexOf(' ');
  return (sp > MAX_CHARS - 200 ? cut.slice(0, sp) : cut).trim();
}

function prep(json) {
  let title;
  let body;
  if (TITLE_PATH) title = titleOf(getPath(json, TITLE_PATH));
  if (BODY_PATH) {
    const b = getPath(json, BODY_PATH);
    if (typeof b === 'string' && !asJson(b)) body = b;
    else if (b !== undefined) body = findBody(b) || undefined;
  }
  // Fast path: the "Render WP blocks" output shape (an empty content falls back to auto-detection).
  if (typeof json.title === 'string' && typeof json.content === 'string') {
    if (title === undefined) title = json.title;
    if (body === undefined && toPlainText(json.content)) body = json.content;
  }
  if (title === undefined) title = findTitle(json);
  if (body === undefined) body = findBody(json);
  return {
    post_title: title ? toPlainText(title).replace(/\s+/g, ' ') : '',
    post_text: body ? truncate(toPlainText(body)) : '',
  };
}

return $input.all().map((item, i) => {
  const source = item && item.json;
  let out = { post_title: '', post_text: '' };
  try {
    if (isObj(source)) out = prep(source);
  } catch (e) {
    // Never fail the workflow over this: downstream treats empty text as "no watches found".
  }
  return { json: { ...out, source }, pairedItem: { item: i } };
});
