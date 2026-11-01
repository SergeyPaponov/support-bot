import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Analyzer } from '../src/analyzer.js';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { analysisInput } from '../src/contracts.js';
import { requestText, type Fetch } from '../src/http.js';
import { redact } from '../src/redact.js';

const config = readConfig({
  SERVER_API_KEY: 'test-server-key-at-least-24-chars', SPLUNK_EXPORT_URL: 'https://splunk.example/services/search/jobs/export',
  SPLUNK_TOKEN: 'splunk-credential-123', SPLUNK_INDEX: 'gateway', APIC_PLATFORM_URL: 'https://analytics.example',
  APIC_ANALYTICS_SERVICE: 'analytics', APIC_ORG: 'provider-org', APIC_CATALOG: 'sandbox', APIC_SPEC_URL_TEMPLATE: 'https://apic.example/apis/{apiId}/document',
  APIC_TOKEN: 'apic-credential-123', LLM_URL: 'https://llm.example/v1/chat/completions', LLM_API_KEY: 'llm-credential-123', LLM_MODEL: 'test-model',
});
const input = { transactionId: 'tx-42', apiId: 'payments:1.0', from: '2026-11-01T09:00:00Z', to: '2026-11-01T10:00:00Z' };
const diagnosis = {
  summary: 'Missing required header', probableCause: 'Gateway rejected a missing X-Client-Id header', confidence: 'high',
  evidence: [{ logId: 'splunk:1', specPointer: '/paths/~1payments/post', explanation: 'Required header is absent' }],
  nextSteps: ['Send X-Client-Id'], missingInformation: [],
};
type FixtureOptions = { noLogs?: boolean; failAnalytics?: boolean; invalidSpec?: boolean; yaml?: boolean; completion?: unknown; invalidCompletion?: boolean; bigLogs?: boolean };
function fixture(options: FixtureOptions = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher: Fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const host = new URL(String(url)).hostname;
    if (host === 'splunk.example') return new Response(options.noLogs ? '' : JSON.stringify({ result: {
      transactionId: 'tx-42', status: 400, message: 'Missing X-Client-Id; user@example.com',
      authorization: 'Bearer credential-that-must-not-leak', nested: { password: 'password-that-must-not-leak' },
      payload: options.bigLogs ? 'x'.repeat(170000) : 'non-sensitive',
    } }) + '\n');
    if (host === 'analytics.example') return new Response(JSON.stringify({ total: options.noLogs ? 0 : 1, events: options.noLogs ? [] : [{ id: 'event-1', event: { global_transaction_id: 'tx-42', datetime: '2026-11-01T09:30:00Z', status_code: '400 Bad Request' } }] }), { status: options.failAnalytics ? 503 : 200 });
    if (host === 'apic.example') return new Response(options.invalidSpec ? '{}' : options.yaml ? 'swagger: "2.0"\npaths:\n  /payments:\n    post: {}\n' : JSON.stringify({ openapi: '3.0.3', paths: { '/payments': { post: { parameters: [{ in: 'header', name: 'X-Client-Id', required: true }] } } } }));
    if (host === 'llm.example') return new Response(JSON.stringify({ choices: [{ message: { content: options.invalidCompletion ? 'not JSON' : JSON.stringify(options.completion ?? diagnosis) } }] }));
    throw new Error('Unexpected URL');
  };
  return { fetcher, calls, analyzer: new Analyzer(config, fetcher) };
}

