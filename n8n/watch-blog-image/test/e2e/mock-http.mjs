// Shared core for the zero-dependency HTTP mocks used by the e2e tests
// (mock-openverse.mjs, mock-commons.mjs). It is not a server on its own: a provider
// module supplies `handle(ctx)` and a fixtures directory, and gets
//   - one JSONL log line per request: method, path, query, headers, body, the fixture key
//     it matched and the response it sent (also kept in memory as `mock.requests`),
//   - fixture resolution: a map keyed by the search text (Openverse `q`, Commons `gsrsearch`),
//   - response specs (see below), with status and headers taken from the provider's
//     fixtures manifest.json when a spec names a fixture file,
//   - GET/HEAD /files/<anything> serving a small, valid, generated JPEG or PNG (for step 4),
//   - GET /__mock/requests (the log) and POST /__mock/reset (clears the log and call counters).
//
// Fixtures map (object, or path to a JSON file re-read on every request). Keys are tried in
// this order: exact value, normalised value (lower case, single spaces), the provider's extra
// candidate keys (Commons: the query without CirrusSearch keywords), "re:<regex>" keys in file
// order, then "__default__", then the provider's built-in default (an empty result page).
// A response spec is one of:
//   "search-rolex-submariner.json"            fixture file from the provider's fixtures directory
//   { "fixture": "f.json", "status"?, "headers"?, "delay_ms"? }   file with overrides
//   { "json": {...}, "status"?: 200, "headers"? }
//   { "raw": "text", "status"?: 200, "contentType"?: "text/plain", "headers"? }
//   { "status": 429 }                         the provider's own error body and headers for that status
//   { "sequence": [spec, spec, ...] }         nth call for this key gets the nth spec (last repeats)
//   { "hang": true }                          accept the request and never answer (client timeout)
//   { "reset": true }                         destroy the socket without answering (ECONNRESET)
// Any spec can also carry "delay_ms". Keys starting with "__" other than "__default__" are ignored,
// except "/files/<name>" keys, which override the generated file for that path.
//
// Module: import { startHttpMock, makeJpeg, makePng } from './mock-http.mjs'

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// ---------------------------------------------------------------------------------------------
// Generated images (step 4 downloads them): valid files of any size, a few hundred bytes to a few KB.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** RGB PNG, width x height, a horizontal gradient (so it is not a flat colour). */
export function makePng(width = 1600, height = 1067) {
  const w = Math.max(1, Math.min(8000, width | 0));
  const h = Math.max(1, Math.min(8000, height | 0));
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) {
    const v = Math.round((x / Math.max(1, w - 1)) * 200) + 30;
    row[1 + x * 3] = v;
    row[2 + x * 3] = 90;
    row[3 + x * 3] = 255 - v;
  }
  const raw = Buffer.alloc(row.length * h);
  for (let y = 0; y < h; y++) row.copy(raw, y * row.length);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Baseline grayscale JFIF JPEG, width x height, one flat grey (value 160). Every 8x8 block is
 * DC-only, so the entropy data is 2 bits per block: 1600x1067 is about 7 KB. Decodes in libjpeg,
 * browsers, Pillow and ImageMagick.
 */
export function makeJpeg(width = 1600, height = 1067) {
  const w = Math.max(1, Math.min(8000, width | 0));
  const h = Math.max(1, Math.min(8000, height | 0));
  const seg = (marker, body) => {
    const len = Buffer.alloc(2);
    len.writeUInt16BE(body.length + 2);
    return Buffer.concat([Buffer.from([0xff, marker]), len, body]);
  };
  const app0 = seg(0xe0, Buffer.from([0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]));
  const dqt = seg(0xdb, Buffer.concat([Buffer.from([0x00]), Buffer.alloc(64, 1)]));
  const sof = seg(0xc0, Buffer.from([8, h >> 8, h & 0xff, w >> 8, w & 0xff, 1, 1, 0x11, 0]));
  // DC table 0: category 0 -> "0", category 9 -> "10". AC table 0: EOB (0x00) -> "0".
  const dcCounts = Buffer.alloc(16);
  dcCounts[0] = 1;
  dcCounts[1] = 1;
  const dht = seg(0xc4, Buffer.concat([Buffer.from([0x00]), dcCounts, Buffer.from([0x00, 0x09])]));
  const acCounts = Buffer.alloc(16);
  acCounts[0] = 1;
  const dhtAc = seg(0xc4, Buffer.concat([Buffer.from([0x10]), acCounts, Buffer.from([0x00])]));
  const sos = seg(0xda, Buffer.from([1, 1, 0x00, 0, 63, 0]));
  // First block: DC diff +256 (grey 160: 8 * (160 - 128)), category 9: "10" + "100000000", then EOB "0".
  // Every other block: DC diff 0 "0", EOB "0".
  const blocks = Math.ceil(w / 8) * Math.ceil(h / 8);
  const bits = ['10', '100000000', '0'];
  const totalBits = 12 + (blocks - 1) * 2;
  const out = Buffer.alloc(Math.ceil(totalBits / 8) * 2 + 2);
  let o = 0;
  let acc = 0;
  let n = 0;
  const pushBit = (b) => {
    acc = (acc << 1) | b;
    n++;
    if (n === 8) {
      out[o++] = acc;
      if (acc === 0xff) out[o++] = 0x00; // byte stuffing
      acc = 0;
      n = 0;
    }
  };
  for (const s of bits) for (const ch of s) pushBit(ch === '1' ? 1 : 0);
  for (let i = 1; i < blocks; i++) {
    pushBit(0);
    pushBit(0);
  }
  while (n !== 0) pushBit(1); // pad the last byte with 1 bits
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app0,
    dqt,
    sof,
    dht,
    dhtAc,
    sos,
    out.subarray(0, o),
    Buffer.from([0xff, 0xd9]),
  ]);
}

