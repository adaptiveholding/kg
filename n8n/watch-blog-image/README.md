# Watch blog image finder (n8n fragment for Watch Centro)

This folder builds the n8n nodes that will give each Watch Centro WordPress draft a real, openly licensed
featured photo of a watch the post discusses. The **Watch Centro** workflow belongs to another agent. This
folder only produces a **paste-able node fragment** plus the notes below, which the user hands to that agent.

## Status

| Step | What | State |
| --- | --- | --- |
| 1 | Choose image sources: Openverse API first, Wikimedia Commons as fallback. Licences CC0, PDM, CC BY, CC BY-SA, with a credit line on the post. | done |
| 2 | Pull brands and models out of the post and build an ordered list of image search queries. | done: `workflows/step2-extract-watches.json` |
| 3 | Search Openverse and Commons with those queries and pick one licence-safe, relevant photo per post (plus up to 3 alternates). | **done**: `workflows/step3-search-photos.json` |
| 4 to 6 | Download the photo and upload it to the WordPress media library, set it as the featured image with a credit line, fallbacks and final placement. | not built yet |

**Hand over `workflows/image-finder.json`**: the cumulative fragment, steps 2 and 3 wired together
(10 nodes including 2 sticky notes). The two per-step files are kept for review and tests.

```
Render WP blocks item
  -> Image: prep post text           (step 2) block HTML -> plain text, keeps the incoming item as `source`
  -> Image: extract watches (LLM)    (step 2) Basic LLM Chain + "Anthropic: image extract model" (Claude Haiku 5.5)
  -> Image: build queries            (step 2) checks the LLM's list, builds up to 6 queries + "luxury wristwatch"
  -> Image: split queries            (step 3) one item per query
  -> Image: search Openverse         (step 3) HTTP Request, one GET per query
  -> Image: search Commons           (step 3) HTTP Request, one GET per query
  -> Image: pick photo               (step 3) one item per post: {source, ..., image, image_error, alternates, search_log}
```

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

- `image_queries` is ordered best first. Step 3 searches all of them and takes the photo from the best-ranked query that has a usable one. Levels: `model`, `family`, `brand`, and `generic`. The `generic` query is always present and always last. `watch_index` points into `watches` (`-1` for the generic query) and `prominence` is that watch's prominence, so step 3 can weigh results and write alt text without matching strings again.
- The order is: primary watches (model, then family), secondary watches, "brand watch" for primary brands, passing mentions, then "brand watch" for the remaining brands. There are at most 6 queries before the generic one, and `dropped_queries` counts the rest. **One change from the original spec:** if "brand watch" for the top watch would be cut, it takes the 6th slot instead, so a post whose model queries all miss still searches its main brand before the generic query.
- Queries drop the characters that are search operators on Openverse or carry no search value (`" ( ) | + * ~ &`). A model given without its line ("Pepsi" with family "GMT-Master II") is searched as "Rolex GMT-Master II Pepsi".
- Brand short names are expanded (AP, JLC, VC, GS, PP, Patek, Lange, ...: `BRAND_ALIASES`), and a leading brand or short name is removed from the model ("AP Royal Oak" becomes "Royal Oak", but "Lange 1" stays).
- A watch is dropped (and listed in `dropped_watches` with a `reason`) when it has no brand, when its brand is a marketplace, dealer, auction house or platform (Chrono24, eBay, Phillips, Reddit, ...; spelling variants such as "Chrono 24" or "Christies" too), or when neither its brand nor its model can be found in the post.
- The post check has two tiers. The **brand** counts as found when the brand, one of its short names, or `mentioned_as` is in the post. The **model** needs its own evidence: the model, the model family, a reference (at least 3 characters with a digit), or a `mentioned_as` that says more than the brand name ("the Speedy", "BB58", "Pepsi"). Filler such as "the" or "watch" is ignored. When the brand is found but the model is not, the entry is kept **as brand only** (family, model and reference cleared, so it yields "Rolex watch") and the original is listed in `dropped_watches`. This stops a made-up model, or a copy of the prompt's format example, from becoming the first query.
- `extract_error` is `''` on success. Otherwise it explains what failed: an API error, unparseable JSON, or no `watches` array; then `image_queries` is just the generic query. The parser also accepts JSON with prose or braces around it, a trailing comma, a second object or a bare array. When the JSON is damaged (an unescaped quote) or cut off at the token limit, every complete watch entry is still used and `extract_error` says `LLM JSON was invalid or cut off; kept N complete watch entries`. **Nothing in this fragment stops the workflow.** The LLM node has `onError: continueRegularOutput` and one retry, and both Code nodes catch everything.

## The step 3 fragment

