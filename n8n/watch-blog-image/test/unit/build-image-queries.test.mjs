import test from 'node:test';
import assert from 'node:assert/strict';
import { runPrep, runBuild, llmText, BUILD_CODE, PREP_NODE, setConst } from './harness.mjs';
import { renderedPosts } from '../fixtures/generate.mjs';

const R = await renderedPosts();
const GENERIC = { q: 'luxury wristwatch', level: 'generic', brand: '', model_family: '', model: '', reference: '', prominence: '', watch_index: -1 };
const prepItem = (post_text, post_title = 'Test post', source = { title: post_title }) => ({ post_title, post_text, source });
const buildOne = async (llmJson, prep) => (await runBuild([llmJson], prep))[0].json;
const qs = out => out.image_queries.map(q => q.q);

const SUB = { brand: 'Rolex', model_family: 'Submariner', model: 'Submariner Date', reference: '126610LN', mentioned_as: 'Submariner Date 126610LN', prominence: 'primary' };
const SUB_JSON = JSON.stringify({ watches: [SUB] });
const SUB_TEXT = 'Traders liked the Rolex Submariner Date 126610LN this week.';

const PARSE_CASES = [
  ['plain JSON in text', { text: SUB_JSON }],
  ['```json fences', { text: '```json\n' + SUB_JSON + '\n```' }],
  ['bare ``` fences', { text: '```\n' + SUB_JSON + '\n```' }],
  ['leading prose', { text: 'Here is the JSON you asked for:\n' + SUB_JSON }],
  ['trailing prose', { text: SUB_JSON + '\n\nLet me know if you need anything else.' }],
  ['pretty-printed with prose both sides', { text: 'Sure.\n```json\n' + JSON.stringify({ watches: [SUB] }, null, 2) + '\n```\nDone.' }],
  ['output key instead of text', { output: SUB_JSON }],
  ['already-parsed object in text', { text: { watches: [SUB] } }],
  ['already-parsed object as the item itself', { watches: [SUB] }],
  ['note with braces after the JSON', { text: SUB_JSON + '\n\nNote: I skipped Chrono24 {a marketplace}.' }],
  ['prose with braces before the JSON', { text: 'Here is the list {as requested}:\n' + SUB_JSON }],
  ['fenced JSON, then a parenthetical with braces', { text: 'Sure:\n```json\n' + SUB_JSON + '\n```\n(If you need {more}, ask.)' }],
  ['two JSON objects (the first wins)', { text: SUB_JSON + '\n' + JSON.stringify({ watches: [] }) }],
  ['a bare top-level array of watches', { text: JSON.stringify([SUB]) }],
  ['a trailing comma', { text: SUB_JSON.replace(']}', ',]}') }],
  ['watches nested one level down', { text: JSON.stringify({ result: { watches: [SUB] } }) }],
];

for (const [name, llm] of PARSE_CASES) {
  test(`parses LLM output: ${name}`, async () => {
    const out = await buildOne(llm, [prepItem(SUB_TEXT)]);
    assert.equal(out.extract_error, '');
    assert.deepEqual(out.watches, [SUB]);
    assert.deepEqual(qs(out), ['Rolex Submariner Date', 'Rolex Submariner', 'Rolex watch', 'luxury wristwatch']);
  });
}

const ERROR_CASES = [
  ['chainLlm continueOnFail item {error: string}', { error: 'Bad request - please check your parameters' }, /^LLM error: Bad request/],
  ['error object with message', { error: { message: 'rate limited', code: 429 } }, /^LLM error: rate limited/],
  ['error object without message', { error: { code: 500 } }, /^LLM error: .*500/],
  ['node failed and n8n passed its input through', prepItem('text'), /no text.*post_title/],
  ['empty item', {}, /no text/],
  ['empty text', { text: '' }, /no text/],
  ['prose only', { text: 'Sorry, I cannot find any watches in this post.' }, /not return valid JSON/],
  ['truncated JSON', { text: '{"watches": [{"brand": "Rolex", "mod' }, /not return valid JSON/],
  ['watches is not an array', { text: '{"watches": "none"}' }, /no "watches" array/],
  ['wrong top-level key', { text: '{"items": []}' }, /no "watches" array/],
  ['null json', null, /empty/],
];

