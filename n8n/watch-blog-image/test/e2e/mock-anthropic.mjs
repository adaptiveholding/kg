#!/usr/bin/env node
// Zero-dependency mock of the Anthropic Messages API, for running the real
// lmChatAnthropic node inside a local n8n against canned responses.
//
// Endpoints:
//   POST /v1/messages              JSON reply, or SSE when body.stream === true
//   POST /v1/messages/count_tokens rough estimate
//   GET  /v1/models                list (claude-haiku-5-5, claude-sonnet-5-5)
//   GET  /v1/models/:id            one model or 404 not_found_error
//   GET  /__mock/requests          everything logged so far (debug helper)
//
// Fixtures file (JSON object, re-read on every request, keys tried in file order):
//   "MARKER":     "plain reply text"                      -> assistant text
//   "MARKER":     { "text": "..." }                       -> assistant text
//   "MARKER":     { "json": { ... } }                     -> JSON.stringify'd assistant text
//   "MARKER":     { "status": 500, "message": "boom" }    -> Anthropic-style error body
//   "MARKER":     { "raw": "<html>garbage", "status": 200, "contentType": "text/html" }
//   "MARKER":     { "sequence": [ {...}, {...} ] }         -> nth matching call gets nth entry (last repeats)
//   "__default__": { ... }                                -> used when no marker matches
// A marker matches when it occurs anywhere in the request's system prompt or
// message text. Extra per-response options: delay_ms, stop_reason, headers.
//
// CLI:  node mock-anthropic.mjs [--port 18555] [--fixtures f.json] [--log requests.jsonl]
//   env fallbacks: MOCK_ANTHROPIC_PORT, MOCK_ANTHROPIC_HOST, MOCK_ANTHROPIC_FIXTURES, MOCK_ANTHROPIC_LOG
//   prints "MOCK_ANTHROPIC_LISTENING http://127.0.0.1:<port>" once ready.
// Module: import { startMock } from './mock-anthropic.mjs'

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MODELS = [
  { id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5' },
  { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' },
];

const ERROR_TYPES = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'not_found_error',
  413: 'request_too_large',
  429: 'rate_limit_error',
  500: 'api_error',
  529: 'overloaded_error',
};

const DEFAULT_REPLY = { text: 'MOCK: no fixture matched' };

function modelObject(m) {
  return { type: 'model', id: m.id, display_name: m.display_name, created_at: '2026-01-01T00:00:00Z' };
}

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === 'string' ? b : b && typeof b.text === 'string' ? b.text : ''))
      .join('\n');
  }
  return '';
}

// All prompt text in a Messages API request body (system + every message).
export function requestText(body) {
  if (!body || typeof body !== 'object') return '';
  const parts = [textOfContent(body.system)];
  for (const m of Array.isArray(body.messages) ? body.messages : []) parts.push(textOfContent(m && m.content));
  return parts.join('\n');
}

function loadFixtures(fixtures) {
  if (!fixtures) return {};
  if (typeof fixtures === 'object') return fixtures;
  try {
    return JSON.parse(fs.readFileSync(fixtures, 'utf8'));
  } catch (err) {
    process.stderr.write(`[mock-anthropic] cannot read fixtures ${fixtures}: ${err.message}\n`);
    return {};
  }
}

function normalizeReply(spec) {
  if (spec === undefined || spec === null) return { ...DEFAULT_REPLY };
  if (typeof spec === 'string') return { text: spec };
  if (typeof spec === 'object' && spec.json !== undefined && spec.text === undefined) {
    return { ...spec, text: JSON.stringify(spec.json) };
  }
  return spec;
}

function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'request-id': `req_mock_${Date.now()}`,
    ...headers,
  });
  res.end(body);
}

function sendError(res, status, message, headers = {}) {
  sendJson(res, status, { type: 'error', error: { type: ERROR_TYPES[status] || 'api_error', message } }, headers);
}

const approxTokens = (s) => Math.max(1, Math.ceil(String(s || '').length / 4));

function messageObject(id, model, text, stopReason, inputTokens) {
  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: approxTokens(text) },
  };
}

function sendSse(res, id, model, text, stopReason, inputTokens, headers = {}) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'request-id': `req_mock_${Date.now()}`,
    ...headers,
  });
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const start = messageObject(id, model, '', null, inputTokens);
  start.content = [];
  start.usage.output_tokens = 1;
  ev('message_start', { message: start });
  ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  ev('ping', {});
  const chunk = 40;
  for (let i = 0; i < text.length; i += chunk) {
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text.slice(i, i + chunk) } });
  }
  ev('content_block_stop', { index: 0 });
  ev('message_delta', {
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: approxTokens(text) },
  });
  ev('message_stop', {});
  res.end();
}

/**
 * Start the mock server.
 * @param {{port?: number, host?: string, fixtures?: string|object, logFile?: string, quiet?: boolean}} opts
 * @returns {Promise<{url: string, port: number, requests: object[], close: () => Promise<void>}>}
 */
