#!/usr/bin/env node
// Zero-dependency mock of the Openverse API (api.openverse.org) for the step 3 e2e tests.
// Behaviour follows WordPress/openverse c815ba49 (api/api/serializers/media_serializers.py,
// api/api/views/oauth2_views.py, conf/urls, DRF exception handler); bodies and headers come
// from test/fixtures/openverse/*.json and that folder's manifest.json.
//
// Routes
//   GET|HEAD /v1/images/?q=...        search. Response chosen by the fixtures map, keyed by q.
//   GET      /v1/images?q=...         301 to /v1/images/?q=... (Django APPEND_SLASH)
//   POST     /v1/auth_tokens/token/   client_credentials token (form body or HTTP Basic client auth)
//   POST     /v1/auth_tokens/register/  201 with the register fixture
//   GET      /v1/rate_limit/          needs a Bearer token
//   GET|HEAD /files/<name>            generated JPEG/PNG (see mock-http.mjs)
//   GET /__mock/requests, POST /__mock/reset, POST /__mock/expire-tokens (every issued token -> 401 expired)
//
// Validation done like the real API, before the fixture is used:
//   - Authorization: Bearer <token> must be a token this mock issued (or listed in opts.tokens),
//     else 401 "Incorrect authentication credentials." (no rate-limit headers: auth runs first).
//   - license: comma separated, each one of the 10 Openverse codes, else 400 {detail:{license:[...]}}.
//   - page_size: 1..20 anonymous, 1..50 with a token; above that 401 "page_size may not exceed ..."
//     (NotAuthenticated), below 1 400. page * page_size above 240 -> 401 "pagination depth ...".
//   - mature and unstable__include_sensitive_results together -> 400.
//   - Sensitive results: records with "mature": true are removed from the page unless the request
//     asks for sensitive results. The API decides that with
//     `self.initial_data.get("mature") or value`, so ANY non-empty mature value, including
//     "mature=false", turns sensitive results ON (the raw string "false" is truthy). The mock does
//     the same and records it as entry.sensitive_included.
//   - extension: records whose URL's last dot segment (lower-cased; none when it holds "/") is not in
//     the comma list are removed, like the ES terms filter on the indexer's URL-derived "extension".
//   - Optional throttling: opts.burstLimit = N answers the (N+1)th and later searches with the 429
//     fixture (Retry-After, X-RateLimit-* headers), as the anon_burst throttle does.
//   - Token expiry: opts.tokenMaxUses = N makes every issued token "expired" after N authenticated
//     calls (401 invalid_token "The access token has expired."), to exercise a client's refresh.
//
// Fixture specs: see mock-http.mjs. Status shortcuts: {status: 429} -> error-429-throttled.json
// (with its headers), 500 -> error-500.json, 401 -> error-401-invalid-token.json,
// 400 -> error-400-invalid-license.json. Default (no key matched, no __default__): search-empty.json.
//
// CLI:  node mock-openverse.mjs [--port 18556] [--fixtures f.json] [--log requests.jsonl]
//   prints "MOCK_OPENVERSE_LISTENING http://127.0.0.1:<port>" once ready.
// Module: import { startOpenverseMock, REAL_BASE } from './mock-openverse.mjs'

import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startHttpMock, sendJson, readManifest, cliArg } from './mock-http.mjs';

export const REAL_BASE = 'https://api.openverse.org';
export const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/openverse');
export const DEFAULT_CLIENT = { client_id: 'mock-openverse-client-id', client_secret: 'mock-openverse-client-secret' };

// api/api/constants/licenses.py ALL_LICENSES
export const ALL_LICENSES = ['by', 'by-sa', 'by-nd', 'by-nc', 'by-nc-sa', 'by-nc-nd', 'cc0', 'pdm', 'sampling+', 'nc-sampling+'];