for (const [name, llm, re] of ERROR_CASES) {
  test(`unusable LLM output gives generic query + extract_error: ${name}`, async () => {
    const out = await buildOne(llm, [prepItem(SUB_TEXT, 'T', { id: 7 })]);
    assert.match(out.extract_error, re);
    assert.deepEqual(out.watches, []);
    assert.deepEqual(out.image_queries, [GENERIC]);
    assert.equal(out.dropped_queries, 0);
    assert.deepEqual(out.source, { id: 7 }, 'source still carried through');
  });
}

test('damaged or cut-off JSON: complete entries are kept and extract_error says so', async () => {
  const jumbo = '{"brand": "Audemars Piguet", "model_family": "Royal Oak", "model": "Royal Oak Jumbo", "reference": "", "mentioned_as": "the "Jumbo"", "prominence": "secondary"}';
  const text = SUB_TEXT + ' The AP Royal Oak Jumbo too.';
  const cases = [
    ['an unescaped quote in one entry', '{"watches": [' + JSON.stringify(SUB) + ', ' + jumbo + ']}'],
    ['cut off at max_tokens', '{"watches": [' + JSON.stringify(SUB) + ', {"brand": "Audemars Piguet", "model_family": "Roy'],
  ];
  for (const [name, reply] of cases) {
    const out = await buildOne({ text: reply }, [prepItem(text)]);
    assert.deepEqual(out.watches, [SUB], name);
    assert.equal(out.extract_error, 'LLM JSON was invalid or cut off; kept 1 complete watch entry', name);
    assert.equal(qs(out)[0], 'Rolex Submariner Date', name);
  }
});

test('valid empty list is not an error', async () => {
  const out = await buildOne({ text: '{"watches": []}' }, [prepItem('Quiet day.')]);
  assert.equal(out.extract_error, '');
  assert.deepEqual(out.image_queries, [GENERIC]);
});

// Listed deliberately out of order: passing, secondary, primary, primary.
const LADDER = [
  { brand: 'Omega', model_family: 'Speedmaster', model: 'Speedmaster Professional', reference: '', mentioned_as: 'Speedmaster Professional', prominence: 'passing' },
  { brand: 'Tudor', model_family: 'Black Bay', model: 'Black Bay 58', reference: '', mentioned_as: 'Tudor Black Bay 58', prominence: 'secondary' },
  SUB,
  { brand: 'Audemars Piguet', model_family: 'Royal Oak', model: 'Royal Oak', reference: '', mentioned_as: 'AP Royal Oak', prominence: 'primary' },
];
const FULL_LADDER = [
  ['Rolex Submariner Date', 'model'], ['Rolex Submariner', 'family'], ['Audemars Piguet Royal Oak', 'model'], // A
  ['Tudor Black Bay 58', 'model'], ['Tudor Black Bay', 'family'],                                           // B
  ['Rolex watch', 'brand'], ['Audemars Piguet watch', 'brand'],                                             // C
  ['Omega Speedmaster Professional', 'model'], ['Omega Speedmaster', 'family'],                              // D
  ['Tudor watch', 'brand'], ['Omega watch', 'brand'],                                                       // E
];

test('query ladder follows tiers A-E (MAX_QUERIES raised)', async () => {
  const code = setConst(BUILD_CODE, 'MAX_QUERIES', '50');
  const [{ json: out }] = await runBuild([llmText(LADDER)], [{ post_title: '', post_text: '', source: {} }], code);
  assert.deepEqual(out.image_queries.map(q => [q.q, q.level]), [...FULL_LADDER, ['luxury wristwatch', 'generic']]);
  assert.equal(out.dropped_queries, 0);
  assert.deepEqual(out.watches.map(w => w.brand), ['Rolex', 'Audemars Piguet', 'Tudor', 'Omega'], 'stable sort by prominence');
  const sub = out.image_queries[0];
  assert.deepEqual(sub, { q: 'Rolex Submariner Date', level: 'model', brand: 'Rolex', model_family: 'Submariner', model: 'Submariner Date', reference: '126610LN', prominence: 'primary', watch_index: 0 });
  assert.deepEqual(out.image_queries[5], { q: 'Rolex watch', level: 'brand', brand: 'Rolex', model_family: '', model: '', reference: '', prominence: 'primary', watch_index: 0 });
  // watch_index points into out.watches, so step 3 can map any query back to its watch.
  for (const q of out.image_queries.slice(0, -1)) assert.equal(out.watches[q.watch_index].brand, q.brand, q.q);
  assert.deepEqual(out.image_queries.filter(q => q.brand === 'Omega').map(q => [q.prominence, q.watch_index]), [['passing', 3], ['passing', 3], ['passing', 3]]);
});

