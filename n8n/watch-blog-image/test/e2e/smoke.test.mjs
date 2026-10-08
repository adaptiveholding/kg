// Real-n8n smoke test: Manual Trigger -> Code -> chainLlm 1.9 + lmChatAnthropic 1.6 -> mock API.
// Skipped unless N8N_BIN points at an n8n 2.x CLI (see README, "End-to-end tests").
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWorkflow } from './run-workflow.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

test('chainLlm + lmChatAnthropic reach the mock and return its canned text', { skip: !process.env.N8N_BIN && 'N8N_BIN not set', timeout: 300000 }, async () => {
  const r = await runWorkflow({
    workflow: path.join(here, 'smoke.workflow.json'),
    fixtures: path.join(here, 'smoke.fixtures.json'),
  });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(r.nodes['Smoke chain'][0].items, [{ text: 'canned reply for MARKER1 from mock-anthropic' }]);

  const calls = r.mock_requests.filter((q) => q.path === '/v1/messages');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.model, 'claude-haiku-5-5');
  assert.equal(calls[0].body.max_tokens, 1000);
  assert.equal(calls[0].matched, 'MARKER1');
});
