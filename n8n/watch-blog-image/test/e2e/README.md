# End-to-end harness (real n8n 2.x + mock Anthropic, Openverse and Commons APIs)

Runs a workflow, or a paste-format node fragment, inside a real local n8n CLI. The
`anthropicApi` credential `Fy3gBIA4bOXd96pw` ("Anthropic account") points at a local mock of the
Messages API, so the real `chainLlm` 1.9 and `lmChatAnthropic` 1.6 nodes run without a key or network.
For step 3, local mocks of the Openverse API and the Wikimedia Commons Action API stand in for
`https://api.openverse.org` and `https://commons.wikimedia.org`; the harness rewrites those base URLs
in the HTTP Request nodes before import.

| File | What it is |
| --- | --- |
| `mock-anthropic.mjs` | Zero-dependency mock: `POST /v1/messages` (JSON, or SSE when `stream: true`), `GET /v1/models[/id]`. It logs each request as JSONL and replies from a fixtures file. |
| `run-workflow.mjs` | Starts the mock, imports the credential (only when it changed) and the workflow, runs `n8n execute`, and prints per-node outputs as JSON. |
| `smoke.workflow.json` / `smoke.fixtures.json` / `smoke.test.mjs` | Manual Trigger -> Code -> chainLlm + Anthropic model. The test passes when the mock's canned text comes out of the chain. |
| `step2.e2e.mjs` | Step 2 end to end: the real Watch Centro "Render WP blocks" code on a fixture writer post, then the fragment from `workflows/step2-extract-watches.json` verbatim. Six cases (multi-brand post, no watches, HTTP 500, prose-wrapped JSON, a reply starting with a thinking block, a reply cut off at max_tokens); each result is saved as `$E2E_N8N_HOME/e2e/step2-<case>.result.json`. |
| `step3.e2e.mjs` | Steps 2 + 3 end to end: the real "Render WP blocks" code, then `workflows/image-finder.json` verbatim (the harness rewrites only the Openverse and Commons base URLs to the mocks), then a check node reading `$('Fixture: Render WP blocks').item` from each pick item. Nine cases: (a) Openverse model-level hit with the real batch intervals, static data left untouched, (b) Openverse 429 on every request, (c) generic-only pick, (d) nothing passes, (e) cross-provider dedupe, (f) Commons pages against relevance order plus a Commons API error and a 503, (g) two posts in one execution, (h) recently used photo penalised (list read, not written), (i) a personality-restricted Commons file vetoes its Openverse copy. Asserts the exact query parameters and headers the mocks received. Results saved as `$E2E_N8N_HOME/e2e/step3-<case>.result.json`. About 2.5 to 3 min. |
| `mock-http.mjs` | Shared core of the HTTP mocks: JSONL request log, fixtures map, response specs, generated images under `/files/`. |
| `mock-openverse.mjs` | Mock of `api.openverse.org`: `GET /v1/images/`, `POST /v1/auth_tokens/token/` (client credentials), `POST /v1/auth_tokens/register/`, `GET /v1/rate_limit/`. Bodies and headers from `test/fixtures/openverse/`. |
| `mock-commons.mjs` | Mock of `commons.wikimedia.org/w/api.php` (`action=query&generator=search&prop=imageinfo`), with the Wikimedia edge User-Agent policy. Bodies and headers from `test/fixtures/commons/`. |
| `http-request.e2e.mjs` | HTTP Request 4.2 facts the step 3 nodes rely on (three runs): one item per input for 200/429/500/timeout/reset with `onError: continueRegularOutput`, the exact error item JSON, `neverError` + `fullResponse`, User-Agent, batching, `$('X').item` through error items, `$getWorkflowStaticData` persistence, OAuth2 client credentials (token on first use, refresh on 401), `retryOnFail`. Results saved as `$E2E_N8N_HOME/e2e/http-request-<case>.result.json`. |
| `../unit/mocks.test.mjs` | Fast checks (no n8n) that the mocks answer like the real APIs; part of `npm test`. |

## One-time setup (outside the repo)

n8n 2.42.x needs **Node >= 24**. Install both into a scratch folder:

```sh
S=/path/to/scratch
mkdir -p $S/node24 $S/n8n-v2
(cd $S/node24 && npm init -y >/dev/null && npm i node-linux-x64@24.21.0)            # Node 24 binary from npm
(cd $S/n8n-v2 && npm init -y >/dev/null && npm i n8n@2.42.5 --no-audit --no-fund)   # about 7 min, 2.9 GB
# if npm ran under Node 22, the isolated-vm build targets the wrong ABI: drop it and rebuild for 24
N24=$S/node24/node_modules/node-linux-x64
(cd $S/n8n-v2 && rm -rf node_modules/isolated-vm/build && \
  PATH=$N24/bin:$PATH npm_config_nodedir=$N24 npm rebuild isolated-vm cpu-features ssh2)
printf '#!/bin/sh\nexec "%s/bin/node" "%s/node_modules/n8n/bin/n8n" "$@"\n' $N24 $S/n8n-v2 > $S/n8n-v2/n8n.sh
chmod +x $S/n8n-v2/n8n.sh
```