test('MAX_QUERIES truncation counts dropped queries and the generic query is always last', async () => {
  const out = await buildOne(llmText(LADDER), [prepItem('')]);
  assert.deepEqual(qs(out), [...FULL_LADDER.slice(0, 6).map(([q]) => q), 'luxury wristwatch']);
  assert.equal(out.dropped_queries, FULL_LADDER.length - 6);
  assert.deepEqual(out.image_queries.at(-1), GENERIC);
});

test('duplicate watches collapse (more prominent wins) and queries are deduped', async () => {
  const w = [
    { brand: 'Rolex', model_family: 'Submariner', model: 'Submariner Date', prominence: 'passing', mentioned_as: 'sub' },
    { brand: 'ROLEX', model_family: 'Submariner', model: 'submariner-date', prominence: 'primary', mentioned_as: 'Submariner Date' },
    { brand: 'Rolex', model_family: 'Submariner', model: 'Submariner No Date', prominence: 'secondary', mentioned_as: 'no-date Sub' },
  ];
  const out = await buildOne(llmText(w), [prepItem('')]);
  assert.deepEqual(out.watches.map(x => [x.model, x.prominence]), [['submariner-date', 'primary'], ['Submariner No Date', 'secondary']]);
  assert.deepEqual(qs(out), ['ROLEX submariner-date', 'ROLEX Submariner', 'Rolex Submariner No Date', 'ROLEX watch', 'luxury wristwatch']);
});

test('leading brand name is stripped from model and model_family', async () => {
  const w = [
    { brand: 'Rolex', model_family: 'Rolex Submariner', model: 'Rolex Submariner Date', prominence: 'primary' },
    { brand: 'A. Lange & S\u00F6hne', model_family: 'A. Lange & Sohne Lange 1', model: '', prominence: 'secondary' },
    { brand: 'Grand Seiko', model_family: 'Grand-Seiko Heritage', model: 'Grand Seiko SBGA211 "Snowflake"', prominence: 'secondary' },
    { brand: 'Omega', model_family: 'Omega', model: 'Omega', prominence: 'passing' },
    { brand: 'Tudor', model_family: 'Black Bay', model: 'Tudorized Black Bay', prominence: 'passing' },
  ];
  const out = await buildOne(llmText(w), undefined);
  assert.deepEqual(out.watches.map(x => [x.model_family, x.model]), [
    ['Submariner', 'Submariner Date'],
    ['Lange 1', 'Lange 1'],
    ['Heritage', 'SBGA211 "Snowflake"'],
    ['', ''],
    ['Black Bay', 'Tudorized Black Bay'],
  ]);
  assert.ok(!qs(out).some(q => /Rolex Rolex|Omega Omega|Seiko Grand/.test(q)), qs(out).join(' | '));
});

test("empty model falls back to model_family; model equal to family gives one query", async () => {
  const w = [{ brand: 'Omega', model_family: 'Speedmaster', model: '', prominence: 'primary', mentioned_as: 'Speedy' }];
  const out = await buildOne(llmText(w), undefined);
  assert.equal(out.watches[0].model, 'Speedmaster');
  assert.deepEqual(out.image_queries.slice(0, 2).map(q => [q.q, q.level]), [['Omega Speedmaster', 'model'], ['Omega watch', 'brand']]);
});

test('brand-only entry yields a brand-level query', async () => {
  const out = await buildOne(llmText([{ brand: 'Cartier', prominence: 'primary', mentioned_as: 'Cartier' }]), [prepItem('Cartier had a good week.')]);
  assert.deepEqual(out.image_queries, [{ q: 'Cartier watch', level: 'brand', brand: 'Cartier', model_family: '', model: '', reference: '', prominence: 'primary', watch_index: 0 }, GENERIC]);
});