```
Image: build queries      one item per post (step 2 output)
  -> Image: split queries     Code: one item per query {post_index, rank, q, level, brand, model_family, model, reference, prominence, watch_index}
  -> Image: search Openverse  HTTP Request 4.2: GET https://api.openverse.org/v1/images/
  -> Image: search Commons    HTTP Request 4.2: GET https://commons.wikimedia.org/w/api.php
  -> Image: pick photo        Code: one item per post
```

Plus a sticky note, "Image finder (step 3)". In the JSON the nodes continue right of step 2 (x 3420 to 4080, y 1040).

### The two search requests

Every query of every post is sent to both APIs (the HTTP nodes run once per input item; the pick decides afterwards).
Both nodes: `User-Agent: WatchCentroImageFinder/1.0 (+https://watchcentro.com)`, timeout 20 s, batching 1 item per batch,
`onError: continueRegularOutput`, no `retryOnFail`. With these settings each node emits exactly one item per query, in order,
with `pairedItem` kept, also for a 429, a 5xx, a timeout or a reset (verified in n8n 2.42.5).

| Openverse parameter | Value | Why |
| --- | --- | --- |
| URL | `https://api.openverse.org/v1/images/` | the trailing slash matters: `/v1/images` is a 301 |
| `q` | `{{ $json.q }}` | the split node never emits an empty `q` (an empty one searches without text and returns popular images) |
| `license` | `by,by-sa,cc0,pdm` | the four allowed licences; no space after the commas (a space is a 400) |
| `page_size` | `20` | the anonymous maximum (above it: 401) |
| `mature` | **not sent** | see deviation 1 below |
| `extension` | **not sent** | see deviation 3 below |
| header `Accept` | `application/json` | the API also has a browsable HTML renderer |
| batch interval | 3500 ms | production anonymous limit is 20 requests per minute (and 200 per day) |

| Commons parameter | Value | Why |
| --- | --- | --- |
| URL | `https://commons.wikimedia.org/w/api.php` | |
| `action`, `format`, `formatversion` | `query`, `json`, `2` | `query.pages` is a list |
| `generator`, `gsrsearch` | `search`, `{{ $('Image: split queries').item.json.q }} filetype:bitmap` | the input items are the Openverse responses, so the query comes from the split node through `pairedItem`; `filetype:bitmap` is the CirrusSearch file type filter (jpeg, png, gif, tiff, webp, ...; never svg) |
| `gsrnamespace`, `gsrlimit` | `6`, `20` | File namespace, 20 results |
| `prop`, `iiprop` | `imageinfo`, `url\|size\|mime\|extmetadata` | |
| `iiurlwidth` | `1920` | see deviation 2 |
| `iiextmetadatafilter` | `LicenseShortName\|License\|LicenseUrl\|UsageTerms\|AttributionRequired\|Copyrighted\|Restrictions\|Artist\|Credit\|ObjectName\|ImageDescription\|Attribution\|NonFree\|Categories` | what the pick reads (names are case-sensitive); `Copyrighted` is not read today but kept for step 5 |
| `iiextmetadatalanguage` | `en` | |
| `maxlag` | **not sent** | see deviation 8 below |
| batch interval | 1000 ms | far below the Wikimedia edge limit of 100 uncached requests per 10 s per contact |

### Output of "Image: pick photo"

One item per post. `source`, `post_title`, `watches` and `image_queries` are passed through from step 2 unchanged.
Real output of e2e case (a) (n8n 2.42.5, mock APIs serving recorded-format fixtures), trimmed where marked:

```json
{
  "source": { "title": "...", "slug": "...", "content": "...", "...": "..." },
  "post_title": "Watch Market Report: ...",
  "watches": [ { "brand": "Rolex", "model_family": "Submariner", "model": "Submariner Date", "reference": "126610LN", "...": "..." } ],
  "image_queries": [ { "q": "Rolex Submariner Date", "level": "model", "...": "..." }, "... 3 more" ],
  "image": {
    "provider": "openverse",
    "source_name": "Wikimedia Commons",
    "id": "ed296e8f-1cb3-5e22-825d-ddbd552c338c",
    "title": "Rolex Submariner Date 126610LN",
    "creator": "Horologium42",
    "creator_url": "https://commons.wikimedia.org/wiki/User:Horologium42",
    "license": "by-sa",
    "license_version": "4.0",
    "license_name": "CC BY-SA 4.0",
    "license_url": "https://creativecommons.org/licenses/by-sa/4.0/",
    "landing_url": "https://commons.wikimedia.org/w/index.php?curid=148213907",
    "file_url": "https://upload.wikimedia.org/wikipedia/commons/thumb/4/4c/Rolex_Submariner_Date_126610LN.jpg/1920px-Rolex_Submariner_Date_126610LN.jpg",
    "width": 1920,
    "height": 1440,
    "extension": "jpg",
    "mime": "image/jpeg",
    "attribution_required": true,
    "query": { "rank": 0, "q": "Rolex Submariner Date", "level": "model", "watch_index": 0 },
    "score": 53,
    "reasons": ["+20 model tokens present", "+15 reference 126610LN", "+10 width >= 1600", "+5 landscape", "+3 openverse"],
    "alt_text": "Rolex Submariner Date watch",
    "credit_text": "Photo: \"Rolex Submariner Date 126610LN\" by Horologium42, CC BY-SA 4.0, via Wikimedia Commons",
    "download_filename": "rolex-submariner-date-watch-openverse-ed296e8f1cb3.jpg",
    "recent_keys": ["commons:148213907", "file:upload.wikimedia.org/wikipedia/commons/4/4c/rolex_submariner_date_126610ln.jpg", "openverse:ed296e8f-1cb3-5e22-825d-ddbd552c338c"]
  },
  "image_error": "",
  "alternates": [
    { "provider": "openverse", "id": "d3e4d1e1-c069-5080-b265-b206da47bdea", "score": 53, "...": "same shape as image" },
    { "provider": "openverse", "id": "149d8686-eb6f-51c9-a31f-86efb87a8d42", "score": 28, "...": "..." },
    { "provider": "commons", "id": "34418877", "score": 35, "...": "..." }
  ],
  "search_log": [
    { "rank": 0, "q": "Rolex Submariner Date", "provider": "openverse", "status": "ok", "results": 4, "passed": 4 },
    { "rank": 0, "q": "Rolex Submariner Date", "provider": "commons", "status": "ok", "results": 0, "passed": 0 },
    { "rank": 1, "q": "Rolex Submariner", "provider": "openverse", "status": "ok", "results": 13, "passed": 8 },
    { "rank": 1, "q": "Rolex Submariner", "provider": "commons", "status": "ok", "results": 11, "passed": 6 },
    "... ranks 2 and 3"
  ]
}
```

- `image`: the chosen photo, or `null`. `alternates`: up to 3 next best, same shape (step 4 can fall back to them).
- `license` is one of `cc0`, `pdm`, `by`, `by-sa`. Commons "Public domain" files are `pdm` with `license_name` "Public domain" and an
  empty `license_url` (no URL is invented). `attribution_required` is true for CC BY and CC BY-SA.
