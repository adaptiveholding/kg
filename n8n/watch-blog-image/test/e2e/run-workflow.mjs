#!/usr/bin/env node
// Run a workflow (or a paste-format node fragment) headlessly in a REAL local
// n8n 2.x, with the Anthropic credential pointed at mock-anthropic.mjs, and
// print what every node produced as JSON.
//
//   N8N_BIN=/abs/path/to/n8n          (n8n 2.x needs Node >= 24; a wrapper script is fine)
//   [N8N_NODE=/abs/path/to/node24]    (optional: run N8N_BIN's JS entry with this node)
//   E2E_N8N_HOME=/abs/scratch/n8n-e2e-home \
//   node test/e2e/run-workflow.mjs --workflow test/e2e/smoke.workflow.json \
//        --fixtures test/e2e/smoke.fixtures.json [--input items.json] [--out result.json] [--full]
//
// --workflow  full export, or a fragment {nodes, connections}. A workflow without a
//             Manual Trigger gets "E2E: manual trigger" -> "E2E: input" (Code node
//             emitting --input) wired into every entry node of the fragment.
// --input     JSON array of item json objects (or {json} items) for "E2E: input".
// --fixtures  mock-anthropic fixtures file (see mock-anthropic.mjs).
// --openverse-fixtures f.json / --commons-fixtures f.json
//             start mock-openverse.mjs / mock-commons.mjs with that fixtures map and point
//             the workflow's HTTP Request nodes at them (see "HTTP mocks" below).
// --mocks m.json  {"openverse": {...startOpts}, "commons": {...}} (same as the `mocks` option).
// --full      also include the raw n8n run data in the result.
// Exit code 0 when n8n reports no workflow-level error, 1 otherwise, 3 on harness failure.
// Runs sharing one E2E_N8N_HOME are serialized with a lock file (one sqlite DB, one
// fixed workflow id); use separate homes to run in parallel.
//
// HTTP mocks (module option `mocks`): {openverse: true | {fixtures, burstLimit, clients, ...},
//   commons: true | {fixtures, uaPolicy, botLimit, lagSeconds, ...},
//   <other>: {start: async (opts) => ({url, requests, close}), rewrite: 'https://real.host'}}.
//   Each mock is started (preferred fixed port, else any free port) and every occurrence of its
//   real base URL ('https://api.openverse.org', 'https://commons.wikimedia.org', or `rewrite`)
//   in the string parameters of HTTP Request nodes is replaced by the mock URL before import
//   (`rewriteEverywhere: true` rewrites every node, Code included). `rewrite: false` skips it.
//   The result gets `mocks: {<name>: {url, requests, log}}`; `mock_requests` stays the
//   Anthropic mock's log, so step 2 callers are unchanged.
// Other module options: `credentials` (extra credentials to import, e.g. an oAuth2Api one;
//   "{{mock:<name>}}" in any string value becomes that mock's URL; given credentials force a
//   re-import every run because n8n writes OAuth tokens back into them), `staticData` (seeded
//   into the imported workflow), `readStaticData` (after the run, export the workflow and return
//   its staticData as `result.staticData`; `n8n execute` runs in mode "cli", which persists it),
//   `env` (extra environment variables for every n8n command, e.g. N8N_SSRF_PROTECTION_ENABLED).
//
// Module use: import { runWorkflow } from './run-workflow.mjs'

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock } from './mock-anthropic.mjs';
import { startOpenverseMock, REAL_BASE as OPENVERSE_BASE } from './mock-openverse.mjs';
import { startCommonsMock, REAL_BASE as COMMONS_BASE } from './mock-commons.mjs';

// Built-in HTTP mocks: name -> starter, real base URL to rewrite, preferred port.
export const HTTP_MOCKS = {
  openverse: { start: startOpenverseMock, rewrite: OPENVERSE_BASE, port: 18556 },
  commons: { start: startCommonsMock, rewrite: COMMONS_BASE, port: 18557 },
};

export const CREDENTIAL_ID = 'Fy3gBIA4bOXd96pw';
export const CREDENTIAL_NAME = 'Anthropic account';
export const WORKFLOW_ID = 'e2eWatchBlogImg1';
const ENCRYPTION_KEY = 'watch-blog-image-e2e-fixed-encryption-key';
const START_TYPES = ['n8n-nodes-base.manualTrigger', 'n8n-nodes-base.executeWorkflowTrigger'];

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function withNoProxy(value) {
  const parts = String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const h of ['127.0.0.1', 'localhost']) if (!parts.includes(h)) parts.push(h);
  return parts.join(',');
}

