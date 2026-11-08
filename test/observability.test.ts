import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';
import { createLogger, safeErrorCode } from '../src/logger.js';
import { Lifecycle } from '../src/lifecycle.js';
import { ServiceError } from '../src/contracts.js';
import { readConfig } from '../src/config.js';
import { config, input, headers, sensitive, captureLogs, mockAnalyzer } from './operational-fixtures.js';

function assertSafe(text: string) { for (const value of sensitive) assert.ok(!text.includes(value), `Sensitive value was logged: ${value}`); }
async function serve(analyzer = mockAnalyzer().analyzer, lifecycle?: Lifecycle) {
  const logs = captureLogs();
  const server = createApp(config, analyzer, { logger: logs.logger, lifecycle }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { logs, base: `http://127.0.0.1:${address.port}`, async close() {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}

test('JSON logger emits only allowed fields/tokens, generated IDs, deterministic durations and correct streams', () => {
  const out: string[] = [], err: string[] = []; let now = 100;
  const logger = createLogger({ stdout: l => out.push(l), stderr: l => err.push(l), now: () => now, timestamp: () => new Date('2026-11-01T00:00:00Z') });
  const log = logger.operation('REST'); now = 125;
  log.log('analysis_completed', 'success');
  log.log('analysis_failed', 'failure', sensitive.join('\n'));
  log.log('analysis_failed', 'failure', { toJSON() { throw new Error('Must not serialize untrusted data'); } });
  const record = JSON.parse(out[0]!);
  assert.deepEqual(Object.keys(record), ['timestamp', 'level', 'event', 'requestId', 'interface', 'durationMs', 'outcome', 'errorCode']);
  assert.equal(record.timestamp, '2026-11-01T00:00:00.000Z');
  assert.equal(record.durationMs, 25); assert.equal(record.errorCode, null); assert.equal(record.level, 'info');
  assert.match(record.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(err.length, 2);
  for (const line of err) { assert.equal(JSON.parse(line).level, 'error'); assert.equal(JSON.parse(line).errorCode, 'INTERNAL_ERROR'); }
  assert.equal(safeErrorCode(new ServiceError(sensitive[0]!, sensitive.join(' '))), 'INTERNAL_ERROR');
  assert.equal(safeErrorCode(new Error(sensitive.join(' '))), 'INTERNAL_ERROR');
  // Runtime bypass of TS types still cannot inject content into token fields.
  const unsafe = logger.operation(sensitive[0] as 'REST');
  unsafe.log(sensitive[1] as 'analysis_failed', sensitive[2] as 'failure', sensitive[3]);
  unsafe.log('analysis_failed', 'failure', 'UPSTREAM_HTTP_ERROR');
  assert.equal(JSON.parse(err.at(-1)!).errorCode, 'UPSTREAM_HTTP_ERROR');
  assert.notEqual(JSON.parse(err.at(-1)!).requestId, record.requestId);
  assertSafe([...out, ...err].join(''));
});

test('broken logging sink cannot change request behavior', () => {
  const logger = createLogger({ stdout() { throw new Error('sink'); }, stderr() { throw new Error('sink'); } });
  assert.doesNotThrow(() => logger.operation('REST').log('analysis_failed', 'failure', 'INTERNAL_ERROR'));
});

for (const fail of [false, true]) test(`REST ${fail ? 'failure' : 'success'} has exactly one safe completion record`, async () => {
  const app = await serve(mockAnalyzer({ fail }).analyzer);
  try {
    const response = await fetch(`${app.base}/api/analyze?token=private-query`, { method: 'POST', headers: { ...headers, 'x-request-id': sensitive[6]! }, body: JSON.stringify(input) });
    assert.equal(response.status, fail ? 502 : 200);
    const body = await response.json();
    if (!fail) assert.equal(body.transactionId, input.transactionId);
    const records = app.logs.records(); assert.equal(records.length, 1);
    assert.equal(records[0].interface, 'REST');
    assert.equal(records[0].event, fail ? 'analysis_failed' : 'analysis_completed');
    assert.equal(records[0].errorCode, fail ? 'UPSTREAM_UNAVAILABLE' : null);
    assert.equal(fail ? app.logs.err.length : app.logs.out.length, 1);
    assertSafe(app.logs.text());
  } finally { await app.close(); }
});

test('logging preserves Express case-insensitive and trailing-slash REST route compatibility', async () => {
  const app = await serve();
  try {
    for (const path of ['/api/analyze/', '/API/ANALYZE']) {
      const response = await fetch(app.base + path, { method: 'POST', headers, body: JSON.stringify(input) });
      assert.equal(response.status, 200); assert.equal((await response.json()).transactionId, input.transactionId);
    }
    assert.equal(app.logs.records().length, 2); assertSafe(app.logs.text());
  } finally { await app.close(); }
});

for (const endpoint of ['/api/analyze', '/mcp']) test(`${endpoint} auth, malformed JSON and Origin failures are logged without input/header content`, async () => {
  const app = await serve();
  try {
    const requests = [
      { headers: {}, body: sensitive.join(' '), status: 401, code: 'UNAUTHORIZED' },
      { headers: { ...headers, origin: 'https://upstream.example/path?token=private-query' }, body: '{}', status: 403, code: 'ORIGIN_FORBIDDEN' },
      { headers, body: '{"private-request-body":', status: 400, code: 'INVALID_BODY' },
    ];
    for (const req of requests) {
      const r = await fetch(app.base + endpoint, { method: 'POST', headers: req.headers, body: req.body });
      assert.equal(r.status, req.status); await r.text();
      assert.equal(app.logs.records().at(-1).errorCode, req.code);
    }
    assert.equal(app.logs.records().length, requests.length); assertSafe(app.logs.text());
  } finally { await app.close(); }
});

test('REST input validation failures retain the public error envelope and log safe INVALID_INPUT', async () => {
  const app = await serve();
  try {
    const r = await fetch(app.base + '/api/analyze', { method: 'POST', headers, body: JSON.stringify({ ...input, customerId: sensitive[6] }) });
    assert.equal(r.status, 400); assert.equal((await r.json()).error.code, 'INVALID_INPUT');
    assert.equal(app.logs.records().length, 1); assert.equal(app.logs.records()[0].errorCode, 'INVALID_INPUT');
    assertSafe(app.logs.text());
  } finally { await app.close(); }
});

for (const fail of [false, true]) test(`MCP ${fail ? 'logical failure inside HTTP 200' : 'success'} is logged once without protocol/input data`, async () => {
  const app = await serve(mockAnalyzer({ fail }).analyzer);
  const client = new Client({ name: 'observability', version: '1.0.0' });
  const statuses: number[] = [];
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${app.base}/mcp`), { requestInit: { headers }, fetch: async (url, init) => {
      const response = await fetch(url, init); statuses.push(response.status); return response;
    } }));
    assert.equal((await client.listTools()).tools[0]?.name, 'analyze_transaction');
    assert.equal(app.logs.records().length, 0, 'handshake/list are not analysis events');
    const result = await client.callTool({ name: 'analyze_transaction', arguments: input });
    assert.equal(!!result.isError, fail); assert.equal(statuses.at(-1), 200);
    assert.equal(app.logs.records().length, 1);
    const record = app.logs.records()[0];
    assert.equal(record.interface, 'MCP'); assert.equal(record.outcome, fail ? 'failure' : 'success');
    assert.equal(record.errorCode, fail ? 'UPSTREAM_UNAVAILABLE' : null);
    assertSafe(app.logs.text());
  } finally { await client.close(); await app.close(); }
});

test('MCP validation failures from the callback and SDK schema validation are both logged as failures', async () => {
  const app = await serve();
  const client = new Client({ name: 'observability', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${app.base}/mcp`), { requestInit: { headers } }));
    for (const args of [{ ...input, transactionId: 'bad transaction private-request-body' }, { ...input, transactionId: 123 }]) {
      assert.equal((await client.callTool({ name: 'analyze_transaction', arguments: args })).isError, true);
    }
    assert.equal(app.logs.records().length, 2);
    for (const record of app.logs.records()) { assert.equal(record.outcome, 'failure'); assert.equal(record.errorCode, 'INVALID_INPUT'); }
    assertSafe(app.logs.text());
  } finally { await client.close(); await app.close(); }
});

