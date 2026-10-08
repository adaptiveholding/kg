# Watch blog image finder (n8n fragment for Watch Centro)

This folder builds the n8n nodes that will give each Watch Centro WordPress draft a real, openly licensed
featured photo of a watch the post discusses. The **Watch Centro** workflow belongs to another agent. This
folder only produces a **paste-able node fragment** plus the notes below, which the user hands to that agent.

## Status

| Step | What | State |
| --- | --- | --- |
| 1 | Choose image sources: Openverse API first, Wikimedia Commons as fallback. Licences CC0, PDM, CC BY, CC BY-SA, with a credit line on the post. | done |
| 2 | Pull brands and models out of the post and build an ordered list of image search queries. | **this fragment**: `workflows/step2-extract-watches.json` |
| 3 to 6 | Search Openverse/Commons with those queries, pick and download a photo, upload it to WordPress, set it as the featured image. | not built yet |

## The step 2 fragment

```
Render WP blocks item
  -> Image: prep post text           Code: block HTML -> plain text, keeps the incoming item as `source`
  -> Image: extract watches (LLM)    Basic LLM Chain + "Anthropic: image extract model" (Claude Haiku 5.5)
  -> Image: build queries            Code: checks the LLM's list, builds the queries
```

Plus a sticky note, "Image finder (step 2)". In the JSON the nodes sit below the existing flow, at x 2560 to 3520 and y 660 to
about 1360. Those positions only hold when the JSON is merged into the workflow file directly: a paste in the editor drops the
nodes where you last clicked (see integration note 5).

**Output** (one item per input item, `pairedItem` kept):

```json
{
  "source": { "title": "...", "slug": "...", "excerpt": "...", "content": "...", "seo_title": "...", "meta_description": "...", "focus_keyphrase": "...", "word_count": 512 },
  "post_title": "Watch Market Report: Submariner and Royal Oak Lead Steel Demand",
  "watches": [
    { "brand": "Rolex", "model_family": "Submariner", "model": "Submariner Date", "reference": "126610LN", "mentioned_as": "Rolex Submariner Date 126610LN", "prominence": "primary" },
    { "brand": "Rolex", "model_family": "", "model": "", "reference": "", "mentioned_as": "Rolex", "prominence": "passing" }
  ],
  "image_queries": [
    { "q": "Rolex Submariner Date", "level": "model", "brand": "Rolex", "model_family": "Submariner", "model": "Submariner Date", "reference": "126610LN", "prominence": "primary", "watch_index": 0 },
    { "q": "Rolex Submariner", "level": "family", "brand": "Rolex", "model_family": "Submariner", "model": "Submariner Date", "reference": "126610LN", "prominence": "primary", "watch_index": 0 },
    { "q": "Rolex watch", "level": "brand", "brand": "Rolex", "model_family": "", "model": "", "reference": "", "prominence": "primary", "watch_index": 0 },
    { "q": "luxury wristwatch", "level": "generic", "brand": "", "model_family": "", "model": "", "reference": "", "prominence": "", "watch_index": -1 }
  ],
  "dropped_watches": [
    { "brand": "Chrono24", "...": "...", "reason": "not a watch manufacturer (denylist)" },
    { "brand": "Rolex", "model": "Cosmograph Daytona", "...": "...", "reason": "model not found in post text (kept brand only)" }
  ],
  "dropped_queries": 0,
  "extract_error": ""
}
```