const IMAGE_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };

// "/files/a/b/Rolex_x-2000x1333.jpg", ".../1920px-Name.jpg", "...?w=1200&h=800": the size, else 1600x1067.
export function imageSizeFromPath(p, query = {}) {
  const qw = Number(query.w || query.width);
  const qh = Number(query.h || query.height);
  if (qw > 0 && qh > 0) return [qw, qh];
  const m = /(\d{2,4})x(\d{2,4})(?=\.[a-z]+$|[^0-9]*$)/i.exec(p);
  if (m) return [Number(m[1]), Number(m[2])];
  const px = /\/(\d{2,4})px-[^/]*$/.exec(p);
  if (px) return [Number(px[1]), Math.round((Number(px[1]) * 2) / 3)];
  return [1600, 1067];
}

// ---------------------------------------------------------------------------------------------
// Fixtures

export function normKey(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function loadFixtures(fixtures) {
  if (!fixtures) return {};
  if (typeof fixtures === 'object') return fixtures;
  try {
    return JSON.parse(fs.readFileSync(fixtures, 'utf8'));
  } catch (err) {
    process.stderr.write(`[mock-http] cannot read fixtures ${fixtures}: ${err.message}\n`);
    return {};
  }
}

/**
 * Find the spec for a request key. Returns {key, spec} (key '(builtin default)' when nothing matched).
 * @param {object} fixtures
 * @param {string} value          the raw key value from the request (q, gsrsearch)
 * @param {string[]} [extra]      further candidate keys, tried after the exact and normalised value
 */
export function resolveSpec(fixtures, value, extra = []) {
  const keys = Object.keys(fixtures).filter((k) => !k.startsWith('__') && !k.startsWith('/files/'));
  const candidates = [String(value ?? ''), normKey(value), ...extra.map(normKey)];
  for (const c of candidates) {
    if (Object.hasOwn(fixtures, c) && !c.startsWith('re:')) return { key: c, spec: fixtures[c] };
    const hit = keys.find((k) => !k.startsWith('re:') && normKey(k) === c);
    if (hit !== undefined) return { key: hit, spec: fixtures[hit] };
  }
  for (const k of keys) {
    if (!k.startsWith('re:')) continue;
    try {
      if (new RegExp(k.slice(3), 'i').test(String(value ?? ''))) return { key: k, spec: fixtures[k] };
    } catch {
      /* bad regex: skip */
    }
  }
  if (Object.hasOwn(fixtures, '__default__')) return { key: '__default__', spec: fixtures.__default__ };
  return { key: '(builtin default)', spec: undefined };
}

// ---------------------------------------------------------------------------------------------
// Responses

export function sendJson(res, status, obj, headers = {}) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(res.req && res.req.method === 'HEAD' ? undefined : body);
}

export function sendRaw(res, status, body, contentType = 'text/plain', headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, { 'content-type': contentType, 'content-length': buf.length, ...headers });
  res.end(res.req && res.req.method === 'HEAD' ? undefined : buf);
}

function lowerHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) out[k.toLowerCase()] = v;
  return out;
}

function queryObject(searchParams) {
  const q = {};
  for (const [k, v] of searchParams) {
    if (Object.hasOwn(q, k)) q[k] = [].concat(q[k], v);
    else q[k] = v;
  }
  return q;
}

function loggedHeaders(headers) {
  const out = { ...headers };
  if (typeof out.authorization === 'string') {
    const [scheme, value = ''] = out.authorization.split(' ');
    out.authorization = /^basic$/i.test(scheme) ? `${scheme} <redacted>` : `${scheme} ${value}`;
  }
  delete out.connection;
  return out;
}