export function startMock(opts = {}) {
  const host = opts.host || '127.0.0.1';
  const requests = [];
  const hits = new Map(); // marker -> number of matched calls so far
  let counter = 0;

  const log = (entry) => {
    requests.push(entry);
    if (opts.logFile) fs.appendFileSync(opts.logFile, JSON.stringify(entry) + '\n');
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      const url = new URL(req.url, `http://${host}`);
      const p = url.pathname.replace(/\/+$/, '');
      const entry = {
        n: ++counter,
        ts: new Date().toISOString(),
        method: req.method,
        path: url.pathname + url.search,
        headers: {
          'anthropic-version': req.headers['anthropic-version'],
          'anthropic-beta': req.headers['anthropic-beta'],
          'content-type': req.headers['content-type'],
          'user-agent': req.headers['user-agent'],
          'x-api-key': req.headers['x-api-key'] ? '<redacted>' : undefined,
        },
        body,
      };

      try {
        if (req.method === 'GET' && p === '/v1/models') {
          entry.response = { status: 200, kind: 'models' };
          log(entry);
          const data = MODELS.map(modelObject);
          return sendJson(res, 200, { data, has_more: false, first_id: data[0].id, last_id: data.at(-1).id });
        }
        if (req.method === 'GET' && p.startsWith('/v1/models/')) {
          const id = decodeURIComponent(p.slice('/v1/models/'.length));
          const m = MODELS.find((x) => x.id === id);
          entry.response = { status: m ? 200 : 404, kind: 'model' };
          log(entry);
          return m ? sendJson(res, 200, modelObject(m)) : sendError(res, 404, `model: ${id}`);
        }
        if (req.method === 'GET' && p === '/__mock/requests') {
          return sendJson(res, 200, requests);
        }
        if (req.method === 'POST' && p === '/v1/messages/count_tokens') {
          entry.response = { status: 200, kind: 'count_tokens' };
          log(entry);
          return sendJson(res, 200, { input_tokens: approxTokens(requestText(body)) });
        }
        if (req.method !== 'POST' || p !== '/v1/messages') {
          entry.response = { status: 404, kind: 'unknown_route' };
          log(entry);
          return sendError(res, 404, `mock: no route ${req.method} ${url.pathname}`);
        }

        // POST /v1/messages
        if (!body || typeof body !== 'object') {
          entry.response = { status: 400, kind: 'bad_json' };
          log(entry);
          return sendError(res, 400, 'mock: request body is not JSON');
        }
        const model = String(body.model || '');
        if (!MODELS.some((m) => m.id === model)) {
          entry.response = { status: 404, kind: 'unknown_model' };
          log(entry);
          return sendError(res, 404, `model: ${model}`);
        }

        const fixtures = loadFixtures(opts.fixtures);
        const text = requestText(body);
        let matched = '__default__';
        for (const key of Object.keys(fixtures)) {
          if (key.startsWith('__')) continue;
          if (text.includes(key)) {
            matched = key;
            break;
          }
        }
        let spec = fixtures[matched];
        if (matched === '__default__' && spec === undefined) matched = '(builtin default)';
        const nth = hits.get(matched) || 0;
        hits.set(matched, nth + 1);
        if (spec && typeof spec === 'object' && Array.isArray(spec.sequence)) {
          spec = spec.sequence[Math.min(nth, spec.sequence.length - 1)];
        }
        const reply = normalizeReply(spec);
        entry.matched = matched;
        entry.call_for_marker = nth + 1;

        if (reply.delay_ms) await new Promise((r) => setTimeout(r, reply.delay_ms));
        const headers = reply.headers || {};

        if (reply.raw !== undefined) {
          const status = reply.status || 200;
          entry.response = { status, kind: 'raw' };
          log(entry);
          res.writeHead(status, { 'content-type': reply.contentType || 'text/plain', ...headers });
          return res.end(String(reply.raw));
        }
        if (reply.status && reply.status >= 400) {
          entry.response = { status: reply.status, kind: 'error' };
          log(entry);
          return sendError(res, reply.status, reply.message || `mock error ${reply.status}`, headers);
        }

        const replyText = String(reply.text ?? '');
        const id = `msg_mock_${String(counter).padStart(6, '0')}`;
        const stop = reply.stop_reason || 'end_turn';
        const inTok = approxTokens(text);
        entry.response = { status: 200, kind: body.stream ? 'sse' : 'json', text: replyText };
        log(entry);
        if (body.stream === true) return sendSse(res, id, model, replyText, stop, inTok, headers);
        return sendJson(res, 200, messageObject(id, model, replyText, stop, inTok), headers);
      } catch (err) {
        entry.response = { status: 500, kind: 'mock_crash', error: String(err && err.stack) };
        log(entry);
        if (!res.headersSent) sendError(res, 500, `mock crashed: ${err.message}`);
        else res.end();
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 18555, host, () => {
      const { port } = server.address();
      const url = `http://${host}:${port}`;
      if (!opts.quiet) process.stderr.write(`[mock-anthropic] listening on ${url}\n`);
      resolve({
        url,
        port,
        requests,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function cliArg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

// NODE_TEST_CONTEXT: do not start a server when `node --test` picks this file up by pattern.
const isMain =
  !process.env.NODE_TEST_CONTEXT &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(cliArg('port') ?? process.env.MOCK_ANTHROPIC_PORT ?? 18555);
  const mock = await startMock({
    port,
    host: process.env.MOCK_ANTHROPIC_HOST || '127.0.0.1',
    fixtures: cliArg('fixtures') ?? process.env.MOCK_ANTHROPIC_FIXTURES,
    logFile: cliArg('log') ?? process.env.MOCK_ANTHROPIC_LOG,
  });
  process.stdout.write(`MOCK_ANTHROPIC_LISTENING ${mock.url}\n`);
  const stop = () => mock.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