const STATUS_DEFAULTS = {
  400: 'error-400-invalid-license.json',
  401: 'error-401-invalid-token.json',
  429: 'error-429-throttled.json',
  500: 'error-500.json',
  default: (status) => ({ json: { detail: `mock error ${status}` } }),
};

const truthy = (v) => /^(1|true|t|yes|y|on)$/i.test(String(v ?? ''));
const BOOL_VALUES = /^(1|0|true|false|t|f|yes|no|y|n|on|off)$/i;
const last = (v) => (Array.isArray(v) ? v[v.length - 1] : v);

/**
 * @param {{port?: number, host?: string, fixtures?: string|object, logFile?: string, quiet?: boolean,
 *          clients?: {client_id: string, client_secret: string}[], tokens?: string[],
 *          burstLimit?: number, tokenTtl?: number, tokenMaxUses?: number, filesDir?: string}} opts
 */
export async function startOpenverseMock(opts = {}) {
  const manifest = readManifest(FIXTURES_DIR);
  const clients = opts.clients || [DEFAULT_CLIENT];
  const tokens = new Map(); // token -> {client_id, expired}
  for (const t of opts.tokens || []) tokens.set(t, { client_id: 'preset', expired: false });
  let searches = 0;
  const anonHeaders = { ...(manifest.anonymous_200_headers || { 'Content-Type': 'application/json' }) };
  delete anonHeaders['Content-Type'];
  const authHeaders = {
    Vary: 'Accept-Encoding, Accept, Authorization, origin',
    Allow: 'GET, HEAD, OPTIONS',
    'X-RateLimit-Limit-oauth2_client_credentials_burst': '100/min',
    'X-RateLimit-Available-oauth2_client_credentials_burst': '99',
    'X-RateLimit-Limit-oauth2_client_credentials_sustained': '10000/day',
    'X-RateLimit-Available-oauth2_client_credentials_sustained': '9990',
  };

  const bearer = (headers) => {
    const m = /^Bearer\s+(.+)$/i.exec(headers.authorization || '');
    return m ? m[1].trim() : null;
  };

  // DRF authentication (OAuth2Authentication): returns null for anonymous, 'ok', or an error spec.
  const authenticate = (headers) => {
    const raw = headers.authorization;
    if (!raw) return null;
    const tok = bearer(headers);
    const info = tok ? tokens.get(tok) : null;
    if (info && !info.expired && opts.tokenMaxUses !== undefined && info.uses >= opts.tokenMaxUses) info.expired = true;
    if (info && !info.expired) {
      info.uses = (info.uses || 0) + 1;
      return 'ok';
    }
    const why = info && info.expired ? 'The access token has expired.' : 'The access token is invalid.';
    return {
      fixture: 'error-401-invalid-token.json',
      headers: { 'WWW-Authenticate': `Bearer realm="api",error="invalid_token",error_description="${why}"` },
    };
  };

  async function search(ctx) {
    const { query, headers, entry } = ctx;
    const auth = authenticate(headers);
    entry.auth = auth === null ? 'anonymous' : auth === 'ok' ? 'token' : 'rejected';
    if (auth && auth !== 'ok') return ctx.respond(auth);
    const authed = auth === 'ok';

    // Request validation (MediaSearchRequestSerializer), in DRF field order.
    const errors = {};
    const pageSizeRaw = last(query.page_size);
    const pageRaw = last(query.page);
    const pageSize = pageSizeRaw === undefined || pageSizeRaw === '' ? 20 : Number(pageSizeRaw);
    const page = pageRaw === undefined || pageRaw === '' ? 1 : Number(pageRaw);
    const maxPage = authed ? 50 : 20;
    const level = authed ? 'authenticated' : 'anonymous';
    if (!Number.isInteger(pageSize)) errors.page_size = ['A valid integer is required.'];
    else if (pageSize < 1) errors.page_size = ['Ensure this value is greater than or equal to 1.'];
    else if (pageSize > maxPage) {
      return ctx.respond({
        status: 401,
        json: { detail: `page_size may not exceed ${maxPage} for ${level} requests` },
        headers: { 'WWW-Authenticate': 'Bearer realm="api"', ...(authed ? {} : anonHeaders) },
      });
    }
    if (!Number.isInteger(page)) errors.page = ['A valid integer is required.'];
    else if (page < 1) errors.page = ['Ensure this value is greater than or equal to 1.'];
    const license = last(query.license);
    if (license !== undefined && license !== '') {
      for (const l of String(license).toLowerCase().split(',')) {
        if (!ALL_LICENSES.includes(l)) {
          errors.license = [`License '${l}' does not exist.`];
          break;
        }
      }
    }
    for (const f of ['filter_dead', 'mature', 'unstable__include_sensitive_results']) {
      const v = last(query[f]);
      if (v !== undefined && v !== '' && !BOOL_VALUES.test(v)) errors[f] = ['Must be a valid boolean.'];
    }
    if (query.mature !== undefined && query.unstable__include_sensitive_results !== undefined) {
      errors.unstable__include_sensitive_results = [
        '`mature` and `unstable__include_sensitive_results` must not both be defined.',
      ];
    }
    if (!errors.page_size && !errors.page && page * pageSize > 240) {
      return ctx.respond({
        status: 401,
        json: { detail: `pagination depth may not exceed 240 for ${level} requests` },
        headers: { 'WWW-Authenticate': 'Bearer realm="api"' },
      });
    }
    if (Object.keys(errors).length) {
      entry.validation_errors = errors;
      return ctx.respond({ status: 400, json: { detail: errors } });
    }

    // `self.initial_data.get("mature") or value`: any non-empty mature string counts.
    const matureRaw = last(query.mature);
    const includeSensitive = (matureRaw !== undefined && matureRaw !== '') || truthy(last(query.unstable__include_sensitive_results));
    entry.sensitive_included = includeSensitive;

    searches++;
    if (opts.burstLimit !== undefined && searches > opts.burstLimit) {
      entry.throttled = true;
      return ctx.respond('error-429-throttled.json');
    }

    const q = last(query.q) ?? '';
    return ctx.respondFor(q, {
      defaultSpec: 'search-empty.json',
      statusDefaults: STATUS_DEFAULTS,
      // Registered apps see the oauth2_client_credentials_* rate-limit headers instead of anon_*.
      headerTransform: (h, status) => {
        if (!authed || status !== 200) return h;
        const out = {};
        for (const [k, v] of Object.entries(h)) if (!/^X-RateLimit-|^Vary$|^Allow$/i.test(k)) out[k] = v;
        return { ...out, ...authHeaders };
      },
      transform: (obj, status) => {
        if (status !== 200 || !obj || !Array.isArray(obj.results)) return obj;
        let results = obj.results;
        if (!includeSensitive) results = results.filter((r) => r.mature !== true);
        const removed = obj.results.length - results.length;
        // extension filter: a terms filter on the ES "extension" keyword, which the indexer derives from
        // the URL (Image.get_extension: url.split(".")[-1].lower(), None when it contains "/").
        const extRaw = last(query.extension);
        if (extRaw !== undefined && extRaw !== '') {
          const wanted = String(extRaw).toLowerCase().split(',');
          const before = results.length;
          results = results.filter((r) => {
            const e = String(r.url || '').split('.').pop().toLowerCase();
            return e && !e.includes('/') && wanted.includes(e);
          });
          if (before !== results.length) entry.extension_removed = before - results.length;
        }
        results = results.slice(0, pageSize);
        if (removed) entry.sensitive_removed = removed;
        return {
          ...obj,
          result_count: Math.max(0, (obj.result_count ?? results.length) - removed - (entry.extension_removed || 0)),
          page_size: pageSize,
          page,
          results,
        };
      },
    });
  }

  function token(ctx) {
    const { headers, rawBody, entry } = ctx;
    const form = new URLSearchParams(rawBody || '');
    let clientId = form.get('client_id');
    let clientSecret = form.get('client_secret');
    const basic = /^Basic\s+(.+)$/i.exec(headers.authorization || '');
    if (basic) {
      const [u, p] = Buffer.from(basic[1], 'base64').toString('utf8').split(':');
      clientId = decodeURIComponent(u || '');
      clientSecret = decodeURIComponent(p || '');
      entry.client_auth = 'basic';
    } else entry.client_auth = 'body';
    entry.grant_type = form.get('grant_type');
    if (form.get('grant_type') !== 'client_credentials') {
      return ctx.respond({
        status: 400,
        json: form.get('grant_type') ? { error: 'unsupported_grant_type' } : { error: 'invalid_request', error_description: 'Missing grant type.' },
      });
    }
    const client = clients.find((c) => c.client_id === clientId && c.client_secret === clientSecret);
    if (!client) return ctx.respond('auth-token-401-invalid-client.json');
    const accessToken = crypto.randomBytes(15).toString('base64url');
    tokens.set(accessToken, { client_id: clientId, expired: false });
    entry.issued_token = accessToken;
    return ctx.respond({
      json: { access_token: accessToken, expires_in: opts.tokenTtl ?? 43200, token_type: 'Bearer', scope: 'read write' },
    });
  }

  return startHttpMock({
    name: 'openverse',
    port: opts.port,
    host: opts.host,
    logFile: opts.logFile,
    quiet: opts.quiet,
    fixtures: opts.fixtures,
    fixturesDir: FIXTURES_DIR,
    filesDir: opts.filesDir,
    manifest,
    async handle(ctx) {
      const { req, res, pathname, url, entry } = ctx;
      const m = req.method;
      if (m === 'POST' && pathname === '/__mock/expire-tokens') {
        for (const v of tokens.values()) v.expired = true;
        return sendJson(res, 200, { ok: true, expired: tokens.size });
      }
      if ((m === 'GET' || m === 'HEAD') && pathname === '/v1/images') {
        entry.response = { status: 301, kind: 'append_slash' };
        ctx.log();
        res.writeHead(301, { location: `/v1/images/${url.search}`, 'content-length': 0 });
        return res.end();
      }
      if ((m === 'GET' || m === 'HEAD') && pathname === '/v1/images/') {
        await search(ctx);
        return;
      }
      if (pathname === '/v1/images/') {
        return ctx.respond({ status: 405, json: { detail: `Method "${m}" not allowed.` }, headers: { Allow: 'GET, HEAD, OPTIONS' } });
      }
      if (pathname === '/v1/auth_tokens/token/') {
        if (m !== 'POST') return ctx.respond({ status: 405, json: { detail: `Method "${m}" not allowed.` } });
        return token(ctx);
      }
      if (m === 'POST' && pathname === '/v1/auth_tokens/register/') return ctx.respond('auth-register-201.json');
      if (m === 'GET' && pathname === '/v1/rate_limit/') {
        const auth = authenticate(ctx.headers);
        if (auth === null) return ctx.respond({ status: 401, json: { detail: 'Authentication credentials were not provided.' } });
        if (auth !== 'ok') return ctx.respond(auth);
        return ctx.respond('rate-limit-200.json');
      }
      return ctx.respond({ status: 404, json: { detail: 'Not found.' } });
    },
  });
}

const isMain =
  !process.env.NODE_TEST_CONTEXT && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const mock = await startOpenverseMock({
    port: Number(cliArg('port') ?? process.env.MOCK_OPENVERSE_PORT ?? 18556),
    fixtures: cliArg('fixtures') ?? process.env.MOCK_OPENVERSE_FIXTURES,
    logFile: cliArg('log') ?? process.env.MOCK_OPENVERSE_LOG,
  });
  process.stdout.write(`MOCK_OPENVERSE_LISTENING ${mock.url}\n`);
  const stop = () => mock.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