test('public readiness transitions, unchanged healthz and rejection of REST/MCP work during initialization/draining', async () => {
  const lifecycle = new Lifecycle(); const mock = mockAnalyzer();
  const app = await serve(mock.analyzer, lifecycle);
  try {
    for (const phase of ['initializing', 'ready', 'draining', 'stopped']) {
      if (phase === 'ready') assert.equal(lifecycle.markReady(), true);
      if (phase === 'draining') lifecycle.drain();
      if (phase === 'stopped') lifecycle.stop();
      const health = await fetch(`${app.base}/healthz`);
      assert.equal(health.status, 200); assert.deepEqual(await health.json(), { status: 'ok' });
      const ready = await fetch(`${app.base}/readyz`);
      assert.equal(ready.status, phase === 'ready' ? 200 : 503);
      assert.deepEqual(await ready.json(), { status: phase === 'ready' ? 'ready' : 'not_ready' });
      assert.equal(mock.calls(), 0, 'probes never call dependencies');
      if (phase !== 'ready') {
        for (const [path, body] of [['/api/analyze', input], ['/mcp', { jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'analyze_transaction', arguments: input } }]] as const) {
          const r = await fetch(app.base + path, { method: 'POST', headers, body: JSON.stringify(body) });
          assert.equal(r.status, 503); assert.equal((await r.json()).error.code, phase === 'initializing' ? 'NOT_READY' : 'DRAINING');
        }
        if (phase !== 'initializing') assert.equal(lifecycle.markReady(), false);
      }
    }
    assertSafe(app.logs.text());
  } finally { await app.close(); }
});

test('shutdown budget defaults to 90000 and rejects invalid/overflow timer values', () => {
  const env = Object.fromEntries(Object.entries(config).map(([k, v]) => [k, String(v)]));
  delete env.SHUTDOWN_TIMEOUT_MS;
  assert.equal(readConfig(env).SHUTDOWN_TIMEOUT_MS, 90000);
  assert.equal(readConfig({ ...env, SHUTDOWN_TIMEOUT_MS: '120000' }).SHUTDOWN_TIMEOUT_MS, 120000);
  for (const value of ['0', '-1', 'NaN', '1.5', '2147483648']) assert.throws(() => readConfig({ ...env, SHUTDOWN_TIMEOUT_MS: value }));
});