/**
 * Start a mock server.
 * @param {{name: string, port?: number, host?: string, logFile?: string, quiet?: boolean,
 *          fixtures?: string|object, fixturesDir?: string, manifest?: object,
 *          handle: (ctx: object) => Promise<void>|void}} opts
 * `handle(ctx)` gets {req, res, url, pathname, query, body, rawBody, headers, entry, fixtures(),
 *   respond(spec, {key, defaultSpec, statusDefaults}), log()} and must answer the request.
 * @returns {Promise<{name, url, port, requests: object[], close: () => Promise<void>}>}
 */
export function startHttpMock(opts) {
  const host = opts.host || '127.0.0.1';
  const requests = [];
  const hits = new Map();
  const started = Date.now();
  const sockets = new Set();
  let counter = 0;

  const log = (entry) => {
    requests.push(entry);
    if (opts.logFile) fs.appendFileSync(opts.logFile, JSON.stringify(entry) + '\n');
  };

  const manifestFor = (file) => (opts.manifest && opts.manifest.fixtures && opts.manifest.fixtures[file]) || null;
  const headersFor = (m) => {
    if (!m || !m.headers) return {};
    if (typeof m.headers === 'string') return { ...(opts.manifest[m.headers] || {}) };
    return { ...m.headers };
  };

  function readFixtureFile(file) {
    const p = path.resolve(opts.fixturesDir || '.', file);
    const body = fs.readFileSync(p);
    const m = manifestFor(file);
    const headers = headersFor(m);
    const ext = path.extname(file).toLowerCase();
    const ctype =
      headers['Content-Type'] ||
      headers['content-type'] ||
      (ext === '.json' ? 'application/json' : ext === '.html' ? 'text/html; charset=utf-8' : 'text/plain');
    delete headers['Content-Type'];
    delete headers['content-type'];
    return { body, status: (m && m.status) || 200, contentType: ctype, headers };
  }

  // Send a response spec. Returns a short description for the log.
  async function respond(res, entry, spec, { statusDefaults = {}, transform, headerTransform } = {}) {
    if (typeof spec === 'string') spec = { fixture: spec };
    if (!spec || typeof spec !== 'object') spec = { status: 404, json: { detail: 'mock: no spec' } };
    if (spec.delay_ms) await new Promise((r) => setTimeout(r, spec.delay_ms));
    const extraHeaders = spec.headers || {};
    if (spec.hang) {
      entry.response = { status: null, kind: 'hang' };
      log(entry);
      return; // never answered; the socket is destroyed on close()
    }
    if (spec.reset) {
      entry.response = { status: null, kind: 'reset' };
      log(entry);
      res.socket.destroy();
      return;
    }
    if (spec.fixture === undefined && spec.json === undefined && spec.raw === undefined && spec.status) {
      const def = statusDefaults[spec.status] || statusDefaults.default;
      if (typeof def === 'function') spec = { ...def(spec.status), ...spec };
      else if (def) spec = { ...(typeof def === 'string' ? { fixture: def } : def), status: spec.status, headers: spec.headers };
      else spec = { ...spec, json: { detail: `mock error ${spec.status}` } };
    }
    if (spec.fixture !== undefined) {
      const f = readFixtureFile(spec.fixture);
      let body = f.body;
      const status = spec.status || f.status;
      const isJson = /json/.test(f.contentType);
      if (isJson && transform) {
        const obj = transform(JSON.parse(body.toString('utf8')), status);
        body = Buffer.from(JSON.stringify(obj, null, 2));
      }
      entry.response = { status, kind: 'fixture', fixture: spec.fixture };
      log(entry);
      let hdrs = { ...f.headers, ...extraHeaders };
      if (headerTransform) hdrs = headerTransform(hdrs, status);
      return sendRaw(res, status, body, f.contentType, hdrs);
    }
    if (spec.json !== undefined) {
      const status = spec.status || 200;
      const obj = transform ? transform(JSON.parse(JSON.stringify(spec.json)), status) : spec.json;
      entry.response = { status, kind: 'json' };
      log(entry);
      return sendJson(res, status, obj, headerTransform ? headerTransform({ ...extraHeaders }, status) : extraHeaders);
    }
    const status = spec.status || 200;
    entry.response = { status, kind: 'raw' };
    log(entry);
    return sendRaw(res, status, spec.raw ?? '', spec.contentType || 'text/plain', extraHeaders);
  }

  function serveFile(res, entry, pathname, query, fixtures) {
    const name = decodeURIComponent(pathname.slice('/files/'.length));
    const override = fixtures[`/files/${name}`];
    if (override !== undefined) return respond(res, entry, override);
    const local = opts.filesDir ? path.resolve(opts.filesDir, name) : null;
    if (local && local.startsWith(path.resolve(opts.filesDir) + path.sep) && fs.existsSync(local)) {
      const ext = path.extname(local).slice(1).toLowerCase();
      entry.response = { status: 200, kind: 'file', file: name };
      log(entry);
      return sendRaw(res, 200, fs.readFileSync(local), IMAGE_TYPES[ext] || 'application/octet-stream');
    }
    const ext = (/\.([a-z0-9]+)$/i.exec(name) || [])[1]?.toLowerCase() || 'jpg';
    if (!IMAGE_TYPES[ext]) {
      entry.response = { status: 404, kind: 'file_missing' };
      log(entry);
      return sendRaw(res, 404, 'mock: only .jpg, .jpeg and .png files are generated', 'text/plain');
    }
    const [w, h] = imageSizeFromPath(name, query);
    const buf = ext === 'png' ? makePng(w, h) : makeJpeg(w, h);
    entry.response = { status: 200, kind: 'generated_image', width: w, height: h, bytes: buf.length };
    log(entry);
    return sendRaw(res, 200, buf, IMAGE_TYPES[ext], { 'cache-control': 'max-age=86400' });
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url, `http://${host}`);
      const pathname = url.pathname;
      const query = queryObject(url.searchParams);
      const headers = lowerHeaders(req.headers);
      let body = rawBody || undefined;
      if (rawBody && /application\/x-www-form-urlencoded/.test(headers['content-type'] || '')) {
        body = queryObject(new URLSearchParams(rawBody));
        if (body.client_secret) body.client_secret = '<redacted>';
      } else if (rawBody && /json/.test(headers['content-type'] || '')) {
        try {
          body = JSON.parse(rawBody);
        } catch {
          /* keep text */
        }
      }
      const entry = {
        n: ++counter,
        ts: new Date().toISOString(),
        t_ms: Date.now() - started,
        mock: opts.name,
        method: req.method,
        path: url.pathname + url.search,
        pathname,
        query,
        headers: loggedHeaders(headers),
        body,
      };
      const fixtures = loadFixtures(opts.fixtures);
      try {
        if (req.method === 'GET' && pathname === '/__mock/requests') return sendJson(res, 200, requests);
        if (req.method === 'POST' && pathname === '/__mock/reset') {
          requests.length = 0;
          hits.clear();
          return sendJson(res, 200, { ok: true });
        }
        if ((req.method === 'GET' || req.method === 'HEAD') && pathname.startsWith('/files/')) {
          return await serveFile(res, entry, pathname, query, fixtures);
        }
        const ctx = {
          req,
          res,
          url,
          pathname,
          query,
          headers,
          rawBody,
          body,
          entry,
          fixtures,
          // Resolve the spec for `value`, handle "sequence", and send it.
          respondFor: async (value, { extraKeys = [], defaultSpec, statusDefaults, transform, headerTransform } = {}) => {
            const { key, spec: found } = resolveSpec(fixtures, value, extraKeys);
            let spec = found === undefined ? defaultSpec : found;
            const nth = hits.get(key) || 0;
            hits.set(key, nth + 1);
            if (spec && typeof spec === 'object' && Array.isArray(spec.sequence)) {
              spec = spec.sequence[Math.min(nth, spec.sequence.length - 1)];
            }
            entry.key = String(value ?? '');
            entry.matched = key;
            entry.call_for_key = nth + 1;
            return respond(res, entry, spec, { statusDefaults, transform, headerTransform });
          },
          respond: (spec, o) => respond(res, entry, spec, o),
          log: () => log(entry),
        };
        await opts.handle(ctx);
      } catch (err) {
        entry.response = { status: 500, kind: 'mock_crash', error: String(err && err.stack) };
        log(entry);
        if (!res.headersSent) sendJson(res, 500, { detail: `mock crashed: ${err.message}` });
        else res.end();
      }
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => {
      const { port } = server.address();
      const url = `http://${host}:${port}`;
      if (!opts.quiet) process.stderr.write(`[mock-${opts.name}] listening on ${url}\n`);
      resolve({
        name: opts.name,
        url,
        port,
        requests,
        close: () =>
          new Promise((r) => {
            for (const s of sockets) s.destroy();
            server.close(() => r());
          }),
      });
    });
  });
}

/** Read a provider's fixtures manifest.json (or {} when missing). */
export function readManifest(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  } catch {
    return {};
  }
}

/** Tiny CLI helper shared by the provider modules. */
export function cliArg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}
