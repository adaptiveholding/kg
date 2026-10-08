import test from 'node:test';
import assert from 'node:assert/strict';
import { runPrep, PREP_CODE, setConst, clone } from './harness.mjs';
import { renderedPosts } from '../fixtures/generate.mjs';
import { WRITER_POSTS } from '../fixtures/writer-posts.mjs';

const R = await renderedPosts();
const prepOne = async (json, code) => (await runPrep([json], code))[0].json;

test('Render WP blocks output: title fast path, source passed through, input not mutated', async () => {
  const input = clone(R.steel);
  const out = await runPrep([input]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].pairedItem, { item: 0 });
  assert.deepEqual(Object.keys(out[0].json).sort(), ['post_text', 'post_title', 'source']);
  assert.equal(out[0].json.post_title, R.steel.title);
  assert.deepEqual(out[0].json.source, R.steel);
  assert.deepEqual(input, R.steel, 'input item must not be mutated');
});

test('Render WP blocks output: block comments and tags are gone, text survives', async () => {
  for (const [name, json] of Object.entries(R)) {
    const { post_text } = await prepOne(json);
    assert.ok(post_text.length > 300, name);
    assert.doesNotMatch(post_text, /<!--|wp:|-->/, name);
    assert.doesNotMatch(post_text, /<\/?[a-z][^>]*>/i, name);
    assert.ok(post_text.includes(WRITER_POSTS[name].post.summary), `${name}: summary verbatim`);
    assert.ok(post_text.includes(WRITER_POSTS[name].post.closing), `${name}: closing verbatim`);
  }
});