- `image_queries` is ordered best first. Step 3 tries them in order and stops at the first good photo. Levels: `model`, `family`, `brand`, and `generic`. The `generic` query is always present and always last. `watch_index` points into `watches` (`-1` for the generic query) and `prominence` is that watch's prominence, so step 3 can weigh results and write alt text without matching strings again.
- The order is: primary watches (model, then family), secondary watches, "brand watch" for primary brands, passing mentions, then "brand watch" for the remaining brands. There are at most 6 queries before the generic one, and `dropped_queries` counts the rest. **One change from the original spec:** if "brand watch" for the top watch would be cut, it takes the 6th slot instead, so a post whose model queries all miss still searches its main brand before the generic query.
- Queries drop the characters that are search operators on Openverse or carry no search value (`" ( ) | + * ~ &`). A model given without its line ("Pepsi" with family "GMT-Master II") is searched as "Rolex GMT-Master II Pepsi".
- Brand short names are expanded (AP, JLC, VC, GS, PP, Patek, Lange, ...: `BRAND_ALIASES`), and a leading brand or short name is removed from the model ("AP Royal Oak" becomes "Royal Oak", but "Lange 1" stays).
- A watch is dropped (and listed in `dropped_watches` with a `reason`) when it has no brand, when its brand is a marketplace, dealer, auction house or platform (Chrono24, eBay, Phillips, Reddit, ...; spelling variants such as "Chrono 24" or "Christies" too), or when neither its brand nor its model can be found in the post.
- The post check has two tiers. The **brand** counts as found when the brand, one of its short names, or `mentioned_as` is in the post. The **model** needs its own evidence: the model, the model family, a reference (at least 3 characters with a digit), or a `mentioned_as` that says more than the brand name ("the Speedy", "BB58", "Pepsi"). Filler such as "the" or "watch" is ignored. When the brand is found but the model is not, the entry is kept **as brand only** (family, model and reference cleared, so it yields "Rolex watch") and the original is listed in `dropped_watches`. This stops a made-up model, or a copy of the prompt's format example, from becoming the first query.
- `extract_error` is `''` on success. Otherwise it explains what failed: an API error, unparseable JSON, or no `watches` array; then `image_queries` is just the generic query. The parser also accepts JSON with prose or braces around it, a trailing comma, a second object or a bare array. When the JSON is damaged (an unescaped quote) or cut off at the token limit, every complete watch entry is still used and `extract_error` says `LLM JSON was invalid or cut off; kept N complete watch entries`. **Nothing in this fragment stops the workflow.** The LLM node has `onError: continueRegularOutput` and one retry, and both Code nodes catch everything.

## Integration notes (for the agent that owns Watch Centro)

1. **Paste**: copy all of `workflows/step2-extract-watches.json` and paste it onto the Watch Centro canvas (Ctrl/Cmd+V). The links between the fragment's own nodes come along. n8n drops any link to a node outside the pasted set, so wiring to existing nodes is done by hand.
2. **Credential**: "Anthropic: image extract model" uses the same credential as the three existing model nodes: `anthropicApi` id `Fy3gBIA4bOXd96pw` ("Anthropic account"). If n8n shows the credential as missing after paste, select "Anthropic account" again. The model is `claude-haiku-5-5` with `maxTokensToSample` 1000 and **Thinking Mode: Disabled** (the request carries `thinking: {type: "disabled"}`). Keep thinking off, or raise the token limit with it: Claude Haiku 5.5 thinks by default when the option is unset, and thinking tokens count toward the limit, so a 1000-token cap could be used up before any JSON is written. There is no WordPress access and no new credential.
3. **Input**: the single item that **Render WP blocks** outputs: `{title, slug, excerpt, content, seo_title, meta_description, focus_keyphrase, word_count}`. Other shapes are auto-detected, including the writer's post JSON (`summary`, `sections[]`, ...). `TITLE_PATH` and `BODY_PATH` at the top of "Image: prep post text" can force a path.
4. **Final placement** (decided in a later step, once steps 3 to 6 exist). The plan: steps 2 to 4 (queries, search, pick a photo) only read, so they can sit inline between **Render WP blocks** and **Live mode?** and return `{...source, image: ...}` so the existing nodes keep reading the same top-level fields. Steps 5 and 6 (upload to the media library, set the featured image) write to WordPress, so they belong on the **Live mode? true branch**; before Live mode? they would upload media on test runs too. Either put them before **WordPress: create draft** and add `featured_media: $json.featured_media` to its `jsonBody` (today the body has no `featured_media`), or after it, with a `POST /wp-json/wp/v2/posts/{id}` that sets `featured_media`. Both ways need a change to the existing nodes.
5. **Do NOT put step 2 inline on its own.** Its output nests the post under `source`, so `$json.title` and the other fields would be empty in "WordPress: create draft". To try step 2 on real runs now, leave it unconnected and test it with pinned data. Or connect it as a **side branch**: add a second link from the Render WP blocks output to "Image: prep post text" and leave "Image: build queries" unconnected. With `executionOrder: v1`, n8n runs sibling branches top to bottom by canvas position, so the fragment must sit **below** the main row: below **Live mode?** (y 200). Merging the JSON as is gives that (y 1040). When pasting in the editor, click an empty spot below the main row first, because the paste lands where you last clicked. Then the draft branch and the webhook response run first and are unchanged. Placed above, the side branch would run first and the webhook response would wait for the Haiku call. Either way the side branch adds one Haiku call per run.
6. **Node references**: the fragment reads no Watch Centro node by name. "Image: build queries" reads its own prep node with a literal `$('Image: prep post text')`, which n8n updates by itself if that node is renamed.
7. Settings already match: single item per run, `executionOrder: v1`. Node versions are no newer than the ones Watch Centro uses (Code 2, Basic LLM Chain 1.9, Anthropic Chat Model 1.6, Sticky Note 1).
8. **For step 3 (search), not built yet**: Openverse throttles requests made without a token per IP. The API source sets the anonymous defaults to a burst of 5 per hour and 100 per day; the production values are not published, but responses carry `X-RateLimit-*` headers. Up to 7 queries per post can therefore hit HTTP 429. Step 3 should treat a 429 as "go to Wikimedia Commons", read those headers, and ideally use a free Openverse OAuth client (100 per minute, 10000 per day). Openverse requires every query term (AND matching), so a family query ("Rolex Submariner") already returns everything the model query ("Rolex Submariner Date") returns. Step 3 can send the family query once and rank its results by the `model` and `reference` fields of the entry instead of spending a call on each.