test('guard: hallucinated watch dropped, alias kept via mentioned_as (real Watch Centro post)', async () => {
  const [prep] = await runPrep([R.steel]);
  const w = [
    { brand: 'Audemars Piguet', model_family: 'Royal Oak', model: 'Royal Oak Jumbo', reference: '15202ST', mentioned_as: 'AP Royal Oak', prominence: 'primary' },
    { brand: 'Patek Philippe', model_family: 'Nautilus', model: 'Nautilus', reference: '5711/1A', mentioned_as: 'Nautilus', prominence: 'secondary' },
  ];
  const out = await buildOne(llmText(w), [prep.json]);
  assert.deepEqual(out.watches.map(x => x.brand), ['Audemars Piguet']);
  assert.equal(out.dropped_watches.length, 1);
  assert.equal(out.dropped_watches[0].brand, 'Patek Philippe');
  assert.equal(out.dropped_watches[0].reason, 'not found in post text');
});

test('guard: a model not in the post is kept as brand only when the brand is there (real Watch Centro post)', async () => {
  const [prep] = await runPrep([R.steel]);
  assert.doesNotMatch(prep.json.post_text, /daytona/i);
  const daytona = { brand: 'Rolex', model_family: 'Daytona', model: 'Cosmograph Daytona', reference: '116500LN', mentioned_as: 'Rolex', prominence: 'primary' };
  const out = await buildOne(llmText([daytona]), [prep.json]);
  assert.deepEqual(out.watches, [{ ...daytona, model_family: '', model: '', reference: '' }]);
  assert.deepEqual(out.dropped_watches, [{ ...daytona, reason: 'model not found in post text (kept brand only)' }]);
  assert.deepEqual(qs(out), ['Rolex watch', 'luxury wristwatch']);
});

test('guard: a copy of an old-style prompt example in a Rolex-only post becomes "Rolex watch"', async () => {
  const out = await buildOne(llmText([SUB]), [prepItem('Rolex prices stayed flat. Traders talked about shipping.')]);
  assert.deepEqual(qs(out), ['Rolex watch', 'luxury wristwatch']);
});

test('guard: filler-only mentioned_as and a one-digit reference are no evidence', async () => {
  const quiet = 'Rank 1 was shipping. Never send a deposit before you see the watch on a video call.';
  for (const extra of [{ mentioned_as: 'the watch' }, { reference: '1' }, { mentioned_as: 'a watch', reference: '12' }]) {
    const w = { brand: 'Breitling', model_family: 'Navitimer', model: 'Navitimer B01', prominence: 'primary', ...extra };
    const out = await buildOne(llmText([w]), [prepItem(quiet)]);
    assert.deepEqual(out.watches, [], JSON.stringify(extra));
    assert.equal(out.dropped_watches[0].reason, 'not found in post text');
  }
});

test('guard: nicknames in mentioned_as validate the model, with or without a leading article', async () => {
  const cases = [
    ['Speedy prices held firm this week.', { brand: 'Omega', model_family: 'Speedmaster', model: 'Speedmaster Professional', mentioned_as: 'the Speedy' }],
    ['The BB58 kept selling.', { brand: 'Tudor', model_family: 'Black Bay', model: 'Black Bay 58', mentioned_as: 'BB58' }],
    ['Pepsi demand cooled.', { brand: 'Rolex', model_family: 'GMT-Master II', model: 'GMT-Master II Pepsi', mentioned_as: 'Pepsi' }],
    ['Talk of the 126610LN continued.', { brand: 'Rolex', model_family: 'Submariner', model: 'Submariner Date', reference: '126610LN', mentioned_as: '' }],
  ];
  for (const [text, w] of cases) {
    const out = await buildOne(llmText([{ ...w, prominence: 'primary' }]), [prepItem(text)]);
    assert.deepEqual(out.dropped_watches, [], text);
    assert.equal(out.watches[0].model, w.model, text);
  }
});

test('guard: mentioned_as that is only a brand short name validates the brand, not the model', async () => {
  const w = { brand: 'Audemars Piguet', model_family: 'Royal Oak', model: 'Royal Oak Offshore', mentioned_as: 'AP', prominence: 'primary' };
  const out = await buildOne(llmText([w]), [prepItem('AP prices dipped a little.')]);
  assert.deepEqual(qs(out), ['Audemars Piguet watch', 'luxury wristwatch']);
  assert.match(out.dropped_watches[0].reason, /kept brand only/);
});