export function n8nEnv(home, extra = {}) {
  return {
    ...process.env,
    N8N_USER_FOLDER: home,
    DB_TYPE: 'sqlite',
    N8N_ENCRYPTION_KEY: ENCRYPTION_KEY,
    N8N_DIAGNOSTICS_ENABLED: 'false',
    N8N_VERSION_NOTIFICATIONS_ENABLED: 'false',
    N8N_PERSONALIZATION_ENABLED: 'false',
    N8N_TEMPLATES_ENABLED: 'false',
    N8N_COMMUNITY_PACKAGES_ENABLED: 'false',
    N8N_PYTHON_ENABLED: 'false',
    N8N_RUNNERS_MODE: 'internal',
    N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS: 'false',
    N8N_LOG_LEVEL: 'info', // `execute` prints the run data through logger.info
    N8N_LOG_OUTPUT: 'console',
    N8N_LOG_FORMAT: 'json', // one JSON object per line: easy to find the run data
    EXECUTIONS_DATA_SAVE_ON_SUCCESS: 'all',
    EXECUTIONS_DATA_SAVE_ON_ERROR: 'all',
    NO_COLOR: '1',
    NO_PROXY: withNoProxy(process.env.NO_PROXY),
    no_proxy: withNoProxy(process.env.no_proxy),
    ...extra,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// One run at a time per home directory (node --test runs files in parallel).
async function acquireLock(dir, timeoutMs) {
  const file = path.join(dir, 'run.lock');
  const started = Date.now();
  for (;;) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      return () => fs.rmSync(file, { force: true });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    let pid = 0;
    try {
      pid = Number(fs.readFileSync(file, 'utf8'));
    } catch {
      /* removed meanwhile */
    }
    if (pid && !pidAlive(pid)) {
      fs.rmSync(file, { force: true });
      continue;
    }
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${file} (held by pid ${pid})`);
    await sleep(500);
  }
}

function runN8n(bin, args, env, { timeoutMs = 300000, logFile } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const nodeBin = process.env.N8N_NODE;
    const child = nodeBin
      ? spawn(nodeBin, [bin, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let done = false;
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const finish = (code, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (logFile) {
        fs.appendFileSync(
          logFile,
          `\n===== n8n ${args.join(' ')} (exit ${code}${signal ? ' ' + signal : ''}, ${Date.now() - started} ms)\n` +
            `--- stdout\n${stdout}\n--- stderr\n${stderr}\n`,
        );
      }
      resolve({ code, signal, stdout, stderr, ms: Date.now() - started });
    };
    child.on('error', (err) => {
      stderr += `spawn ${nodeBin || bin} failed: ${err.message}\n`;
      finish(-1, null);
    });
    child.on('close', finish);
  });
}

// Each stdout line is a winston JSON record; collect their messages.
function logMessages(stdout) {
  const out = [];
  for (const line of stdout.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    try {
      const rec = JSON.parse(s);
      if (rec && typeof rec.message === 'string') out.push(rec);
    } catch {
      /* not a log record */
    }
  }
  return out;
}

function findRunData(stdout) {
  for (const rec of logMessages(stdout).reverse()) {
    const m = rec.message.trim();
    if (!m.startsWith('{')) continue;
    try {
      const data = JSON.parse(m);
      if (data && data.data && data.data.resultData) return data;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function isStartNode(n) {
  return START_TYPES.includes(n.type);
}

// Wrap a fragment so `n8n execute` can start it: trigger -> input Code node -> entry nodes.
export function prepareWorkflow(wf, inputItems) {
  const nodes = JSON.parse(JSON.stringify(wf.nodes || []));
  const connections = JSON.parse(JSON.stringify(wf.connections || {}));
  if (!nodes.some(isStartNode)) {
    const subNodes = new Set();
    const mainTargets = new Set();
    for (const [src, byType] of Object.entries(connections)) {
      for (const [type, outs] of Object.entries(byType || {})) {
        if (type !== 'main') subNodes.add(src);
        for (const out of outs || []) for (const c of out || []) if (type === 'main') mainTargets.add(c.node);
      }
    }
    const entries = nodes.filter(
      (n) => n.type !== 'n8n-nodes-base.stickyNote' && !subNodes.has(n.name) && !mainTargets.has(n.name),
    );
    const items = (inputItems ?? [{}]).map((it) => (it && typeof it === 'object' && 'json' in it ? it : { json: it }));
    const minX = Math.min(0, ...nodes.map((n) => (n.position ? n.position[0] : 0)));
    const y = entries[0]?.position?.[1] ?? 0;
    nodes.push(
      {
        id: 'e2e00000-0000-4000-8000-000000000001',
        name: 'E2E: manual trigger',
        type: 'n8n-nodes-base.manualTrigger',
        typeVersion: 1,
        position: [minX - 440, y],
        parameters: {},
      },
      {
        id: 'e2e00000-0000-4000-8000-000000000002',
        name: 'E2E: input',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [minX - 220, y],
        parameters: { jsCode: `return ${JSON.stringify(items)};` },
      },
    );
    connections['E2E: manual trigger'] = { main: [[{ node: 'E2E: input', type: 'main', index: 0 }]] };
    connections['E2E: input'] = { main: [entries.map((n) => ({ node: n.name, type: 'main', index: 0 }))] };
  }
  const out = {
    id: WORKFLOW_ID,
    name: wf.name || 'E2E run',
    active: false,
    nodes,
    connections,
    settings: { executionOrder: 'v1', ...(wf.settings || {}) },
    pinData: {},
  };
  if (wf.staticData !== undefined) out.staticData = wf.staticData;
  return out;
}

// Replace each real base URL with its mock URL in the string parameters of HTTP Request
// nodes (or of every node with `everywhere`). Returns the number of replacements.
export function rewriteBaseUrls(wf, map, { everywhere = false } = {}) {
  let count = 0;
  const walk = (v) => {
    if (typeof v === 'string') {
      let s = v;
      for (const [from, to] of Object.entries(map)) {
        if (s.includes(from)) {
          count += s.split(from).length - 1;
          s = s.split(from).join(to);
        }
      }
      return s;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = walk(x);
      return o;
    }
    return v;
  };
  for (const n of wf.nodes || []) {
    if (everywhere || n.type === 'n8n-nodes-base.httpRequest') n.parameters = walk(n.parameters || {});
  }
  return count;
}

// "{{mock:openverse}}" -> mock URL, in every string of a credential.
function fillMockPlaceholders(value, mocks) {
  if (typeof value === 'string') {
    return value.replace(/\{\{mock:([\w-]+)\}\}/g, (m, name) => (mocks[name] ? mocks[name].url : m));
  }
  if (Array.isArray(value)) return value.map((v) => fillMockPlaceholders(v, mocks));
  if (value && typeof value === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(value)) o[k] = fillMockPlaceholders(v, mocks);
    return o;
  }
  return value;
}

async function startHttpMocks(spec, work) {
  const started = {};
  try {
    for (const [name, raw] of Object.entries(spec || {})) {
      if (!raw) continue;
      const cfg = raw === true ? {} : { ...raw };
      const builtin = HTTP_MOCKS[name] || {};
      const start = cfg.start || builtin.start;
      if (typeof start !== 'function') throw new Error(`unknown mock "${name}" (no start function)`);
      const rewrite = cfg.rewrite === undefined ? builtin.rewrite : cfg.rewrite;
      const logFile = path.join(work, `mock-${name}.jsonl`);
      fs.writeFileSync(logFile, '');
      const { start: _s, rewrite: _r, ...startOpts } = cfg;
      let mock;
      try {
        mock = await start({ quiet: true, ...startOpts, port: cfg.port ?? builtin.port ?? 0, logFile });
      } catch {
        mock = await start({ quiet: true, ...startOpts, port: 0, logFile });
      }
      started[name] = { mock, rewrite, logFile };
    }
  } catch (err) {
    await Promise.all(Object.values(started).map((m) => m.mock.close()));
    throw err;
  }
  return started;
}

function summarize(run) {
  const resultData = run?.data?.resultData || {};
  const nodes = {};
  for (const [name, runs] of Object.entries(resultData.runData || {})) {
    nodes[name] = runs.map((r) => {
      const outputs = {};
      for (const [type, branches] of Object.entries(r.data || {})) {
        outputs[type] = (branches || []).map((b) =>
          (b || []).map((it) => {
            const o = { json: it.json };
            if (it.pairedItem !== undefined) o.pairedItem = it.pairedItem;
            if (it.error) o.error = it.error.message || String(it.error);
            return o;
          }),
        );
      }
      return {
        status: r.executionStatus,
        error: r.error ? { message: r.error.message, description: r.error.description ?? null } : null,
        executionTime: r.executionTime,
        items: (outputs.main?.[0] || []).map((it) => it.json), // first main output, json only
        outputs,
      };
    });
  }
  return {
    ok: !resultData.error,
    status: run?.status ?? null,
    error: resultData.error ? { message: resultData.error.message, node: resultData.error.node?.name ?? null } : null,
    lastNodeExecuted: resultData.lastNodeExecuted ?? null,
    nodes,
  };
}

/**
 * @param {{workflow: string|object, fixtures?: string|object, input?: object[]|string,
 *          n8nBin?: string, home?: string, mockPort?: number, full?: boolean, timeoutMs?: number,
 *          mocks?: object, rewriteEverywhere?: boolean, credentials?: object[],
 *          staticData?: object, readStaticData?: boolean, env?: Record<string, string>}} opts
 */
export async function runWorkflow(opts) {
  const n8nBin = opts.n8nBin || process.env.N8N_BIN || 'n8n';
  const home = path.resolve(opts.home || process.env.E2E_N8N_HOME || path.join(os.tmpdir(), 'watch-blog-image-n8n-e2e'));
  const work = path.join(home, 'e2e');
  fs.mkdirSync(work, { recursive: true });
  const release = await acquireLock(work, opts.lockTimeoutMs ?? 15 * 60000);
  try {
    return await runLocked(opts, n8nBin, work);
  } finally {
    release();
  }
}

async function runLocked(opts, n8nBin, work) {
  const home = path.dirname(work);
  const logFile = path.join(work, 'n8n-cli.log');
  fs.writeFileSync(logFile, '');
  const mockLog = path.join(work, 'mock-requests.jsonl');
  fs.writeFileSync(mockLog, '');

  const wf = typeof opts.workflow === 'string' ? JSON.parse(fs.readFileSync(opts.workflow, 'utf8')) : opts.workflow;
  const input = typeof opts.input === 'string' ? JSON.parse(fs.readFileSync(opts.input, 'utf8')) : opts.input;

  // Preferred fixed port keeps the stored credential valid between runs; fall back to any free port.
  const preferred = Number(opts.mockPort ?? process.env.MOCK_ANTHROPIC_PORT ?? 18555);
  let mock;
  try {
    mock = await startMock({ port: preferred, fixtures: opts.fixtures, logFile: mockLog, quiet: true });
  } catch {
    mock = await startMock({ port: 0, fixtures: opts.fixtures, logFile: mockLog, quiet: true });
  }
  let httpMocks = {};
  try {
    httpMocks = await startHttpMocks(opts.mocks, work);
  } catch (err) {
    await mock.close();
    throw err;
  }
  const mockUrls = Object.fromEntries(Object.entries(httpMocks).map(([k, v]) => [k, v.mock]));

  try {
    const env = n8nEnv(home, { N8N_RUNNERS_BROKER_PORT: String(await freePort()), ...(opts.env || {}) });
    const steps = [];

    // 1. Credential (plain `data` is encrypted by import:credentials; re-import only when it changes).
    const extraCreds = fillMockPlaceholders(opts.credentials || [], mockUrls);
    const cred = [
      {
        id: CREDENTIAL_ID,
        name: CREDENTIAL_NAME,
        type: 'anthropicApi',
        data: { apiKey: 'sk-ant-mock-e2e', url: mock.url },
      },
      ...extraCreds,
    ];
    const credFile = path.join(work, 'credential.json');
    const credJson = JSON.stringify(cred, null, 2);
    const credStamp = path.join(work, 'credential.imported');
    const dbFile = path.join(home, '.n8n', 'database.sqlite');
    const stamp = () => `${fs.existsSync(dbFile) ? fs.statSync(dbFile).ino : 'nodb'}\n${credJson}`; // new DB => re-import
    // Extra credentials are always re-imported: n8n writes OAuth2 tokens back into them.
    if (extraCreds.length || !fs.existsSync(credStamp) || fs.readFileSync(credStamp, 'utf8') !== stamp()) {
      fs.writeFileSync(credFile, credJson);
      const r = await runN8n(n8nBin, ['import:credentials', `--input=${credFile}`], env, { logFile });
      steps.push({ step: 'import:credentials', code: r.code, ms: r.ms });
      if (r.code !== 0 || !new RegExp(`Successfully imported ${cred.length} credential`).test(r.stdout)) {
        throw new Error(`import:credentials failed (exit ${r.code}); see ${logFile}`);
      }
      fs.writeFileSync(credStamp, extraCreds.length ? 'extra credentials: always re-import' : stamp());
    }

    // 2. Workflow (fixed id, overwritten on every import).
    const prepared = prepareWorkflow(opts.staticData !== undefined ? { ...wf, staticData: opts.staticData } : wf, input);
    const rewriteMap = {};
    for (const { mock: m, rewrite } of Object.values(httpMocks)) if (rewrite) rewriteMap[rewrite] = m.url;
    const rewrites = rewriteBaseUrls(prepared, rewriteMap, { everywhere: !!opts.rewriteEverywhere });
    const wfFile = path.join(work, 'workflow.json');
    fs.writeFileSync(wfFile, JSON.stringify(prepared, null, 2));
    const imp = await runN8n(n8nBin, ['import:workflow', `--input=${wfFile}`], env, { logFile });
    steps.push({ step: 'import:workflow', code: imp.code, ms: imp.ms });
    if (imp.code !== 0 || !/Successfully imported 1 workflow/.test(imp.stdout)) {
      throw new Error(`import:workflow failed (exit ${imp.code}); see ${logFile}`);
    }

    // 3. Execute.
    const ex = await runN8n(n8nBin, ['execute', `--id=${WORKFLOW_ID}`, '--rawOutput'], env, {
      logFile,
      timeoutMs: opts.timeoutMs ?? 300000,
    });
    steps.push({ step: 'execute', code: ex.code, ms: ex.ms });
    const run = findRunData(ex.stdout);
    if (!run) throw new Error(`no run data in \`n8n execute\` output (exit ${ex.code}); see ${logFile}`);

    const result = summarize(run);
    if (opts.readStaticData) {
      const exportFile = path.join(work, 'workflow.exported.json');
      fs.rmSync(exportFile, { force: true });
      const exp = await runN8n(n8nBin, ['export:workflow', `--id=${WORKFLOW_ID}`, `--output=${exportFile}`], env, { logFile });
      steps.push({ step: 'export:workflow', code: exp.code, ms: exp.ms });
      if (exp.code !== 0 || !fs.existsSync(exportFile)) throw new Error(`export:workflow failed (exit ${exp.code}); see ${logFile}`);
      const exported = JSON.parse(fs.readFileSync(exportFile, 'utf8'));
      const w = Array.isArray(exported) ? exported[0] : exported;
      let sd = w ? w.staticData : null;
      if (typeof sd === 'string') sd = JSON.parse(sd);
      result.staticData = sd ?? null;
    }
    result.steps = steps;
    result.mock_requests = mock.requests;
    result.mocks = Object.fromEntries(
      Object.entries(httpMocks).map(([k, v]) => [k, { url: v.mock.url, requests: v.mock.requests, log: v.logFile }]),
    );
    result.rewrites = rewrites;
    result.logs = {
      n8n: logFile,
      mock: mockLog,
      workflow: wfFile,
      mocks: Object.fromEntries(Object.entries(httpMocks).map(([k, v]) => [k, v.logFile])),
    };
    if (opts.full) result.run = run;
    return result;
  } finally {
    await mock.close();
    await Promise.all(Object.values(httpMocks).map((m) => m.mock.close()));
  }
}