## Files

| Path | What |
| --- | --- |
| `src/prep-post-text.js` | Body of "Image: prep post text" |
| `src/extract-watches.prompt.txt` | Extraction prompt; `{{POST_TITLE}}` and `{{POST_TEXT}}` become `{{ $json.post_title }}` and `{{ $json.post_text }}` |
| `src/build-image-queries.js` | Body of "Image: build queries" (config at the top: `MAX_QUERIES`, `GENERIC_QUERY`, `DENYLIST`) |
| `build.mjs` | Writes `workflows/step2-extract-watches.json` from `src/` and validates it |
| `workflows/step2-extract-watches.json` | **The deliverable**: n8n paste format `{nodes, connections, pinData}` |
| `test/unit/` | Unit tests. The Code bodies run in a vm with emulated `$input` / `$()` |
| `test/e2e/` | Real n8n 2.x + mock Anthropic API (see `test/e2e/README.md`) |
| `test/fixtures/` | Writer posts and their real "Render WP blocks" output |

## Build and test

```sh
npm run build        # regenerate workflows/step2-extract-watches.json after editing src/
npm test             # unit tests (Node 22+, no install); also fails if the fragment is out of date
```

End to end in a real n8n (2.42.5 tested; it needs Node 24). The one-time install is in `test/e2e/README.md`:

```sh
N8N_BIN=/abs/path/n8n-v2/n8n.sh E2E_N8N_HOME=/abs/scratch/n8n-e2e-home npm run test:e2e
```

This runs the smoke test plus `test/e2e/step2.e2e.mjs`, which takes about 60 s. Step 2 runs the real Render WP blocks code on a fixture writer post, then the fragment nodes exactly as they are in the JSON, against a mock Anthropic API. It covers six cases:

- a multi-brand post with a hallucinated watch, a model not in the post (kept as brand only) and a marketplace in the LLM answer
- a post with no watches
- HTTP 500 from the API
- JSON wrapped in prose and code fences
- a reply that starts with a `thinking` block
- a reply cut off at `max_tokens` in the middle of the JSON

It also checks that the API received `claude-haiku-5-5`, `max_tokens` 1000, `thinking: {type: "disabled"}` and the cleaned post text: no tags, no `wp:` comments, entities decoded. Without `N8N_BIN` the e2e tests are skipped.

## Notes and known limits

- Watches are sorted by prominence before duplicates are removed, so when the LLM lists the same model twice, the more prominent entry wins.
- The "is it in the post" check also looks at the title. Every Watch Centro post has a "most mentioned" table with a Brand column, so the brand tier almost always passes for a brand the post covers; the model tier is what stops invented models.
- A model the post never names is kept as brand only. If the same post also has a real model of that brand, both entries stay in `watches`; the queries are not duplicated.
- The marketplace check compares names without spaces or punctuation and also catches names that start with a denylisted one, such as "Chrono24.com".
- Queries keep diacritics ("A. Lange Söhne Lange 1"). Openverse does not fold accents, but many Commons titles use them. Step 3 can retry with an ASCII form if this turns out to cost hits.
- Brand names that are also everyday words ("Tudor Royal", "Omega Constellation") can match off-topic photos. Filtering that is left to step 3's result checks.
- Cleaning other input shapes: plain text that holds a raw `<` directly followed by a letter ("the <Submariner") still loses the text up to the next `>`. Render WP blocks escapes `<`, so Watch Centro posts are not affected.