test('guard: alias only in the text, brand name never written out', async () => {
  const text = 'Traders liked the AP Royal Oak this week.';
  const w = [{ brand: 'Audemars Piguet', model_family: '', model: '', mentioned_as: 'AP', prominence: 'primary' }];
  assert.equal((await buildOne(llmText(w), [prepItem(text)])).watches.length, 1);
});

test("guard is word-bounded: 'AP' does not match inside 'cheap'", async () => {
  const [prep] = await runPrep([R.quiet]);
  assert.match(prep.json.post_text, /cheap/);
  const w = [{ brand: 'Audemars Piguet', model_family: '', model: '', reference: '', mentioned_as: 'AP', prominence: 'primary' }];
  const out = await buildOne(llmText(w), [prep.json]);
  assert.deepEqual(out.watches, []);
  assert.equal(out.dropped_watches[0].reason, 'not found in post text');
  assert.deepEqual(out.image_queries, [GENERIC]);
});

test('guard ignores diacritics, case and punctuation', async () => {
  const cases = [
    ['Talk about the A. Lange & Sohne Lange 1 continued.', { brand: 'A. Lange & S\u00F6hne', model_family: 'Lange 1', mentioned_as: 'Lange & S\u00F6hne' }],
    ['Talk about the A. LANGE & SO\u0308HNE continued.', { brand: 'A. Lange & S\u00F6hne', model_family: '', mentioned_as: '' }],
    ['The 5711-1A came up.', { brand: 'Patek Philippe', model_family: 'Nautilus', reference: '5711/1A', mentioned_as: 'Patek' }],
    ['Montblanc 1858 Geosph\u00E8re', { brand: 'Montblanc', model_family: '1858', mentioned_as: 'Montblanc 1858 Geosphere' }],
  ];
  for (const [text, w] of cases) {
    const out = await buildOne(llmText([{ ...w, prominence: 'primary' }]), [prepItem(text)]);
    assert.equal(out.watches.length, 1, text);
  }
});

test('guard also checks the post title', async () => {
  const out = await buildOne(llmText([{ brand: 'Cartier', model_family: 'Santos', prominence: 'primary' }]), [prepItem('No names in the body.', 'Cartier Santos week')]);
  assert.equal(out.watches.length, 1);
});

test('denylisted marketplaces and platforms are dropped (real Watch Centro posts)', async () => {
  const [steel, dress] = await runPrep([R.steel, R.dress]);
  const w = [
    { brand: 'Chrono24', model_family: '', model: '', mentioned_as: 'Chrono24', prominence: 'secondary' },
    { brand: 'eBay', mentioned_as: 'eBay', prominence: 'passing' },
    { brand: 'Christie\u2019s', prominence: 'passing' },
    { brand: "Bob's Watches", prominence: 'passing' },
    { brand: 'chrono24.com', prominence: 'passing' },
    { brand: 'Rolex', model_family: 'Submariner', mentioned_as: 'Submariner Date', prominence: 'primary' },
  ];
  const out = await runBuild([llmText(w), llmText(w)], [steel.json, dress.json]);
  const [a, b] = out.map(o => o.json);
  assert.deepEqual(a.watches.map(x => x.brand), ['Rolex']);
  assert.deepEqual(a.dropped_watches.map(x => x.brand), ['Chrono24', 'eBay', 'Christie\u2019s', "Bob's Watches", 'chrono24.com']);
  assert.ok(a.dropped_watches.every(x => /denylist/.test(x.reason)));
  assert.ok(!qs(a).some(q => /chrono24|ebay/i.test(q)));
  assert.deepEqual(b.watches, [], 'the dress post never mentions a Submariner');
});

test('denylist matches spelling variants but not real brands', async () => {
  const denied = ['Chrono 24', 'Christies', 'Sothebys', 'chrono24.com', 'WatchRecon', 'r/Watchexchange', 'Swiss Watch Expo', 'Bezel app'];
  const real = ['Rolex', 'Ebel', 'Bell & Ross', 'Christopher Ward', 'Phillipe Dufour', 'Bremont', 'Sinn', 'Amida'];
  const out = await buildOne(llmText([...denied, ...real].map(brand => ({ brand, prominence: 'passing' }))), undefined);
  assert.deepEqual(out.dropped_watches.map(w => w.brand), denied);
  assert.ok(out.dropped_watches.every(w => /denylist/.test(w.reason)));
  assert.deepEqual(out.watches.map(w => w.brand), real);
});