## Run

```sh
export N8N_BIN=$S/n8n-v2/n8n.sh          # or N8N_BIN=.../n8n/bin/n8n plus N8N_NODE=$N24/bin/node
export E2E_N8N_HOME=$S/n8n-e2e-home      # n8n user folder: sqlite DB, logs, last workflow
npm run test:e2e                          # smoke + step 2 + HTTP Request facts + step 3 (about 4 to 5 min); skipped when N8N_BIN is unset

# ad hoc: a fragment with no trigger gets "E2E: manual trigger" -> "E2E: input" wired in front of it
node test/e2e/run-workflow.mjs --workflow workflows/step2-extract-watches.json \
  --input my-items.json --fixtures my-fixtures.json [--out result.json] [--full]
# with the HTTP mocks (each flag starts that mock and rewrites its base URL in HTTP Request nodes)
node test/e2e/run-workflow.mjs --workflow workflows/image-finder.json --input posts.json \
  --fixtures anthropic.json --openverse-fixtures ov.json --commons-fixtures cm.json
# mocks on their own (for poking with curl): prints MOCK_OPENVERSE_LISTENING http://127.0.0.1:18556
node test/e2e/mock-openverse.mjs --fixtures ov.json --log /tmp/ov.jsonl
node test/e2e/mock-commons.mjs --fixtures cm.json --log /tmp/cm.jsonl     # port 18557
```

The result has the shape `{ok, status, error, lastNodeExecuted, nodes: {"<name>": [{status, error, items, outputs}]}, steps, mock_requests, mocks, rewrites, logs}`.
Each `items` holds the json of main output 0. `outputs` holds every connection type, with `pairedItem`.
`mock_requests` holds every Anthropic API call, with the full body and the fixture it matched.
`mocks.<name>` is `{url, requests, log}` for each HTTP mock; `rewrites` counts the replaced base URLs.
In code, use `import { runWorkflow } from './run-workflow.mjs'`:

```js
const r = await runWorkflow({
  workflow: fragment,                       // object or path
  input: [{ ... }],                         // items for "E2E: input"
  fixtures: anthropicFixtures,              // mock-anthropic.mjs, as before
  mocks: {
    openverse: { fixtures: { 'Rolex Submariner': 'search-rolex-submariner.json', __default__: { status: 429 } } },
    commons: { fixtures: { 'Rolex Submariner': 'search-rolex-submariner.json' }, lagSeconds: 0 },
  },
  staticData: { global: { imageFinder: { recent: [] } } }, // seeded on import (replaces what the DB had)
  readStaticData: true,                     // r.staticData after the run (export:workflow, about 3 s)
  credentials: [ /* extra credentials; "{{mock:openverse}}" becomes the mock URL; forces a re-import */ ],
  env: { N8N_SSRF_PROTECTION_ENABLED: 'true' }, // extra env for every n8n command
});
r.mocks.openverse.requests  // [{n, ts, t_ms, mock, method, path, pathname, query, headers, body, key, matched, call_for_key, response, ...}]
```

## HTTP mocks (Openverse, Commons)

Both mocks log every request (method, path, parsed query, lower-cased headers, form body with the
client secret redacted, the fixture key it matched, the response sent, `t_ms` since start) to
`$E2E_N8N_HOME/e2e/mock-<name>.jsonl` and to `r.mocks.<name>.requests`.

Fixtures map (object or JSON file, re-read per request), keyed by the search text (Openverse `q`,
Commons `gsrsearch`). Keys are tried as: exact value, normalised value (lower case, single spaces),
for Commons the query without CirrusSearch keywords (`"Rolex Submariner filetype:bitmap"` matches the
key `"Rolex Submariner"`), `"re:<regex>"` keys, `"__default__"`, then a built-in empty result page.
A value is a response spec:

| Spec | Answer |
| --- | --- |
| `"search-rolex-submariner.json"` | that file from `test/fixtures/<provider>/`, with status and headers from its `manifest.json` |
| `{"fixture": "f.json", "status": 200, "headers": {}}` | the file, with overrides |
| `{"json": {...}, "status": 200}` / `{"raw": "text", "contentType": "text/html"}` | inline body |
| `{"status": 429}` | the provider's own error for that status. Openverse: 429 throttled (Retry-After 37, X-RateLimit-*), 500, 401, 400 fixtures. Commons: 429 Varnish bot page (Retry-After 11), 403 UA page, 5xx Wikimedia HTML error page |
| `"maxlag"` (Commons) | `error-maxlag.json`: HTTP 200, `MediaWiki-API-Error: maxlag`, `Retry-After: 5` |
| `{"sequence": [spec, spec]}` | nth call for that key gets the nth spec, the last one repeats |
| `{"hang": true}` / `{"reset": true}` | never answers (client timeout) / drops the connection (ECONNRESET) |

Any spec also takes `delay_ms`. A `"/files/<name>"` key overrides that file.

Built-in behaviour taken from the real services:

- Openverse: Bearer tokens must be ones the mock issued (else 401 "Incorrect authentication
  credentials."); `license` values are checked against the 10 Openverse codes (a space after a comma is
  a 400); `page_size` above 20 (anonymous) or 50 (token) is a 401; `GET /v1/images` redirects 301 to
  `/v1/images/`; records with `"mature": true` are dropped unless the request asks for sensitive
  results, and like the real API ANY non-empty `mature` value, `mature=false` included, asks for them;
  `extension=a,b` keeps only records whose URL's last dot segment is listed (the indexer's `get_extension`).
  Options: `burstLimit` (429 after N searches), `tokenMaxUses` (tokens expire after N uses, for
  refresh tests), `clients` (default `mock-openverse-client-id` / `mock-openverse-client-secret`),
  `tokens`, `tokenTtl`.
