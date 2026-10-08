# End-to-end harness (real n8n 2.x + mock Anthropic API)

Runs a workflow, or a paste-format node fragment, inside a real local n8n CLI. The
`anthropicApi` credential `Fy3gBIA4bOXd96pw` ("Anthropic account") points at a local mock of the
Messages API, so the real `chainLlm` 1.9 and `lmChatAnthropic` 1.6 nodes run without a key or network.

| File | What it is |
| --- | --- |
| `mock-anthropic.mjs` | Zero-dependency mock: `POST /v1/messages` (JSON, or SSE when `stream: true`), `GET /v1/models[/id]`. It logs each request as JSONL and replies from a fixtures file. |
| `run-workflow.mjs` | Starts the mock, imports the credential (only when it changed) and the workflow, runs `n8n execute`, and prints per-node outputs as JSON. |
| `smoke.workflow.json` / `smoke.fixtures.json` / `smoke.test.mjs` | Manual Trigger -> Code -> chainLlm + Anthropic model. The test passes when the mock's canned text comes out of the chain. |
| `step2.e2e.mjs` | Step 2 end to end: the real Watch Centro "Render WP blocks" code on a fixture writer post, then the fragment from `workflows/step2-extract-watches.json` verbatim. Six cases (multi-brand post, no watches, HTTP 500, prose-wrapped JSON, a reply starting with a thinking block, a reply cut off at max_tokens); each result is saved as `$E2E_N8N_HOME/e2e/step2-<case>.result.json`. |

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
npm run test:e2e                          # smoke + step 2; skipped when N8N_BIN is unset

# ad hoc: a fragment with no trigger gets "E2E: manual trigger" -> "E2E: input" wired in front of it
node test/e2e/run-workflow.mjs --workflow workflows/step2-extract-watches.json \
  --input my-items.json --fixtures my-fixtures.json [--out result.json] [--full]
```

The result has the shape `{ok, status, error, lastNodeExecuted, nodes: {"<name>": [{status, error, items, outputs}]}, steps, mock_requests, logs}`.
Each `items` holds the json of main output 0. `outputs` holds every connection type, with `pairedItem`.
`mock_requests` holds every API call, with the full body and the fixture it matched.
In code, use `import { runWorkflow } from './run-workflow.mjs'`.

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