test('Render WP blocks output: entities decoded', async () => {
  const steel = (await prepOne(R.steel)).post_text;
  const dress = (await prepOne(R.dress)).post_text;
  assert.match(steel, /box & papers/);
  assert.match(steel, /rank > 4 omitted/);
  assert.match(dress, /A\. Lange & S\u00F6hne/);
  assert.doesNotMatch(steel + dress, /&(amp|lt|gt|quot|#\d+);/);
});

test('Render WP blocks output: table cells, columns and blocks are not glued together', async () => {
  const t = (await prepOne(R.steel)).post_text;
  assert.match(t, /\bSubmariner Date\s+Rolex\s+Leading\b/);
  assert.match(t, /\bLeading\s+2\s+Royal Oak\b/);
  assert.match(t, /\bActivity\s+Busy\b/);
  assert.match(t, /\bSteady\s+Most mentioned\b|\bBusy\s+Most mentioned\b/);
  assert.match(t, /spotlight\s+Several posts/);
  assert.match(t, /Key takeaway: Steel sports/, 'inline <strong> must not add a break');
  for (const glued of ['DateRolex', 'RolexLeading', 'ActivityBusy', 'BusyMost', 'spotlightSeveral', 'MentionsRank', 'Mentions1']) {
    assert.ok(!t.includes(glued), glued);
  }
});

test('Render WP blocks output: disclaimer is kept as plain text and names no watch', async () => {
  const t = (await prepOne(R.quiet)).post_text;
  assert.match(t, /It is not an appraisal, price quote or financial advice\.$/);
  assert.match(t, /Based on activity from October 7 to October 8, 2026\./);
});

test('several items in one run keep their order, pairing and sources', async () => {
  const items = [R.steel, R.dress, R.quiet];
  const out = await runPrep(items);
  assert.deepEqual(out.map(o => o.pairedItem.item), [0, 1, 2]);
  assert.deepEqual(out.map(o => o.json.post_title), items.map(i => i.title));
  assert.deepEqual(out.map(o => o.json.source), items);
});

const LONG = 'Traders discussed the Rolex Submariner and the Omega Speedmaster at length this week. '.repeat(4);

const SHAPES = [
  {
    name: 'plain string under an unknown key',
    json: { data: LONG },
    title: '',
    has: ['Rolex Submariner', 'Omega Speedmaster'],
  },
  {
    name: 'JSON inside ```json fences',
    json: { text: '```json\n' + JSON.stringify({ title: 'Fenced title', content: `<p>${LONG}</p>` }) + '\n```' },
    title: 'Fenced title',
    has: ['Rolex Submariner'],
    not: ['<p>', 'Fenced title'],
  },
  {
    name: 'nested output.content',
    json: { output: { title: 'Nested title', status: 'draft', content: `<!-- wp:paragraph --><p>${LONG}</p><!-- /wp:paragraph -->` } },
    title: 'Nested title',
    has: ['Omega Speedmaster'],
    not: ['wp:', 'draft'],
  },
  {
    name: 'WordPress REST post {title:{rendered}}',
    json: {
      id: 42, link: 'https://watchcentro.com/?p=42', status: 'draft',
      title: { rendered: 'Rolex &#8211; Submariner &amp; GMT', raw: 'Rolex - Submariner & GMT' },
      content: { rendered: `<p>${LONG}</p>`, protected: false },
    },
    title: 'Rolex \u2013 Submariner & GMT',
    has: ['Omega Speedmaster'],
    not: ['watchcentro.com'],
  },
  {
    name: 'writer post JSON (Parse review + code checks output)',
    json: { ok: true, stage: 'reviewer', reason: '', post: WRITER_POSTS.steel.post, word_count: 300, run_date: '2026-10-07' },
    title: WRITER_POSTS.steel.post.title,
    has: [WRITER_POSTS.steel.post.summary, 'The Submariner Date holds the spotlight', 'Submariner Date | Rolex | Leading', 'Activity: Busy', WRITER_POSTS.steel.post.closing],
    not: [WRITER_POSTS.steel.post.slug, 'reviewer'],
  },
  {
    name: 'raw writer LLM text (JSON string in $json.text)',
    json: { text: 'Here you go:\n```json\n' + JSON.stringify(WRITER_POSTS.dress.post) + '\n```' },
    title: WRITER_POSTS.dress.post.title,
    has: ['GS Snowflake', 'Nautilus 5711/1A | Patek Philippe | Lower'],
  },
  {
    name: 'only short strings are joined, headline key is the title',
    json: { headline: 'Omega news', a: 'Speedmaster sold', b: { c: ['Rolex Daytona'] } },
    title: 'Omega news',
    has: ['Speedmaster sold', 'Rolex Daytona'],
  },
  {
    name: 'title keys are case-insensitive, title beats seo_title',
    json: { SEO_Title: 'SEO', Title: 'Main title', Body: LONG },
    title: 'Main title',
    has: ['Rolex Submariner'],
  },
  {
    name: 'markdown body: links keep text, images dropped',
    json: { title: 'Md', markdown: `![hero](https://x.test/a.jpg) Read about the [Tudor Black Bay](https://x.test/bb) today. ${LONG}` },
    title: 'Md',
    has: ['Read about the Tudor Black Bay today.'],
    not: ['hero', 'https://', '](', '!['],
  },
];

for (const s of SHAPES) {
  test(`other input shapes: ${s.name}`, async () => {
    const out = await prepOne(s.json);
    assert.equal(out.post_title, s.title);
    for (const h of s.has || []) assert.ok(out.post_text.includes(h), `missing ${JSON.stringify(h)} in ${JSON.stringify(out.post_text.slice(0, 300))}`);
    for (const n of s.not || []) assert.ok(!out.post_text.includes(n), `unexpected ${JSON.stringify(n)}`);
    assert.deepEqual(out.source, s.json);
  });
}

const CLEANING = [
  ['<p>Rolex</p><p>Omega</p>', 'Rolex\nOmega'],
  ['<table><tr><td>Rolex</td><td>Omega</td></tr><tr><th>Tudor</th></tr></table>', 'Rolex Omega\nTudor'],
  ['Line<br/>break<hr>rule', 'Line\nbreak\nrule'],
  ['<script>var rolex = 1;</script><style>p{color:red}</style><p>Kept</p>', 'Kept'],
  ['<!-- wp:paragraph {"a":1} --><p>A <strong>bold</strong> <em>word</em></p><!-- /wp:paragraph -->', 'A bold word'],
  ['Tom&rsquo;s &lsquo;x&rsquo; &ldquo;y&rdquo; a&ndash;b a&mdash;b wait&hellip; caf&eacute;', 'Tom\u2019s \u2018x\u2019 \u201Cy\u201D a\u2013b a\u2014b wait\u2026 caf\u00E9'],
  ['&#8217; &#x2019; &#X41; &#39;', '\u2019 \u2019 A \''],
  ['a&nbsp;&nbsp;b', 'a b'],
  ['&amp;lt;p&amp;gt; stays text', '&lt;p&gt; stays text'],
  ['&lt;b&gt;not a tag&lt;/b&gt;', '<b>not a tag</b>'],
  ['&bogus; &#0; &#xFFFFFFF;', '&bogus; &#0; &#xFFFFFFF;'],
  ['prices < $10k and > $5k', 'prices < $10k and > $5k'],
  ['  lots   of \t space \n\n\n and lines  ', 'lots of space\nand lines'],
  ['<strong>Rolex</strong><em>Omega</em> and <a href="/x">Tudor</a>.', 'Rolex Omega and Tudor.'],
  ['Ro\u00ADlex Sub\u200Dmariner Day&shy;tona Ex&#173;plorer\uFEFF', 'Rolex Submariner Daytona Explorer'],
  ['See [Rolex](https://en.wikipedia.org/wiki/Rolex_(brand)) and ![x](https://a.test/b_(c).jpg "t") done', 'See Rolex and done'],
  ['a <b c < d > e', 'a <b c < d > e'],
];

test('HTML and markdown cleaning (table-driven)', async () => {
  for (const [html, expected] of CLEANING) {
    const out = await prepOne({ title: 'T', content: html });
    assert.equal(out.post_text, expected, html);
  }
});

test('Render WP blocks shape with empty content falls back to the other strings', async () => {
  const out = await prepOne({ title: 'Rolex week', content: '<!-- wp:paragraph --><p></p><!-- /wp:paragraph -->', excerpt: 'The Submariner Date led trading.' });
  assert.equal(out.post_title, 'Rolex week');
  assert.ok(out.post_text.includes('The Submariner Date led trading.'), out.post_text);
});

test('an unclosed tag run does not make cleaning slow', async () => {
  const t = Date.now();
  await prepOne({ title: 'T', content: '<a'.repeat(40000) });
  await prepOne({ title: 'T', content: '<p'.repeat(40000) });
  assert.ok(Date.now() - t < 500, `${Date.now() - t} ms`);
});

test('title is cleaned too', async () => {
  const out = await prepOne({ title: '<b>Rolex</b> &amp; Omega\n  report', content: 'x' });
  assert.equal(out.post_title, 'Rolex & Omega report');
});

test('TITLE_PATH / BODY_PATH overrides beat auto-detection and the fast path', async () => {
  const code = setConst(setConst(PREP_CODE, 'TITLE_PATH', "'meta.name'"), 'BODY_PATH', "'payload.0.html'");
  const out = await prepOne({
    title: 'Decoy title', content: '<p>Decoy body</p>',
    meta: { name: 'Real title' }, payload: [{ html: '<p>Real body about the Cartier Santos</p>' }],
  }, code);
  assert.equal(out.post_title, 'Real title');
  assert.equal(out.post_text, 'Real body about the Cartier Santos');
});

test('BODY_PATH may point at an object or a JSON string; it is searched inside', async () => {
  const code = setConst(PREP_CODE, 'BODY_PATH', "'result'");
  const asObject = await prepOne({ result: { post: WRITER_POSTS.quiet.post } }, code);
  const asString = await prepOne({ result: JSON.stringify({ post: WRITER_POSTS.quiet.post }) }, code);
  assert.ok(asObject.post_text.includes('Payment safety'));
  assert.equal(asString.post_text, asObject.post_text);
});

test('override paths that do not resolve fall back to auto-detection', async () => {
  const code = setConst(setConst(PREP_CODE, 'TITLE_PATH', "'nope.title'"), 'BODY_PATH', "'nope.body'");
  const out = await prepOne(R.dress, code);
  assert.equal(out.post_title, R.dress.title);
  assert.ok(out.post_text.includes('JLC Reverso Tribute'));
});

const GARBAGE = [
  {},
  { title: 42, content: null },
  { content: { rendered: '' } },
  { a: [[[[[[[[[['too deep to matter']]]]]]]]]] },
  { text: '```json\n{not json\n```' },
  { text: '{"title": ' },
  { list: [null, 1, true, {}] },
  { url: 'https://example.com/only-a-link' },
];

test('empty or garbage input gives empty strings and never throws', async () => {
  const out = await runPrep(GARBAGE);
  assert.equal(out.length, GARBAGE.length);
  out.forEach((o, i) => {
    assert.equal(typeof o.json.post_title, 'string');
    assert.equal(typeof o.json.post_text, 'string');
    assert.deepEqual(o.json.source, GARBAGE[i]);
    assert.deepEqual(o.pairedItem, { item: i });
  });
  assert.deepEqual(out.slice(0, 4).map(o => o.json.post_text), ['', '', '', '']);
  assert.equal(out[7].json.post_text, '');
});

test('item without a json object and very deep nesting do not throw', async () => {
  let deep = { text: 'bottom' };
  for (let i = 0; i < 2000; i++) deep = { child: deep };
  const out = await runPrep([null, deep]);
  assert.deepEqual(out[0].json, { post_title: '', post_text: '', source: null });
  assert.equal(out[1].json.post_text, '');
});

test('post_text is truncated to MAX_CHARS', async () => {
  const word = 'Submariner ';
  const out = await prepOne({ title: 'Long', content: `<p>${word.repeat(3000)}</p>` });
  assert.ok(out.post_text.length <= 15000, String(out.post_text.length));
  assert.ok(out.post_text.length > 14800, String(out.post_text.length));
  assert.ok(out.post_text.endsWith('Submariner'), 'cut on a word boundary');
  const small = setConst(PREP_CODE, 'MAX_CHARS', '50');
  assert.ok((await prepOne({ title: 'Long', content: word.repeat(100) }, small)).post_text.length <= 50);
});