- `file_url` is what step 4 downloads. Wikimedia-hosted files wider than 1920 px (from Commons, or Openverse rows that point at
  upload.wikimedia.org) are fetched as the 1920 px thumbnail; `width`/`height` are the size of that download. Flickr rows keep their URL
  (Openverse stores Flickr's 1024 px size).
- `credit_text` is plain text without URLs: `Photo: "<title>" by <creator>, <licence>, via <source>`; CC0 and public domain:
  `Photo: "<title>" by <creator> (<licence>), via <source>`. Step 5 adds the links (`landing_url`, `creator_url`, `license_url`).
  When a Commons file has an `Attribution` (the credit the licensor asks for, for example "Foto: Kronograph / Wikimedia Commons /
  CC BY-SA 3.0 DE"), `creator` is that requested name ("Kronograph"; the parts that only repeat the source or licence are dropped),
  because CC BY and BY-SA require the creator to be named the way the licensor requests.
- `recent_keys`: the ids of this photo (Commons page id, Flickr id, file URL, provider id), primary first. Step 5 records them in
  the static data once the photo is really used on a live post (see "Recently used" below).
- `image_error` is `''` when there is an image. Otherwise it says why, with up to 5 reject reasons per provider (e2e case (d)):
  `no licence-safe relevant photo found for 4 queries; openverse: 20 results in 4 searches, 0 passed (excluded term 8, too small 8, aspect 4); commons: 48 results in 4 searches, 0 passed (licence 20, excluded term 8, too small 4, aspect 4, file type 4)`.
  Request failures are counted the same way, for example `openverse: 4x HTTP 429`.
- `search_log`: one entry per query and provider, ordered by rank. `status` is `ok`, `error` (with `http_error`: `HTTP 429`, `HTTP 503`,
  `timeout`, `ECONNRESET`, `API cirrussearch-backend-error`, ...) or `skipped` (node disabled or not run).
- `pairedItem` of each output item lists every search item of that post (one per query), so `$('Render WP blocks').item` and similar
  references in later nodes resolve to the right post (verified in n8n, e2e case (g) with two posts).

### How the pick works

Config is at the top of `src/pick-photo.js`: `MIN_WIDTH` 1000, `PREFERRED_WIDTH` 1600, `MIN_ASPECT` 0.66, `MAX_ASPECT` 2.4,
`ALLOWED_EXT`, `RECENT_LIMIT` 30, `NEGATIVE_TERMS`, `HARD_EXCLUDE_TERMS`, plus `WATCH_WORDS`, `AMBIGUOUS_BRANDS` and `REJECT_RESTRICTIONS`.

1. **Read the responses.** Openverse `results`; Commons `query.pages` sorted by `index` (the API returns pages in database order, not
   relevance order; no `query` key means no hits). n8n failure items (`{error: {status: 429, ...}}`) and MediaWiki errors (HTTP 200
   with `{error: {code, info}}`) become `search_log` errors. Stack traces never reach the output.
2. **Hard filters** (the candidate is dropped): a licence other than CC0, public domain / PDM, CC BY, CC BY-SA (any version or
   jurisdiction port such as "CC BY-SA 3.0 de"); GFDL-only, FAL, "Attribution", Flickr Commons "No restrictions", NC, ND, non-free
   or unknown licences, or licence fields that contradict each other; Commons public domain logos and simple shapes (`License`
   `pd-textlogo`, `pd-logo`, `pd-shape`, `pd-trivial`, `pd-ineligible`); mature or sensitive rows; Openverse rows in the category
   `illustration` or `digitized_artwork`; file types other than jpg, png, webp; a known width under 1000 px; an aspect ratio outside
   0.66 to 2.4; replica, fake, counterfeit, clone, superclone, homage, logo, emblem, clipart, toy, smartwatch, ... and printed matter
   (advert, advertisement, poster, billboard, magazine, brochure, catalog: the photo's licence does not cover the ad it shows) in the
   title, human tags, description or Commons categories, also inside a concatenated tag ("fakerolex", "rolexlogo"); the Commons
   restriction `personality` (`trademarked` is allowed: it is on most branded product photos); a missing file or landing URL.
   CC BY / BY-SA without an author is kept as "Unknown author" with a penalty ("Unknown", "Unbekannt", "inconnu", ... count as none).
3. **Relevance** (normalised like step 2):
   - model and family queries need the brand **named in the title, a human tag or a Commons category** (a description that only
     mentions it, "the Tudor sister of the Rolex Submariner", is not enough), and every word of the model family (anywhere). A
     two-letter short name (AP, VC, PP, GS) only counts right before the family ("AP Royal Oak").
   - **another brand**: a title that names another watch brand (`WATCH_BRANDS`, plus the brands in the post's `watches`) but not the
     query's brand is rejected ("Tudor Submariner 7928" or "Omega Seamaster" tagged rolex for "Rolex Submariner"). A title naming
     both ("Rolex Daytona vs Omega Speedmaster") passes.
   - brand queries need the brand (as above) **and a watch word for every brand**; the generic query needs a watch word. There, the
     watch word must be in the title, human tags, description or categories (machine tags such as Clarifai's "watch" do not count),
     and "dial" or "bezel" alone do not count. Watchmaker, watchtower, smartwatch, Apple Watch, stopwatch and "swatch" are not
     watch words. Pocket watches, clocks, sundials and stopwatches are rejected for brand and generic queries.
   - Brands that are everyday words (Omega, Tudor, Zenith, Hamilton, ...) also need a watch word, or a tag such as
     "omegaspeedmaster", for model and family queries, so "Omega Centauri" does not pass for "Omega Constellation".
4. **Score** within a query: +20 all model words present (beyond the family), +15 reference present, +10 width >= 1600, +5 landscape
   (1.2 to 2.0), +3 Openverse, -15 per negative term (box, papers, boutique, shop, movement, caseback, strap, pocket watch,
   illustration, render, ...), -10 unknown size, -10 unknown author on CC BY / BY-SA, -40 recently used. `reasons` lists every step.
5. **Choice**: the lowest query rank that has a candidate, then the highest score (then Openverse, then search position).
6. **Dedupe**: Openverse indexes Commons and Flickr, and Commons holds Flickr copies. Candidates are keyed by Commons page id (also
   parsed from `?curid=`), Flickr photo id (URL, or the "(id)" suffix of Flickr2Commons file names), file URL without query string
   (thumbnails mapped to the original), landing URL, title + size; the first copy in choice order is kept.
   **Veto**: when one provider rejects a photo for its licence, a `personality` restriction, NonFree, mature content or an excluded
   term, every copy of it with a shared key is dropped at the other provider too (`copy rejected elsewhere` in `image_error`), for
   all queries of the post. Commons knows restrictions, NonFree flags and licence reviews that the Openverse copy does not carry.
7. **Recently used**: `$getWorkflowStaticData('global').imageFinder.recent` holds `{key, keys, at}` entries. A photo whose keys are in
   that list scores -40 (it is not rejected). **The pick only reads this list** (`REMEMBER_CHOSEN = false`): it never changes the
   static data. Step 5 adds a photo (`{key: recent_keys[0], keys: recent_keys, at}`, trimmed to `RECENT_LIMIT` 30) on the Live mode?
   true branch, once the photo is really on a live post. Within one execution the pick still gives two posts different photos.
   Why: n8n saves the whole static data object at the end of every non-editor execution in which anything in it changed. A Watch
   Centro test run (webhook mode, so it is saved) that wrote here could overwrite the `liveRunIds` that an overlapping live run saved
   (reproduced in n8n 2.42.5), and a test pick would count as used. `REMEMBER_CHOSEN = true` restores the in-pick write.

### Deviations from the step 3 spec (and why)

1. **No `mature=false` on Openverse.** In the current API source (`media_serializers.py`, `validate_unstable__include_sensitive_results`)
   any `mature` value in the query string, the string "false" included, switches sensitive results ON. Leaving it out keeps the
   sensitive filter on. The pick still rejects `mature: true` rows.
2. **`iiurlwidth=1920`, not 2000.** Wikimedia only renders thumbnail steps (..., 1280, 1920, 3840). A 2000 px request returns the
   original for any file under 3840 px and a 3840 px thumbnail above that, never about 2000 px. 1920 is a step.
3. **No `extension` filter on Openverse.** Openverse's indexer takes the extension from the URL's last dot segment
   (`url.split(".")[-1]`), and Commons imageinfo URLs now end in `?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=original`
   (MediaWiki request provenance, on by default on Wikimedia sites), so `extension=jpg,...` would drop every Wikimedia row Openverse
   indexed since then: the only Openverse rows above 1024 px. The pick rejects svg, gif, tif and the rest by the URL path itself.
4. **`pairedItem` of a pick item is the list of that post's search items**, not `{item: p}`. In n8n `pairedItem` points at the node's own
   input, which has one item per query, so `{item: p}` would point at a query of another post as soon as a post has two queries.
5. **Wikimedia-hosted Openverse rows** use the 1920 px thumbnail as `file_url` (not the Openverse `url`, which is the full original,
   often 5 to 25 MB).
6. **Commons `landing_url`** is the file page (`descriptionurl`), the better credit link; dedupe also uses the page id.
7. Relevance and filters are stricter than the spec's wording: the brand must be named in the title, tags or categories; a title
   naming another watch brand is rejected; brand queries need a watch word for every brand (the spec only asked for the brand);
   the extra exclusion terms; advert, poster and catalog are rejected instead of -15 (licence safety); Openverse illustration and
   digitized artwork categories are rejected; see `AMBIGUOUS_BRANDS`, `WATCH_WORDS` (without "diver", which matched scuba photos).
8. **No `maxlag` on Commons.** It is meant for bots that write or read a lot. Here it only adds a failure mode: on a lag spike the API
   answers HTTP 200 with an error, nothing retries it, and all 7 searches of a post (1 s apart) can fail.
9. **Static data is read, not written, by the pick** (see "Recently used"); the chosen photo's keys are in `image.recent_keys` for
   step 5. The spec asked the pick to push and trim the list.
10. **A photo rejected by one provider is dropped at the other** (veto, see "Dedupe"), not only deduped.

### Openverse registration (optional, higher limits)

Anonymous use is limited per IP: 20 requests per minute and 200 per day were the production values in the newest recorded responses
(the source defaults are lower, 5 per hour and 100 per day). A post uses up to 7 Openverse requests, so about 28 posts per day.
A registered and **verified** app gets 100 per minute and 10000 per day. Openverse uses OAuth2 client credentials:

1. Register once (from any terminal; the name must be unique):

   ```sh
   curl -X POST -H "Content-Type: application/json" \
     -d '{"name":"WatchCentro Image Finder","description":"Finds openly licensed watch photos for watchcentro.com drafts","email":"<your email>"}' \
     https://api.openverse.org/v1/auth_tokens/register/
   ```

   The answer is `201 {"client_id": "...", "client_secret": "...", "name": "...", "msg": "Check your email for a verification link."}`.
   Save `client_secret` now: it cannot be retrieved later. Then click the link in the e-mail. Until it is clicked the app keeps the
   anonymous limits. (Registration is limited to 10 per day per IP.)
2. In n8n: **Credentials > Create credential > "OAuth2 API"**:
   - Grant Type: **Client Credentials**
   - Access Token URL: `https://api.openverse.org/v1/auth_tokens/token/`
   - Client ID / Client Secret: from step 1
   - Scope: leave empty
   - Authentication: **Body** (Header also works)
   - leave "Token Expired Status Code" at 401 and "Ignore SSL Issues" off. Save. There is no Connect button for this grant type.
3. Open **Image: search Openverse**: Authentication **Generic Credential Type**, Generic Auth Type **OAuth2 API**, Credential: the new one.
   Nothing else changes. The batch interval (Options > Batching) can then go down to 700 ms.

n8n fetches a token (`POST .../token/` with `grant_type=client_credentials`) on first use, sends `Authorization: Bearer <token>`, and on
a 401 fetches a new one and repeats the request once; tokens last 12 h (verified against the mock in n8n 2.42.5). To check the account:
`GET https://api.openverse.org/v1/rate_limit/` with the same credential shows `verified: true` and the rate limit model.

Openverse's terms ask apps to "prominently indicate that it was made using Openverse but is not endorsed or certified by Openverse"; step 5
should decide where (for example "via Openverse" in the credit, or a site-level note).

## Integration notes (for the agent that owns Watch Centro)

1. **Paste**: copy all of `workflows/image-finder.json` (steps 2 and 3) and paste it onto the Watch Centro canvas (Ctrl/Cmd+V). The links between the fragment's own nodes come along (prep -> LLM -> build queries -> split queries -> Openverse -> Commons -> pick photo, and the model sub-node). n8n drops any link to a node outside the pasted set, so wiring to existing nodes is done by hand. If step 2 is already on the canvas, delete it first or paste `workflows/step3-search-photos.json` and link "Image: build queries" to "Image: split queries" by hand.
2. **Credentials**: "Anthropic: image extract model" uses the same credential as the three existing model nodes: `anthropicApi` id `Fy3gBIA4bOXd96pw` ("Anthropic account"). If n8n shows the credential as missing after paste, select "Anthropic account" again. The model is `claude-haiku-5-5` with `maxTokensToSample` 1000 and **Thinking Mode: Disabled** (the request carries `thinking: {type: "disabled"}`). Keep thinking off, or raise the token limit with it: Claude Haiku 5.5 thinks by default when the option is unset, and thinking tokens count toward the limit, so a 1000-token cap could be used up before any JSON is written. The two search nodes need **no credential** (an Openverse OAuth2 credential is optional, see "Openverse registration"). There is no WordPress access yet.
3. **Input**: the single item that **Render WP blocks** outputs: `{title, slug, excerpt, content, seo_title, meta_description, focus_keyphrase, word_count}`. Other shapes are auto-detected, including the writer's post JSON (`summary`, `sections[]`, ...). `TITLE_PATH` and `BODY_PATH` at the top of "Image: prep post text" can force a path.
4. **Final placement** (decided in step 6). The plan: steps 2 to 4 (queries, search and pick, download) only read (the pick also leaves the static data alone), so they can sit inline between **Render WP blocks** and **Live mode?** and return `{...source, image: ...}` so the existing nodes keep reading the same top-level fields. Steps 5 and 6 (upload to the media library, set the featured image) write to WordPress, so they belong on the **Live mode? true branch**; before Live mode? they would upload media on test runs too. Either put them before **WordPress: create draft** and add `featured_media: $json.featured_media` to its `jsonBody` (today the body has no `featured_media`), or after it, with a `POST /wp-json/wp/v2/posts/{id}` that sets `featured_media`. Both ways need a change to the existing nodes.
5. **Still do NOT put the fragment inline.** "Image: pick photo" nests the post under `source`, so `$json.title` and the other fields would be empty in "WordPress: create draft". To try it on real runs now, leave it unconnected and test it with pinned data, or connect it as a **side branch**: add a second link from the Render WP blocks output to "Image: prep post text" and leave "Image: pick photo" unconnected. With `executionOrder: v1`, n8n runs sibling branches top to bottom by canvas position, so the fragment must sit **below** the main row: below **Live mode?** (y 200). Merging the JSON as is gives that (y 1040). When pasting in the editor, click an empty spot below the main row first, because the paste lands where you last clicked. Then the draft branch and the webhook response run first and are unchanged. Placed above, the side branch would run first and the webhook response would wait for it.
6. **Cost and time per run** (one post): one Haiku call, then one Openverse and one Commons request per query: up to 7 queries, so **up to 14 HTTP requests**. With the batch intervals (Openverse 3.5 s, Commons 1 s) the search adds about 30 s for 7 queries (about 15 s for the usual 4). Every query is searched even when an earlier one already found a photo (the HTTP nodes run once per item; the pick decides afterwards). The anonymous Openverse budget (about 200 requests per day per IP) covers about 28 posts per day; beyond that Openverse answers 429, the post falls back to Commons, and `search_log` shows the 429s. A registered Openverse app removes that limit in practice.
7. **Wikimedia User-Agent**: both search nodes send `User-Agent: WatchCentroImageFinder/1.0 (+https://watchcentro.com)`. Keep a header like it (app name/version plus a contact URL or e-mail): without one n8n sends `n8n`, and the Wikimedia edge answers 403 to missing or library-default user agents. Step 4's downloads from upload.wikimedia.org need the same header (that host allows about 10 uncached requests per 10 s per contact).
8. **Static data**: "Image: pick photo" only READS `$getWorkflowStaticData('global').imageFinder.recent`; it writes nothing. n8n saves static data as ONE object per execution (the copy loaded when the run started, plus that run's changes), so any node that writes static data on a run that "Record run id" does not touch (a test run) can erase `liveRunIds` saved by an overlapping live run, and with it the duplicate guard. Step 5 will therefore record a used photo in a small Code node on the **Live mode? true** branch (a run that already saves static data), after the featured image is set. Overlapping live runs already share this last-writer-wins risk for `liveRunIds` today; the fragment adds nothing to it.
9. **Node references**: the fragment reads no Watch Centro node by name. It reads its own nodes with literal `$('Image: ...')` references (`build queries` -> `prep post text`; `search Commons` -> `split queries`; `pick photo` -> `build queries`, `split queries`, `search Openverse`, `search Commons`), which n8n updates by itself when a node is renamed. Do not remove or reorder the four step-3 nodes: pick photo matches responses to queries through them.
10. Settings already match: single item per run, `executionOrder: v1`. Node versions are no newer than the ones Watch Centro uses (Code 2, HTTP Request 4.2, Basic LLM Chain 1.9, Anthropic Chat Model 1.6, Sticky Note 1). No node name or id collides with Watch Centro (`npm test` checks against the export when it is available).
11. **Nothing in the fragment stops the workflow**: the LLM and both HTTP nodes have `onError: continueRegularOutput`, and the Code nodes catch everything; a failure ends up in `extract_error`, `search_log` or `image_error`.

## Files

| Path | What |
| --- | --- |
| `src/prep-post-text.js` | Body of "Image: prep post text" |
| `src/extract-watches.prompt.txt` | Extraction prompt; `{{POST_TITLE}}` and `{{POST_TEXT}}` become `{{ $json.post_title }}` and `{{ $json.post_text }}` |
| `src/build-image-queries.js` | Body of "Image: build queries" (config at the top: `MAX_QUERIES`, `GENERIC_QUERY`, `DENYLIST`) |
| `src/split-queries.js` | Body of "Image: split queries" |
| `src/pick-photo.js` | Body of "Image: pick photo" (config at the top) |
| `build.mjs` | Writes the three `workflows/*.json` files from `src/` and validates them (names, ids, type versions, connections, `$()` references, no em dash). The HTTP node parameters are defined here. |
| `workflows/image-finder.json` | **The deliverable**: steps 2 + 3, n8n paste format `{nodes, connections, pinData}` |
| `workflows/step2-extract-watches.json`, `workflows/step3-search-photos.json` | The same nodes per step |
| `test/unit/` | Unit tests. The Code bodies run in a vm with emulated `$input` / `$()` / `$getWorkflowStaticData` |
| `test/e2e/` | Real n8n 2.x + mock Anthropic, Openverse and Commons APIs (see `test/e2e/README.md`) |
| `test/fixtures/` | Writer posts and their real "Render WP blocks" output; Openverse and Commons responses (`openverse/`, `commons/`, each with a `manifest.json` naming the source they follow); real n8n HTTP Request failure items (`n8n/`) |

## Build and test

```sh
npm run build        # regenerate the three workflows/*.json files after editing src/ or build.mjs
npm test             # unit tests (Node 22+, no install); also fails if a generated file is out of date
```

End to end in a real n8n (2.42.5 tested; it needs Node 24). The one-time install is in `test/e2e/README.md`:

```sh
N8N_BIN=/abs/path/n8n-v2/n8n.sh E2E_N8N_HOME=/abs/scratch/n8n-e2e-home npm run test:e2e   # about 4 to 5 min
```

This runs the smoke test, `test/e2e/step2.e2e.mjs`, `test/e2e/http-request.e2e.mjs` (the HTTP Request 4.2 facts step 3 relies on)
and `test/e2e/step3.e2e.mjs`. Without `N8N_BIN` the e2e tests are skipped.

Step 2 runs the real Render WP blocks code on a fixture writer post, then the step 2 nodes exactly as they are in the JSON, against a mock Anthropic API. It covers six cases:

- a multi-brand post with a hallucinated watch, a model not in the post (kept as brand only) and a marketplace in the LLM answer
- a post with no watches
- HTTP 500 from the API
- JSON wrapped in prose and code fences
- a reply that starts with a `thinking` block
- a reply cut off at `max_tokens` in the middle of the JSON

It also checks that the API received `claude-haiku-5-5`, `max_tokens` 1000, `thinking: {type: "disabled"}` and the cleaned post text: no tags, no `wp:` comments, entities decoded.

Step 3 runs the real Render WP blocks code, then all 10 nodes of `workflows/image-finder.json` (only the two API base URLs are
rewritten to the local mocks), then a check node that reads `$('Render WP blocks').item` from each pick item. Cases:

- (a) Openverse hit at model level, with the real batch intervals (requests at least 3.3 s apart); the static data (with `liveRunIds`) is unchanged
- (b) Openverse answers 429 to every request: Commons wins, `search_log` shows four `HTTP 429`
- (c) only the generic query finds a usable photo
- (d) nothing passes anywhere (licence, size, aspect, file type, logo, replica): `image` null with the reason, run completes
- (e) the same photo from both providers is listed once
- (f) Commons pages served against relevance order: `index` decides; a `cirrussearch-backend-error` API error (HTTP 200) and an HTTP 503 are logged, not fatal
- (g) two posts in one execution: one pick item each, paired with its own post, different photos, static data untouched
- (h) a recently used photo (seeded static data) drops to an alternate with -40; the list is read, not written
- (i) the Commons copy of a file carries the `personality` restriction: the Openverse copy of the same file is not used either

Each case also checks what the mocks received: the exact query parameters (no `mature`, `extension` or `maxlag`), `User-Agent` and `Accept` headers.

## Notes and known limits

- Watches are sorted by prominence before duplicates are removed, so when the LLM lists the same model twice, the more prominent entry wins.
- The "is it in the post" check also looks at the title. Every Watch Centro post has a "most mentioned" table with a Brand column, so the brand tier almost always passes for a brand the post covers; the model tier is what stops invented models.
- A model the post never names is kept as brand only. If the same post also has a real model of that brand, both entries stay in `watches`; the queries are not duplicated.
- The marketplace check compares names without spaces or punctuation and also catches names that start with a denylisted one, such as "Chrono24.com".
- Queries keep diacritics ("A. Lange Söhne Lange 1"). Openverse does not fold accents, but many Commons titles use them. The pick matches both spellings (Söhne, Sohne, Soehne), but the searches are not retried with an ASCII form.
- Brand names that are also everyday words ("Tudor Royal", "Omega Constellation") can match off-topic photos. Step 3 requires a watch word or a brand + family tag for them (`AMBIGUOUS_BRANDS`), which can also reject a real photo whose text has neither.
- Cleaning other input shapes: plain text that holds a raw `<` directly followed by a letter ("the <Submariner") still loses the text up to the next `>`. Render WP blocks escapes `<`, so Watch Centro posts are not affected.

Step 3:

- The mocks follow the APIs' source code and recorded responses, but the real services were not reachable from the build machine. Real result quality (how many relevant, licence-safe photos come back for a given watch) is untested.
- Openverse anonymous limits in production are not published; 20 per minute and 200 per day come from recorded response headers (2024). The 3.5 s interval assumes 20 per minute.
- Every query is searched on both APIs, also after an earlier query found a photo. Openverse ANDs the words, so the family query already returns the model query's results; dropping the model-level request (and scoring its words instead) would save up to 3 requests per post. Not done, to keep to the spec.
- Openverse's Flickr rows are at most 1024 px wide (Openverse stores Flickr's "large" size), so they never get the +10 width bonus, and Flickr portraits always fail the 1000 px minimum. Commons copies of the same photo are often larger.
- Openverse returns no description, so a row that matched only in its description fails the relevance check.
- `logo`, `homage`, `replica` and the other exclusion terms reject a photo wherever they appear in its text, also in an innocent sentence of a Commons description.
- "Recently used" has no effect until step 5 records used photos (the pick only reads the list). Static data is not saved for editor test runs.
- An Openverse row hosted on Wikimedia is checked against Commons only when the Commons search of the same post returned that file
  (veto). Otherwise its Commons `Restrictions` and NonFree flags are unknown: step 4 should look such a pick up on Commons
  (`action=query&pageids=<curid>&prop=imageinfo&iiprop=extmetadata`) before uploading it, and fall back to an alternate if it fails.
- The other-brand check only knows `WATCH_BRANDS` and the post's own brands, and only reads the title. Exclusion terms also match
  inside tags, so an innocent tag such as "cyclone" (contains "clone") rejects a photo. Rejections are cheap here; wrong photos are not.
- Weak generic photos (a strap, a watch box) are still picked when nothing better exists at the generic level; they score -15.
- The recent-use penalty (-40) only reorders photos of the same query: a recently used photo for the best query still beats a fresh one for a less specific query.
- Credit lines name the original source ("via Flickr", "via Wikimedia Commons"), not Openverse; Openverse's terms ask for a "made using Openverse" notice somewhere (step 5).
- Step 4 should download `file_url` with the same User-Agent, and may fall back to `alternates` when a download fails.
