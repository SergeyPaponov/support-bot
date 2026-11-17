import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Analyzer } from '../src/analyzer.js';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { analysisInput } from '../src/contracts.js';
import { requestText, type Fetch } from '../src/http.js';
import { redact } from '../src/redact.js';

const config = readConfig({
  SERVER_API_KEY: 'test-server-key-at-least-24-chars', APIC_PLATFORM_URL: 'https://analytics.example',
  APIC_ANALYTICS_SERVICE: 'analytics', APIC_ORG: 'provider-org', APIC_CATALOG: 'sandbox', APIC_SPEC_URL_TEMPLATE: 'https://apic.example/apis/{apiId}/document',
  APIC_TOKEN: 'apic-credential-123', LLM_URL: 'https://llm.example/v1/chat/completions', LLM_API_KEY: 'llm-credential-123', LLM_MODEL: 'test-model',
});
const input = { transactionId: 'tx-42', apiId: 'payments:1.0', from: '2026-11-01T09:00:00Z', to: '2026-11-01T10:00:00Z' };
const diagnosis = {
  summary: 'Missing required header', probableCause: 'Gateway rejected a missing X-Client-Id header', confidence: 'high',
  evidence: [{ logId: 'apic:1', specPointer: '/paths/~1payments/post', explanation: 'Required header is absent' }],
  nextSteps: ['Send X-Client-Id'], missingInformation: [],
};
type FixtureOptions = { noLogs?: boolean; failAnalytics?: boolean; invalidSpec?: boolean; yaml?: boolean; completion?: unknown; invalidCompletion?: boolean; bigLogs?: boolean };
function fixture(options: FixtureOptions = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher: Fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const host = new URL(String(url)).hostname;
    if (host === 'analytics.example') return new Response(JSON.stringify({ total: options.noLogs ? 0 : 1, events: options.noLogs ? [] : [{ id: 'event-1', event: {
      global_transaction_id: 'tx-42', datetime: '2026-11-01T09:30:00Z', status_code: '400 Bad Request', error_message: 'Missing X-Client-Id; user@example.com',
      authorization: 'Bearer credential-that-must-not-leak', nested: { password: 'password-that-must-not-leak' },
      payload: options.bigLogs ? 'x'.repeat(170000) : 'non-sensitive',
    } }] }), { status: options.failAnalytics ? 503 : 200 });
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
  assert.deepEqual(result.sources, { splunk: 0, apiConnect: 1, specification: 'API Connect' });
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(f.calls.map(c => new URL(c.url).hostname).sort(), ['analytics.example', 'apic.example', 'llm.example']);
  const analytics = new URL(f.calls.find(c => new URL(c.url).hostname === 'analytics.example')!.url);
  assert.equal(analytics.searchParams.get('global_transaction_id'), 'equals:tx-42');
  assert.equal(analytics.searchParams.get('start'), input.from);
  assert.match(f.calls.find(c => c.url.includes('apic.example'))!.url, /payments%3A1.0/);
  const context = String(f.calls.find(c => c.url.includes('llm.example'))!.init?.body);
  assert.ok(!context.includes('credential-that-must-not-leak'));
  assert.ok(!context.includes('password-that-must-not-leak'));
  assert.ok(!context.includes('user@example.com'));
  assert.match(context, /diagnosticSignals/);
});
test('legacy Splunk settings are ignored and cannot trigger a Splunk request', async () => {
  const env = Object.fromEntries(Object.entries(config).map(([k, v]) => [k, String(v)]));
  const parsed = readConfig({ ...env, SPLUNK_EXPORT_URL: 'not-a-url', SPLUNK_TOKEN: '', SPLUNK_INDEX: '' });
  assert.equal('SPLUNK_EXPORT_URL' in parsed, false);
  const f = fixture();
  const result = await new Analyzer(parsed, f.fetcher).analyze(input);
  assert.equal(result.sources.splunk, 0);
  assert.ok(f.calls.every(c => !c.url.includes('splunk')));
});
test('empty Analytics returns NO_LOGS and never invokes the LLM', async () => {
  const f = fixture({ noLogs: true });
  await assert.rejects(() => f.analyzer.analyze(input), { code: 'NO_LOGS', status: 404 });
  assert.ok(f.calls.every(c => !c.url.includes('llm.example')));
});
test('obsolete Splunk evidence is rejected when only Analytics events exist', async () => {
  const f = fixture({ completion: { ...diagnosis, evidence: [{ ...diagnosis.evidence[0], logId: 'splunk:1' }] } });
  await assert.rejects(() => f.analyzer.analyze(input), { code: 'INVALID_LLM_EVIDENCE' });
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
] as const) test(name, async () => {
  await assert.rejects(() => fixture(options).analyzer.analyze(input), { code });
});
test('large unselected payload is excluded rather than consuming the LLM budget', async () => {
  const f = fixture({ bigLogs: true });
  await f.analyzer.analyze(input);
  const request = String(f.calls.find(c => c.url.includes('llm.example'))?.init?.body);
  assert.ok(request.length < 10000);
  assert.ok(!request.includes('x'.repeat(100)));
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
test('REST analysis preserves health, authentication, validation and response contracts', async () => {
  const f = fixture();
  const server = createApp(config, f.analyzer).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: `Bearer ${config.SERVER_API_KEY}`, 'content-type': 'application/json' };
  try {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/api/analyze`, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await fetch(`${base}/api/analyze`, { method: 'POST', headers: { ...headers, origin: 'https://evil.example' }, body: '{}' })).status, 403);
    assert.equal((await fetch(`${base}/api/analyze`, { method: 'POST', headers, body: '{}' })).status, 400);
    const response = await fetch(`${base}/api/analyze`, { method: 'POST', headers, body: JSON.stringify(input) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).transactionId, input.transactionId);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('former MCP endpoint is absent for every HTTP method and cannot invoke analysis', async () => {
  const f = fixture();
  const server = createApp(config, f.analyzer).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const headers = { authorization: `Bearer ${config.SERVER_API_KEY}`, 'content-type': 'application/json' };
  try {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      const response: Response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
        method, headers, ...(method === 'POST' ? { body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'analyze_transaction', arguments: input } }) } : {}),
      });
      assert.equal(response.status, 404);
      assert.equal(response.headers.get('mcp-session-id'), null);
      await response.text();
    }
    assert.equal(f.calls.length, 0);
    const invalid = await fetch(`http://127.0.0.1:${address.port}/api/analyze`, {
      method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: input }),
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, 'INVALID_INPUT');
    assert.equal(f.calls.length, 0);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
