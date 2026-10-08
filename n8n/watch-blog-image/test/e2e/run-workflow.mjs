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
// --full      also include the raw n8n run data in the result.
// Exit code 0 when n8n reports no workflow-level error, 1 otherwise, 3 on harness failure.
// Runs sharing one E2E_N8N_HOME are serialized with a lock file (one sqlite DB, one
// fixed workflow id); use separate homes to run in parallel.
//
// Module use: import { runWorkflow } from './run-workflow.mjs'

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock } from './mock-anthropic.mjs';

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
  return {
    id: WORKFLOW_ID,
    name: wf.name || 'E2E run',
    active: false,
    nodes,
    connections,
    settings: { executionOrder: 'v1', ...(wf.settings || {}) },
    pinData: {},
  };
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
 *          n8nBin?: string, home?: string, mockPort?: number, full?: boolean, timeoutMs?: number}} opts
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

  try {
    const env = n8nEnv(home, { N8N_RUNNERS_BROKER_PORT: String(await freePort()) });
    const steps = [];

    // 1. Credential (plain `data` is encrypted by import:credentials; re-import only when it changes).
    const cred = [
      {
        id: CREDENTIAL_ID,
        name: CREDENTIAL_NAME,
        type: 'anthropicApi',
        data: { apiKey: 'sk-ant-mock-e2e', url: mock.url },
      },
    ];
    const credFile = path.join(work, 'credential.json');
    const credJson = JSON.stringify(cred, null, 2);
    const credStamp = path.join(work, 'credential.imported');
    const dbFile = path.join(home, '.n8n', 'database.sqlite');
    const stamp = () => `${fs.existsSync(dbFile) ? fs.statSync(dbFile).ino : 'nodb'}\n${credJson}`; // new DB => re-import
    if (!fs.existsSync(credStamp) || fs.readFileSync(credStamp, 'utf8') !== stamp()) {
      fs.writeFileSync(credFile, credJson);
      const r = await runN8n(n8nBin, ['import:credentials', `--input=${credFile}`], env, { logFile });
      steps.push({ step: 'import:credentials', code: r.code, ms: r.ms });
      if (r.code !== 0 || !/Successfully imported 1 credential/.test(r.stdout)) {
        throw new Error(`import:credentials failed (exit ${r.code}); see ${logFile}`);
      }
      fs.writeFileSync(credStamp, stamp());
    }

    // 2. Workflow (fixed id, overwritten on every import).
    const prepared = prepareWorkflow(wf, input);
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
    result.steps = steps;
    result.mock_requests = mock.requests;
    result.logs = { n8n: logFile, mock: mockLog, workflow: wfFile };
    if (opts.full) result.run = run;
    return result;
  } finally {
    await mock.close();
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
    process.stderr.write('usage: node run-workflow.mjs --workflow wf.json [--fixtures f.json] [--input items.json] [--out result.json] [--full]\n');
    process.exit(2);
  }
  try {
    const result = await runWorkflow({
      workflow,
      fixtures: cliArg('fixtures'),
      input: cliArg('input'),
      full: !!cliArg('full'),
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