test('brand short names: brand expanded, leading short name stripped from models, duplicates merged', async () => {
  const w = [
    { brand: 'AP', model_family: 'Royal Oak', model: 'AP Royal Oak Jumbo', prominence: 'primary' },
    { brand: 'Audemars Piguet', model_family: 'Royal Oak', model: 'Royal Oak Jumbo', prominence: 'secondary' },
    { brand: 'Jaeger-LeCoultre', model_family: 'JLC Reverso', model: '', prominence: 'secondary' },
    { brand: 'Patek Philippe', model_family: 'Patek Nautilus', model: '', prominence: 'passing' },
    { brand: 'A. Lange & S\u00F6hne', model_family: 'Lange 1', model: 'Lange 1', prominence: 'passing' },
    { brand: 'GS', model_family: 'Heritage', model: 'GS Snowflake', prominence: 'passing' },
  ];
  const out = await buildOne(llmText(w), undefined);
  assert.deepEqual(out.watches.map(x => [x.brand, x.model_family, x.model]), [
    ['Audemars Piguet', 'Royal Oak', 'Royal Oak Jumbo'],
    ['Jaeger-LeCoultre', 'Reverso', 'Reverso'],
    ['Patek Philippe', 'Nautilus', 'Nautilus'],
    ['A. Lange & S\u00F6hne', 'Lange 1', 'Lange 1'],
    ['Grand Seiko', 'Heritage', 'Snowflake'],
  ]);
  assert.ok(!qs(out).some(q => /\b(AP|JLC|GS)\b|Patek Philippe Patek/.test(q)), qs(out).join(' | '));
});

test('guard accepts a brand short name written in the post', async () => {
  const w = { brand: 'Jaeger-LeCoultre', model_family: '', model: '', mentioned_as: '', prominence: 'primary' };
  const out = await buildOne(llmText([w]), [prepItem('JLC had a quiet week.')]);
  assert.deepEqual(qs(out), ['Jaeger-LeCoultre watch', 'luxury wristwatch']);
});

test('a nickname-only model is searched together with its model line', async () => {
  const w = [{ brand: 'Rolex', model_family: 'GMT-Master II', model: 'Pepsi', prominence: 'primary' }];
  const out = await buildOne(llmText(w), undefined);
  assert.deepEqual(out.image_queries.slice(0, 2).map(q => [q.q, q.level, q.model]), [
    ['Rolex GMT-Master II Pepsi', 'model', 'Pepsi'], ['Rolex GMT-Master II', 'family', 'Pepsi'],
  ]);
});