function cliArg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

// NODE_TEST_CONTEXT: do not act as a CLI when `node --test` picks this file up by pattern.
const isMain =
  !process.env.NODE_TEST_CONTEXT &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const workflow = cliArg('workflow');
  if (!workflow || workflow === true) {
    process.stderr.write(
      'usage: node run-workflow.mjs --workflow wf.json [--fixtures f.json] [--input items.json] [--out result.json] [--full]\n' +
        '         [--openverse-fixtures f.json] [--commons-fixtures f.json] [--mocks mocks.json]\n',
    );
    process.exit(2);
  }
  try {
    const mocksArg = cliArg('mocks');
    const mocks = mocksArg && mocksArg !== true ? JSON.parse(fs.readFileSync(mocksArg, 'utf8')) : {};
    for (const name of Object.keys(HTTP_MOCKS)) {
      const f = cliArg(`${name}-fixtures`);
      if (f && f !== true) mocks[name] = { ...(mocks[name] === true ? {} : mocks[name] || {}), fixtures: path.resolve(f) };
    }
    const result = await runWorkflow({
      workflow,
      fixtures: cliArg('fixtures'),
      input: cliArg('input'),
      full: !!cliArg('full'),
      mocks,
    });
    const text = JSON.stringify(result, null, 2);
    const out = cliArg('out');
    if (out && out !== true) fs.writeFileSync(out, text);
    process.stdout.write(text + '\n');
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    process.stderr.write(`run-workflow: ${err.message}\n`);
    process.exit(3);
  }
}