test('pipeline fetches scoped sources, redacts context, and validates diagnosis', async () => {
  const f = fixture();
  const result = await f.analyzer.analyze(input);
  assert.equal(result.diagnosis.probableCause, diagnosis.probableCause);
  assert.deepEqual(result.sources, { splunk: 1, apiConnect: 1, specification: 'API Connect' });
  const splunk = f.calls.find(c => c.url.includes('splunk.example'))!;
  const search = new URLSearchParams(String(splunk.init?.body));
  assert.match(search.get('search')!, /transactionId="tx-42"/);
  assert.equal(search.get('earliest_time'), input.from);
  assert.match(f.calls.find(c => c.url.includes('apic.example'))!.url, /payments%3A1.0/);
  const context = String(f.calls.find(c => c.url.includes('llm.example'))!.init?.body);
  assert.ok(!context.includes('credential-that-must-not-leak'));
  assert.ok(!context.includes('password-that-must-not-leak'));
  assert.ok(!context.includes('user@example.com'));
  assert.match(context, /REDACTED/);
});
test('Swagger YAML is accepted', async () => { assert.equal((await fixture({ yaml: true }).analyzer.analyze(input)).diagnosis.confidence, 'high'); });
test('invalid input and query injection are rejected before any requests', async () => {
  const f = fixture();
  for (const patch of [{ transactionId: 'a" | delete' }, { to: input.from }, { from: 'yesterday' }, { extra: 'value' }])
    await assert.rejects(() => f.analyzer.analyze({ ...input, ...patch }));
  assert.equal(f.calls.length, 0);
  assert.equal(analysisInput.safeParse({ ...input, to: '2026-11-03T10:00:00Z' }).success, false);
});
for (const [name, options, code] of [
  ['no logs', { noLogs: true }, 'NO_LOGS'],
  ['source failure', { failAnalytics: true }, 'UPSTREAM_HTTP_ERROR'],
  ['invalid spec', { invalidSpec: true }, 'INVALID_SPEC'],
  ['malformed model JSON', { invalidCompletion: true }, 'UPSTREAM_INVALID_RESPONSE'],
  ['invalid model schema', { completion: { summary: 'only summary' } }, 'INVALID_LLM_RESPONSE'],
  ['invented log evidence', { completion: { ...diagnosis, evidence: [{ ...diagnosis.evidence[0], logId: 'made-up:1' }] } }, 'INVALID_LLM_EVIDENCE'],
  ['invented spec evidence', { completion: { ...diagnosis, evidence: [{ ...diagnosis.evidence[0], specPointer: '/missing' }] } }, 'INVALID_LLM_EVIDENCE'],
  ['oversized context', { bigLogs: true }, 'CONTEXT_TOO_LARGE'],
] as const) test(name, async () => {
  await assert.rejects(() => fixture(options).analyzer.analyze(input), { code });
});
test('evidence-free diagnosis has low confidence', async () => {
  const result = await fixture({ completion: { ...diagnosis, evidence: [] } }).analyzer.analyze(input);
  assert.equal(result.diagnosis.confidence, 'low');
});
test('bounded response and safe upstream errors', async () => {
  await assert.rejects(() => requestText(async () => new Response('x'.repeat(1024 * 1024 + 1)), 'test', 'https://test', {}, 100), { code: 'UPSTREAM_TOO_LARGE' });
  await assert.rejects(() => requestText(async () => { throw new Error('sensitive upstream detail'); }, 'test', 'https://test', {}, 100), { message: 'test request failed or timed out' });
});
test('redaction handles nested credentials and free-text bearer tokens', () => {
  assert.deepEqual(redact({ Authorization: 'secret', nested: ['Bearer abc.def', 'password=hello', 'known-secret'] }, ['known-secret']), {
    Authorization: '[REDACTED]', nested: ['Bearer [REDACTED]', 'password=[REDACTED]', '[REDACTED]'],
  });
});
test('configuration rejects remote cleartext and embedded credentials', () => {
  const env = Object.fromEntries(Object.entries(config).map(([k,v]) => [k, String(v)]));
  assert.throws(() => readConfig({ ...env, LLM_URL: 'http://remote.example/chat' }));
  assert.throws(() => readConfig({ ...env, LLM_URL: 'https://user:pass@remote.example/chat' }));
});
test('REST and MCP SDK initialize/list/call work over HTTP', async () => {
  const f = fixture();
  const server = createApp(config, f.analyzer).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: `Bearer ${config.SERVER_API_KEY}`, 'content-type': 'application/json' };
  const client = new Client({ name: 'test', version: '1.0.0' });
  try {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/api/analyze`, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await fetch(`${base}/api/analyze`, { method: 'POST', headers: { ...headers, origin: 'https://evil.example' }, body: '{}' })).status, 403);
    assert.equal((await fetch(`${base}/api/analyze`, { method: 'POST', headers, body: '{}' })).status, 400);
    const response = await fetch(`${base}/api/analyze`, { method: 'POST', headers, body: JSON.stringify(input) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).transactionId, input.transactionId);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
    assert.equal((await client.listTools()).tools[0]?.name, 'analyze_transaction');
    const result = await client.callTool({ name: 'analyze_transaction', arguments: input });
    assert.ok(!result.isError);
    assert.equal((result.structuredContent as Record<string, unknown>)?.transactionId, input.transactionId);
    const invalid = await client.callTool({ name: 'analyze_transaction', arguments: { ...input, transactionId: '" | delete' } });
    assert.equal(invalid.isError, true);
  } finally { await client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