test('queries carry no search-operator characters (quotes, parentheses, &, |, +, *, ~)', async () => {
  const w = [
    { brand: 'A. Lange & S\u00F6hne', model_family: 'Lange 1', prominence: 'primary' },
    { brand: 'Grand Seiko', model_family: 'Heritage', model: 'SBGA211 "Snowflake" (spring drive)', prominence: 'primary' },
  ];
  const out = await buildOne(llmText(w), undefined);
  assert.deepEqual(qs(out).slice(0, 3), ['A. Lange S\u00F6hne Lange 1', 'Grand Seiko Heritage SBGA211 Snowflake spring drive', 'Grand Seiko Heritage']);
  for (const q of qs(out)) assert.doesNotMatch(q, /["()&|+*~]|\s{2}/, q);
  assert.equal(out.watches[0].brand, 'A. Lange & S\u00F6hne', 'the brand field itself is unchanged');
});

test('invalid prominence becomes passing; case is normalised', async () => {
  const mk = (model, prominence) => ({ brand: 'Rolex', model_family: model, model, prominence });
  const w = [mk('Daytona', 'main'), mk('Explorer', ''), mk('Datejust'), mk('GMT-Master II', 'PRIMARY'), mk('Sea-Dweller', 42)];
  const out = await buildOne(llmText(w), undefined);
  assert.deepEqual(out.watches.map(x => [x.model, x.prominence]), [
    ['GMT-Master II', 'primary'], ['Daytona', 'passing'], ['Explorer', 'passing'], ['Datejust', 'passing'], ['Sea-Dweller', 'passing'],
  ]);
});

test('non-string fields and non-object entries are cleaned, never thrown on', async () => {
  const w = ['Rolex', null, 42, [], { brand: { name: 'x' }, model: 5 }, { brand: '  Tudor  ', model_family: ['x'], model: null, reference: 7, prominence: 'primary' }];
  const out = await buildOne(llmText(w), undefined);
  assert.deepEqual(out.watches, [{ brand: 'Tudor', model_family: '', model: '', reference: '', mentioned_as: '', prominence: 'primary' }]);
  assert.equal(out.dropped_watches.length, 5);
  assert.ok(out.dropped_watches.every(x => x.reason === 'empty brand'));
  assert.deepEqual(qs(out), ['Tudor watch', 'luxury wristwatch']);
});

test('itemMatching is preferred; when it throws, all()[i] is used', async () => {
  const preps = [prepItem('Rolex text', 'first', { n: 0 }), prepItem('Omega text', 'second', { n: 1 })].map(json => ({ json }));
  const llm = [llmText([{ brand: 'Rolex', prominence: 'primary' }]), llmText([{ brand: 'Omega', prominence: 'primary' }])];
  const viaMatching = await runBuild(llm, { items: preps, itemMatching: i => preps[i] });
  const viaAll = await runBuild(llm, { items: preps, itemMatching: 'throw' });
  for (const out of [viaMatching, viaAll]) {
    assert.deepEqual(out.map(o => [o.json.post_title, o.json.source.n, o.json.watches.length]), [['first', 0, 1], ['second', 1, 1]]);
  }
  // itemMatching wins over position when both exist (e.g. items reordered upstream).
  const swapped = await runBuild(llm, { items: preps, itemMatching: i => preps[1 - i] });
  assert.deepEqual(swapped.map(o => o.json.post_title), ['second', 'first']);
});

test('prep node unavailable: guard skipped, source null, still a valid item', async () => {
  for (const prep of [undefined, { items: [], itemMatching: 'throw' }]) {
    const out = await buildOne(llmText([{ brand: 'Breitling', model_family: 'Navitimer', prominence: 'primary' }]), prep);
    assert.equal(out.source, null);
    assert.equal(out.post_title, '');
    assert.deepEqual(qs(out), ['Breitling Navitimer', 'Breitling watch', 'luxury wristwatch']);
  }
});

test('prep item with empty post_text skips the guard', async () => {
  const out = await buildOne(llmText([{ brand: 'Breitling', prominence: 'primary' }]), [prepItem('   ')]);
  assert.equal(out.watches.length, 1);
});

test('source (the Render WP blocks item) is carried through unchanged', async () => {
  const [prep] = await runPrep([R.steel]);
  const out = await buildOne(llmText([SUB]), [prep.json]);
  assert.deepEqual(out.source, R.steel);
  assert.equal(out.post_title, R.steel.title);
  assert.deepEqual(Object.keys(out).sort(), ['dropped_queries', 'dropped_watches', 'extract_error', 'image_queries', 'post_title', 'source', 'watches']);
});

test('multi-item alignment: each LLM item pairs with the prep item of the same index', async () => {
  const preps = (await runPrep([R.steel, R.dress, R.quiet])).map(o => o.json);
  const llm = [
    llmText([SUB]),
    llmText([{ brand: 'Jaeger-LeCoultre', model_family: 'Reverso', model: 'Reverso Tribute', mentioned_as: 'JLC Reverso Tribute', prominence: 'primary' }]),
    { error: 'timeout' },
  ];
  const out = await runBuild(llm, preps);
  assert.deepEqual(out.map(o => o.pairedItem), [{ item: 0 }, { item: 1 }, { item: 2 }]);
  assert.deepEqual(out.map(o => o.json.source.title), [R.steel.title, R.dress.title, R.quiet.title]);
  assert.deepEqual(out.map(o => o.json.image_queries[0].q), ['Rolex Submariner Date', 'Jaeger-LeCoultre Reverso Tribute', 'luxury wristwatch']);
  assert.deepEqual(out.map(o => o.json.extract_error === ''), [true, true, false]);
});

test('realistic run: steel post, plausible LLM answer with a mistake or two', async () => {
  const [prep] = await runPrep([R.steel]);
  const answer = '```json\n' + JSON.stringify({
    watches: [
      { brand: 'Rolex', model_family: 'Submariner', model: 'Submariner Date', reference: '126610LN', mentioned_as: 'Rolex Submariner Date 126610LN', prominence: 'primary' },
      { brand: 'Audemars Piguet', model_family: 'Royal Oak', model: 'Royal Oak Jumbo', reference: '', mentioned_as: 'AP Royal Oak', prominence: 'primary' },
      { brand: 'Tudor', model_family: 'Black Bay', model: 'Black Bay 58', reference: '', mentioned_as: 'Tudor Black Bay 58', prominence: 'secondary' },
      { brand: 'Omega', model_family: 'Speedmaster', model: 'Speedmaster Professional', reference: '', mentioned_as: 'Speedmaster Professional', prominence: 'passing' },
      { brand: 'Chrono24', model_family: '', model: '', reference: '', mentioned_as: 'Chrono24', prominence: 'passing' },
      { brand: 'Patek Philippe', model_family: 'Nautilus', model: 'Nautilus', reference: '5711/1A', mentioned_as: 'Nautilus', prominence: 'passing' },
    ],
  }, null, 2) + '\n```';
  const out = await buildOne({ text: answer }, [prep.json]);
  assert.deepEqual(out.dropped_watches.map(w => [w.brand, w.reason]), [
    ['Chrono24', 'not a watch manufacturer (denylist)'],
    ['Patek Philippe', 'not found in post text'],
  ]);
  // The last slot before the generic query is kept for the main brand ("Rolex watch").
  assert.deepEqual(qs(out), [
    'Rolex Submariner Date', 'Rolex Submariner', 'Audemars Piguet Royal Oak Jumbo', 'Audemars Piguet Royal Oak',
    'Tudor Black Bay 58', 'Rolex watch', 'luxury wristwatch',
  ]);
  assert.equal(out.dropped_queries, 6);
});

test('MAX_QUERIES keeps one slot for the top brand when model queries would fill every slot', async () => {
  const w = [
    { brand: 'Rolex', model_family: 'Submariner', model: 'Submariner Date', prominence: 'primary' },
    { brand: 'Audemars Piguet', model_family: 'Royal Oak', model: 'Royal Oak Jumbo', prominence: 'primary' },
    { brand: 'Tudor', model_family: 'Black Bay', model: 'Black Bay 58', prominence: 'secondary' },
  ];
  const out = await buildOne(llmText(w), undefined);
  assert.deepEqual(qs(out), [
    'Rolex Submariner Date', 'Rolex Submariner', 'Audemars Piguet Royal Oak Jumbo', 'Audemars Piguet Royal Oak',
    'Tudor Black Bay 58', 'Rolex watch', 'luxury wristwatch',
  ]);
  assert.equal(out.dropped_queries, 3, 'Tudor Black Bay, Audemars Piguet watch, Tudor watch');
  // Nothing moves when the brand query already fits.
  const small = await buildOne(llmText(w.slice(0, 1)), undefined);
  assert.deepEqual(qs(small), ['Rolex Submariner Date', 'Rolex Submariner', 'Rolex watch', 'luxury wristwatch']);
});

test(`the build code reads the prep node as a literal $('${PREP_NODE}') so n8n can rename it`, () => {
  // n8n's renameNode rewrites $('Old') in Code-node jsCode, but not a name stored in a variable.
  const calls = [...BUILD_CODE.matchAll(/\$\(([^)]*)\)/g)].map(m => m[1]);
  assert.ok(calls.length >= 2);
  for (const arg of calls) assert.equal(arg, `'${PREP_NODE}'`);
});

test('an unexpected exception inside the node still yields a valid item', async () => {
  const hostile = { get text() { throw new Error('boom'); } };
  const out = await buildOne(hostile, [prepItem(SUB_TEXT, 'Kept title', { id: 9 })]);
  assert.equal(out.extract_error, 'build queries failed: boom');
  assert.deepEqual(out.image_queries, [GENERIC]);
  assert.deepEqual(out.source, { id: 9 });
  assert.equal(out.post_title, 'Kept title');
});