- Commons: the edge answers 403 text/plain without a User-Agent, or with a library default one
  (`axios/`, `python-requests/`, `java`, `go-`, ...) that has no contact info (e-mail or http(s) URL);
  `format` other than `json` gets an HTML page; a missing `gsrsearch` is `missingparam`; the recorded page
  set is cut to `gsrlimit` (by `index`, adding a `continue` block), and `imageinfo` to `prop`, `iiprop`
  and `iiextmetadatafilter`. Pages stay in database order; relevance is the `index` field. Options:
  `uaPolicy` (default true), `botLimit` (429 after N requests), `lagSeconds` (maxlag error whenever the
  request's `maxlag` is lower).
- Both: `GET /files/<anything>` returns a small valid image, JPEG (grey, baseline) or PNG (gradient)
  by extension, sized from `-<W>x<H>` or `/<W>px-` in the name or `?w=&h=`, else 1600x1067, so step 4
  can rewrite `https://upload.wikimedia.org/` or `https://live.staticflickr.com/` to
  `<mock>/files/<host>/`. `GET /__mock/requests` returns the log, `POST /__mock/reset` clears it.

## Fixtures

The file is a JSON object. Keys are marker strings, tried in file order against the request's system and message text:
`"M": "text"`, `{"text": ...}`, `{"json": {...}}` (stringified), `{"status": 500, "message": ...}`,
`{"raw": "<html>junk", "status": 200, "contentType": "text/html"}`, `{"sequence": [r1, r2]}` (the nth matching call gets the nth entry, and the last one repeats),
plus the optional `delay_ms`, `stop_reason` and `headers`. `"__default__"` is used when nothing matches.

## Gotchas (all verified on n8n 2.42.5)

- `node --test <directory>` does not search the directory on Node 22 and 24; it loads it as a module. `test/unit/index.js` imports every unit test so `node --test test/unit` works. For e2e, name the files (as `npm run test:e2e` does) or use a glob.
- chainLlm 1.9 output is `{text}`. With `onError: continueRegularOutput` a failed item becomes `{error: "<message>"}` with `pairedItem` kept, for example "The service was not able to process your request" for an HTTP 500.
- `retryOnFail` re-runs the whole node only when output item 0 has `json.error`. `maxTries` is clamped to 2..5 and the wait to 0..5000 ms (default 1000). The SDK makes no retries of its own.
- Literal `{`, `}` and `}}` in a chainLlm 1.9 prompt, and in values inserted with `{{ }}`, reach the API unchanged. Only `{{ ... }}` is evaluated.
- `structuredClone` is undefined in the Code-node sandbox. A SyntaxError in `jsCode` surfaces as a message that starts with `{} }; Object.getPrototypeOf = ...`.
- Runs that share an `E2E_N8N_HOME` are serialized by a lock file. Use separate homes to run in parallel. Each run takes about 10 s (import about 4 s, execute about 5 s), plus about 7 s for the first credential import and migrations.

## HTTP Request 4.2 facts (verified on n8n 2.42.5 by `http-request.e2e.mjs`)

- A JSON object response is ONE output item (only a top-level JSON array is split into items). Every
  input item gives exactly one output item, `pairedItem: {item: i}`, also for failures, and one failing
  item never stops the others when `onError` is `continueRegularOutput`.
- With the default response options, a failed request becomes `{error: <AxiosError.toJSON()>}`:
  HTTP 429 `{"error":{"message":"Try spacing your requests out using the batching settings under 'Options'","name":"AxiosError","stack":"AxiosError: Request failed with status code 429\n...","code":"ERR_BAD_REQUEST","status":429}}`;
  HTTP 500 `{"error":{"message":"500 - \"{\\n  \\\"detail\\\": \\\"An internal server error occurred.\\\"\\n}\"","name":"AxiosError","stack":"...","code":"ERR_BAD_RESPONSE","status":500}}`
  (message is `<status> - ` plus the body text JSON-stringified, HTML pages included);
  timeout `{"error":{"message":"timeout of 3000ms exceeded","name":"AxiosError","stack":"...","code":"ECONNABORTED"}}`;
  connection reset `{"error":{"message":"socket hang up","name":"Error","stack":"...","code":"ECONNRESET"}}`.
  `statusCode`, the response headers (Retry-After) and the parsed body are NOT in the item; for 429 the
  body is lost entirely. The `stack` holds local paths: never copy it into output.
- A MediaWiki API error (maxlag, cirrussearch-backend-error, ...) is HTTP 200, so it is a NORMAL item
  `{error: {code, info, ...}, servedby}`. It shares the `json.error` key with n8n's failure items;
  tell them apart by `error.info` (MediaWiki) versus `error.name` / `error.message` (n8n). Both have `code`.
- `options.response.response = {neverError: true, fullResponse: true}` turns every HTTP answer into
  `{body, headers, statusCode, statusMessage}` (body parsed when the content type is JSON; a text/html
  answer goes to `data` instead of `body`; header names lower-cased, `retry-after` included). Timeouts,
  resets and SSRF blocks still become `{error: ...}` items, so keep `onError: continueRegularOutput`.
- Batching `{batch: {batchSize: 1, batchInterval: N}}` starts item i about i*N ms after item 0; requests
  are not awaited one by one (a hanging request does not delay the next). `timeout` defaults to 300000 ms
  when unset (the UI shows 10000 as the default value only when the option is added).
- A query parameter whose expression evaluates to `undefined` is left out of the URL; commas are sent as
  `%2C`, `|` as `%7C`, spaces as `%20`.
- With no User-Agent header the node sends `n8n`. Default `accept` is
  `application/json,text/html,application/xhtml+xml,application/xml,text/*;q=0.9, image/*;q=0.8, */*;q=0.7`.
- `$('Node').item` inside a parameter follows `pairedItem` back through any number of nodes,
  error items included.
- `retryOnFail` re-runs the WHOLE node (every item requested again) and only when output item 0 has
  `json.error`; a failure on item 1+ is never retried. Leave it off on the search nodes.
- Generic credential `oAuth2Api` with grant type Client Credentials: the first request POSTs
  `grant_type=client_credentials&client_id=...&client_secret=...` (form body when the credential's
  Authentication is Body, HTTP Basic when Header) to the Access Token URL, stores the token in the
  credential, and sends `Authorization: Bearer <token>`. A 401 (the credential's "Token Expired Status
  Code") makes n8n fetch a new token and repeat that request once.
- SSRF protection is off by default (`N8N_SSRF_PROTECTION_ENABLED=false`). When on, 127.0.0.0/8 and the
  private ranges are blocked: the item becomes `{"error":{"level":"info","shouldReport":false,"description":"The target 127.0.0.1 is not allowed. ...","tags":{},"extra":{"ip":"127.0.0.1"},"name":"SsrfBlockedIpError","ip":"127.0.0.1"}}`
  (no `message` key) and the mock gets no request; `N8N_SSRF_ALLOWED_IP_RANGES=127.0.0.1/32` lets
  the mocks through. Public hosts such as api.openverse.org are not affected. Outbound requests honour
  `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`; the harness adds 127.0.0.1 and localhost to `NO_PROXY`,
  which is how every mock on 127.0.0.1 is reached.
- `$getWorkflowStaticData('global')` works in the 2.x Code node task runner; changes made there are
  returned to the main process and saved after the execution in every mode except `manual` (editor
  runs). `n8n execute` runs in mode `cli`, so the harness can check persistence. `import:workflow`
  keeps the stored staticData when the file has none, and replaces it when the file has one.
