#!/usr/bin/env node
// Zero-dependency mock of the Wikimedia Commons Action API (commons.wikimedia.org/w/api.php)
// for the step 3 e2e tests. Bodies and headers come from test/fixtures/commons/*.json and that
// folder's manifest.json (MediaWiki core ApiQuery/ApiQuerySearch/ApiQueryImageInfo/ApiMain,
// CommonsMetadata, Wikimedia edge rules from operations/puppet).
//
// Routes
//   GET|POST /w/api.php        action=query&generator=search&gsrsearch=...: fixture keyed by gsrsearch
//   GET|HEAD /files/<name>     generated JPEG/PNG (see mock-http.mjs), e.g. step 4 downloads
//   GET /__mock/requests, POST /__mock/reset
//
// What the mock does like production, before the fixture is used:
//   - Edge User-Agent policy (haproxy tls_terminator.cfg.erb + contact_info.lua): no User-Agent,
//     or a library-default one ("axios/...", "python-requests/...", "java", "go-", "okhttp/", ...)
//     without contact info (an e-mail address or an http(s) URL; a github/gitlab URL does not count)
//     -> 403 text/plain edge-403-ua-policy.txt. opts.uaPolicy=false turns this off.
//   - Optional edge bot limit: opts.botLimit = N answers the (N+1)th and later requests with the
//     Varnish 429 HTML page (edge-429-bot-ratelimit.html, Retry-After).
//   - format must be json; anything else gets the HTML help-style page the real API returns for
//     format=jsonfm/no format (so a missing format=json is visible in the test).
//   - Optional replication lag: opts.lagSeconds = L answers every request whose maxlag < L with
//     the maxlag error (HTTP 200, MediaWiki-API-Error: maxlag, Retry-After). Without maxlag in the
//     request there is no maxlag error, as in production.
//   - The fixture page set is cut to what the request asked for: gsrlimit (pages with index <=
//     gsroffset+gsrlimit, plus a continue block when more exist; order stays database order),
//     prop=imageinfo (no imageinfo without it), iiprop (size: size/width/height/pagecount/duration;
//     url: url/descriptionurl/descriptionshorturl and, with iiurlwidth, thumburl/thumbwidth/
//     thumbheight/responsiveUrls/thumbattribs; mime; extmetadata), iiextmetadatafilter (keeps only
//     the listed extmetadata keys). Thumb URLs are served as recorded (iiurlwidth=1920).
//
// Fixtures map keys are tried against gsrsearch: exact, normalised, then the query with the
// CirrusSearch keywords removed (`filetype:bitmap`, `-intitle:x`, `incategory:"y"` ...), so a test
// can key a response by the plain watch query ("Rolex Submariner"). Shortcuts: "maxlag" ->
// error-maxlag.json; {status: 429} -> edge-429-bot-ratelimit.html; {status: 403} -> the UA page;
// {status: 500|502|503|504} -> a Wikimedia-style HTML error page. Default: search-empty.json.
//
// CLI:  node mock-commons.mjs [--port 18557] [--fixtures f.json] [--log requests.jsonl]
//   prints "MOCK_COMMONS_LISTENING http://127.0.0.1:<port>" once ready.
// Module: import { startCommonsMock, REAL_BASE } from './mock-commons.mjs'

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startHttpMock, readManifest, cliArg } from './mock-http.mjs';

export const REAL_BASE = 'https://commons.wikimedia.org';
export const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/commons');

const LIBRARY_DEFAULT_UA =
  /^(python-requests|python\/[\d.]+ aiohttp\/[\d.]+|python-urllib|python-httpx|okhttp\/|java|apache-httpclient|go-|birdnet-go|guzzlehttp|axios)/i;
const FORGE_URL = /https?:\/\/(github\.com|gitlab\.com)/i;
const EMAIL = /[\w.+\-]+@[\w\-]*[a-z][\w\-]*\.[a-z][a-z]+/i;
const URL_RE = /https?:\/\/[\w\-/.%]+/i;
const WIKI_USER = /\(\w+:[\w-]+; [Uu]ser:[\w\s\-.()]+\)|\[\[[Uu]ser:[\w\s\-.()]+\]\]/;

/** Wikimedia edge UA policy. Returns null when allowed, else the reason. */
export function uaPolicyViolation(ua) {
  if (ua === undefined || ua === null) return 'ua_policy:none';
  const s = String(ua);
  const contact = EMAIL.test(s) || URL_RE.test(s) || WIKI_USER.test(s);
  if (LIBRARY_DEFAULT_UA.test(s) && (!contact || FORGE_URL.test(s))) return 'ua_policy:library_default';
  return null;
}

/** gsrsearch without CirrusSearch keywords and quotes: "Rolex Submariner filetype:bitmap" -> "rolex submariner". */
export function bareSearch(s) {
  return String(s ?? '')
    .replace(/-?\b[a-z]+:("[^"]*"|\S+)/gi, ' ')
    .replace(/"/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const DOCREF =
  'See https://commons.wikimedia.org/w/api.php for API usage. Subscribe to the mediawiki-api-announce mailing list at &lt;https://lists.wikimedia.org/postorius/lists/mediawiki-api-announce.lists.wikimedia.org/&gt; for notice of API deprecations and breaking changes.';

function apiError(code, info, extraHeaders = {}) {
  return {
    status: 200,
    json: { error: { code, info, docref: DOCREF }, servedby: 'mw-api-ext.eqiad.main-mock' },
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'MediaWiki-API-Error': code, ...extraHeaders },
  };
}

function edgeErrorPage(status) {
  const tpl = fs.readFileSync(path.join(FIXTURES_DIR, 'edge-429-bot-ratelimit.html'), 'utf8');
  const reason =
    status >= 500
      ? 'Our servers are currently under maintenance or experiencing a technical issue'
      : `Request failed with status ${status}`;
  const body = tpl
    .split('Your bot is making too many requests. Please reduce your request rate or contact bot-traffic@wikimedia.org (f263c81)')
    .join(reason)
    .replace('Error: 429,', `Error: ${status},`);
  return { status, raw: body, contentType: 'text/html; charset=utf-8', headers: {} };
}

const STATUS_DEFAULTS = {
  403: 'edge-403-ua-policy.txt',
  429: 'edge-429-bot-ratelimit.html',
  default: (status) => edgeErrorPage(status),
};

const SIZE_KEYS = ['size', 'width', 'height', 'pagecount', 'duration'];
const URL_KEYS = ['url', 'descriptionurl', 'descriptionshorturl'];
const THUMB_KEYS = ['thumburl', 'thumbwidth', 'thumbheight', 'thumbmime', 'responsiveUrls', 'thumbattribs', 'thumberror'];
const last = (v) => (Array.isArray(v) ? v[v.length - 1] : v);
const pipeList = (v) =>
  v === undefined || v === ''
    ? []
    : String(last(v))
        .split('|')
        .map((s) => s.trim())
        .filter(Boolean);

/** Cut a formatversion=2 query result down to what the request asked for. */
export function shapeResult(obj, query, entry = {}) {
  if (!obj || typeof obj !== 'object' || !obj.query || !Array.isArray(obj.query.pages)) return obj;
  const out = JSON.parse(JSON.stringify(obj));
  const pages = out.query.pages;
  const offset = Number(last(query.gsroffset) || 0);
  const limitRaw = last(query.gsrlimit);
  const limit = limitRaw === 'max' ? 500 : limitRaw === undefined ? 10 : Number(limitRaw); // ApiQuerySearch default 10
  if (Number.isFinite(limit) && limit > 0) {
    const maxIndex = Math.max(0, ...pages.map((p) => Number(p.index) || 0));
    out.query.pages = pages.filter((p) => !(Number(p.index) > offset + limit));
    if (maxIndex > offset + limit && !out.continue) {
      out.continue = { gsroffset: offset + limit, continue: 'gsroffset||' };
      entry.continued = true;
    }
  }
  const props = pipeList(query.prop);
  const iiprop = query.iiprop === undefined ? ['timestamp', 'user'] : pipeList(query.iiprop);
  const filter = pipeList(query.iiextmetadatafilter);
  const thumbs = last(query.iiurlwidth) !== undefined || last(query.iiurlheight) !== undefined;
  for (const p of out.query.pages) {
    if (!props.includes('imageinfo')) {
      delete p.imageinfo;
      delete p.imagerepository;
      continue;
    }
    for (const ii of p.imageinfo || []) {
      for (const k of Object.keys(ii)) {
        const keep =
          (SIZE_KEYS.includes(k) && (iiprop.includes('size') || iiprop.includes('dimensions'))) ||
          (URL_KEYS.includes(k) && iiprop.includes('url')) ||
          (THUMB_KEYS.includes(k) && iiprop.includes('url') && thumbs) ||
          (k === 'mime' && iiprop.includes('mime')) ||
          (k === 'extmetadata' && iiprop.includes('extmetadata')) ||
          ![...SIZE_KEYS, ...URL_KEYS, ...THUMB_KEYS, 'mime', 'extmetadata'].includes(k);
        if (!keep) delete ii[k];
      }
      if (ii.extmetadata && filter.length) {
        for (const k of Object.keys(ii.extmetadata)) if (!filter.includes(k)) delete ii.extmetadata[k];
      }
    }
  }
  return out;
}

/**
 * @param {{port?: number, host?: string, fixtures?: string|object, logFile?: string, quiet?: boolean,
 *          uaPolicy?: boolean, botLimit?: number, lagSeconds?: number, filesDir?: string}} opts
 */
export async function startCommonsMock(opts = {}) {
  const manifest = readManifest(FIXTURES_DIR);
  let count = 0;

  return startHttpMock({
    name: 'commons',
    port: opts.port,
    host: opts.host,
    logFile: opts.logFile,
    quiet: opts.quiet,
    fixtures: opts.fixtures,
    fixturesDir: FIXTURES_DIR,
    filesDir: opts.filesDir,
    manifest,
    async handle(ctx) {
      const { req, pathname, headers, entry } = ctx;
      // Edge first (HAProxy / Varnish), for every path.
      if (opts.uaPolicy !== false) {
        const why = uaPolicyViolation(headers['user-agent']);
        if (why) {
          entry.edge = why;
          return ctx.respond('edge-403-ua-policy.txt');
        }
      }
      count++;
      if (opts.botLimit !== undefined && count > opts.botLimit) {
        entry.edge = 'bot_ratelimit';
        return ctx.respond('edge-429-bot-ratelimit.html');
      }
      if (pathname !== '/w/api.php') {
        return ctx.respond({ status: 404, raw: 'Not Found', contentType: 'text/html; charset=utf-8' });
      }
      // GET query string, or a POSTed form (the Action API takes both).
      let query = ctx.query;
      if (req.method === 'POST' && ctx.body && typeof ctx.body === 'object') query = { ...query, ...ctx.body };
      const fmt = last(query.format);
      if (fmt !== 'json') {
        entry.warning = `format=${fmt ?? '(none)'}: the real API answers with an HTML page`;
        return ctx.respond({
          raw: '<!DOCTYPE html><html><head><title>MediaWiki API result - Wikimedia Commons</title></head><body><pre>This is the HTML representation of the JSON format.</pre></body></html>',
          contentType: 'text/html; charset=utf-8',
        });
      }
      const maxlag = last(query.maxlag);
      if (opts.lagSeconds !== undefined && maxlag !== undefined && Number(opts.lagSeconds) > Number(maxlag)) {
        const lag = Number(opts.lagSeconds);
        return ctx.respond(
          apiError('maxlag', `Waiting for 10.64.48.35: ${lag} seconds lagged.`, {
            'Retry-After': String(Math.max(Number(maxlag) || 0, 5)),
            'X-Database-Lag': String(Math.floor(lag)),
            'Cache-Control': 'private, must-revalidate, max-age=0',
          }),
        );
      }
      if (last(query.action) !== 'query') {
        return ctx.respond(apiError('badvalue', `Unrecognized value for parameter "action": ${last(query.action) ?? ''}.`));
      }
      if (last(query.generator) === 'search' && !last(query.gsrsearch)) {
        return ctx.respond(apiError('missingparam', 'The "gsrsearch" parameter must be set.'));
      }
      if (last(query.formatversion) !== '2') entry.warning = 'formatversion is not 2: fixtures are formatversion=2 shapes';
      const gsrsearch = last(query.gsrsearch) ?? '';
      const fixtures = ctx.fixtures;
      const resolveShortcut = (spec) => (spec === 'maxlag' ? 'error-maxlag.json' : spec);
      // "maxlag" shortcut inside a sequence or as the whole spec.
      for (const k of Object.keys(fixtures)) {
        const v = fixtures[k];
        if (v === 'maxlag') fixtures[k] = resolveShortcut(v);
        else if (v && Array.isArray(v.sequence)) fixtures[k] = { ...v, sequence: v.sequence.map(resolveShortcut) };
      }
      return ctx.respondFor(gsrsearch, {
        extraKeys: [bareSearch(gsrsearch)],
        defaultSpec: 'search-empty.json',
        statusDefaults: STATUS_DEFAULTS,
        transform: (obj, status) => (status === 200 && !obj.error ? shapeResult(obj, query, entry) : obj),
      });
    },
  });
}

const isMain =
  !process.env.NODE_TEST_CONTEXT && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const mock = await startCommonsMock({
    port: Number(cliArg('port') ?? process.env.MOCK_COMMONS_PORT ?? 18557),
    fixtures: cliArg('fixtures') ?? process.env.MOCK_COMMONS_FIXTURES,
    logFile: cliArg('log') ?? process.env.MOCK_COMMONS_LOG,
  });
  process.stdout.write(`MOCK_COMMONS_LISTENING ${mock.url}\n`);
  const stop = () => mock.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
