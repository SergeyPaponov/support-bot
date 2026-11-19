import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Analyzer } from '../src/analyzer.js';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import type { Fetch } from '../src/http.js';
import { captureLogs } from './operational-fixtures.js';

const transactionId = 'abc-123-xyz';
const now = new Date('2026-11-19T12:34:56.789Z');
const event = {
  global_transaction_id: transactionId, datetime: '2026-11-19T12:00:00.000Z',
  api_ref: 'maserviceapi:1.0.0', api_name: 'maserviceapi', catalog_id: 'j5884j4i98jj', catalog_name: 'internal', org_id: 'bghs73773gsd', org_name: 'dev',
};
const spec = { openapi: '3.0.3', info: { version: '1.0.0', 'x-ibm-name': 'maserviceapi' }, paths: { '/payments': { post: {} } } };
const diagnosis = { summary: 'Gateway rejected the request', probableCause: 'Invalid input', confidence: 'high',
  evidence: [{ logId: 'apic:1', specPointer: '/paths/~1payments/post', explanation: 'Gateway validation failed' }], nextSteps: ['Check required fields'], missingInformation: [] };
type Options = {
  events?: Record<string, unknown>[]; analyticsStatus?: number; analyticsBody?: unknown; timeout?: boolean;
  analyticsPageSize?: number; apiPages?: { total_results: number; results: unknown[] }[];
  apiBody?: unknown; documentStatus?: number; documentTimeout?: boolean; document?: unknown; config?: Record<string, string>; clock?: Date;
};
function fixture(options: Options = {}) {
  const config = readConfig({
    SERVER_API_KEY: 'synthetic-transaction-only-server-key', APIC_PLATFORM_URL: 'https://analytics.example',
    APIC_ANALYTICS_SERVICE: 'analytics', APIC_ORG: 'dev', APIC_CATALOG: 'internal', APIC_TOKEN: 'synthetic-apic-secret',
    APIC_SPEC_URL_TEMPLATE: 'https://management.example/api/catalogs/{org}/{catalog}/apis/{apiId}/document',
    LLM_URL: 'https://llm.example/completions', LLM_API_KEY: 'synthetic-llm-secret', LLM_MODEL: 'mock', ...options.config,
  });
  const calls: { url: URL; init?: RequestInit }[] = [];
  let clockCalls = 0, apiPage = 0;
  const fetcher: Fetch = async (url, init) => {
    const parsed = new URL(String(url)); calls.push({ url: parsed, init });
    if (parsed.hostname === 'analytics.example') {
      if (options.timeout) throw new DOMException('private upstream timeout detail', 'TimeoutError');
      const events = options.events ?? [event];
      const offset = Number(parsed.searchParams.get('offset'));
      const size = options.analyticsPageSize ?? 100;
      return Response.json(options.analyticsBody ?? { total: events.length, offset,
        events: events.slice(offset, offset + size).map((row, index) => ({ id: `event-${offset + index}`, event: row })) }, { status: options.analyticsStatus ?? 200 });
    }
    if (parsed.hostname === 'management.example') {
      if (parsed.pathname.endsWith('/document')) {
        if (options.documentTimeout) throw new DOMException('private Management timeout', 'TimeoutError');
        return Response.json(options.document ?? spec, { status: options.documentStatus ?? 200 });
      }
      return Response.json(options.apiBody ?? options.apiPages?.[apiPage++] ?? { total_results: 1, results: [{ id: 'published-api-id', name: 'maserviceapi', version: '1.0.0' }] });
    }
    assert.equal(parsed.hostname, 'llm.example', 'No unconfigured destination may be called');
    return Response.json({ choices: [{ message: { content: JSON.stringify(diagnosis) } }] });
  };
  const logs = captureLogs();
  const analyzer = new Analyzer(config, fetcher, () => { clockCalls++; return options.clock ?? now; });
  return { config, calls, logs, analyzer, clockCalls: () => clockCalls };
}
async function withHttp(f: ReturnType<typeof fixture>, run: (post: (body: unknown) => Promise<Response>) => Promise<void>) {
  const server = createApp(f.config, f.analyzer, { logger: f.logs.logger }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    await run(body => fetch(`http://127.0.0.1:${address.port}/api/analyze`, { method: 'POST',
      headers: { authorization: `Bearer ${f.config.SERVER_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

test('HTTP accepts only transaction_id; exact api_ref preserves org/catalog/version and existing analysis output', async () => {
  const f = fixture();
  const previous = await f.analyzer.analyze({ transactionId, apiId: event.api_ref, from: '2026-11-19T00:00:00.000Z', to: now.toISOString() });
  f.calls.length = 0;
  await withHttp(f, async post => {
    const response = await post({ transaction_id: transactionId });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), previous);
  });
  assert.equal(f.clockCalls(), 1);
  assert.deepEqual(f.calls.map(c => c.url.hostname), ['analytics.example', 'management.example', 'llm.example']);
  assert.equal(f.calls[1]?.url.pathname, '/api/catalogs/dev/internal/apis/maserviceapi%3A1.0.0/document');
  assert.equal((f.calls[1]?.init?.headers as Record<string, string>).authorization, 'Bearer synthetic-apic-secret');
  assert.ok(!f.logs.text().includes(transactionId) && !f.logs.text().includes(event.api_ref));
  const context = String(f.calls[2]?.init?.body);
  for (const secret of [transactionId, event.api_ref, event.org_id, event.catalog_id, f.config.APIC_TOKEN, f.config.LLM_API_KEY]) assert.ok(!context.includes(secret));
});

test('missing, empty, invalid IDs and client API/time fields are HTTP 400 without upstream work', async () => {
  const f = fixture();
  await withHttp(f, async post => {
    for (const body of [{}, null, [], { transaction_id: '' }, { transaction_id: 42 }, { transaction_id: ' ' },
      { transaction_id: 'x'.repeat(129) }, { transaction_id: 'a" | delete' }, { transactionId },
      { transaction_id: transactionId, apiId: 'api' }, { transaction_id: transactionId, from: '2026-11-01T00:00:00Z' },
      { transaction_id: transactionId, to: now.toISOString() }, { transaction_id: transactionId, start_time: '' }]) {
      const response = await post(body); assert.equal(response.status, 400);
      assert.ok(['INVALID_INPUT', 'INVALID_BODY'].includes((await response.json()).error.code));
    }
  });
  assert.equal(f.calls.length, 0); assert.equal(f.clockCalls(), 0);
});

test('one UTC timestamp supplies an exact 14-day window to every Analytics page; all records are aggregated', async () => {
  const end = now.toISOString(), start = new Date(+now - 14 * 24 * 60 * 60 * 1000).toISOString();
  const f = fixture({ analyticsPageSize: 1, events: [{ ...event, datetime: start }, { ...event, datetime: end }] });
  const result = await f.analyzer.analyzeTransaction({ transaction_id: transactionId });
  assert.equal(result.sources.apiConnect, 2); assert.equal(f.clockCalls(), 1);
  const pages = f.calls.filter(c => c.url.hostname === 'analytics.example'); assert.equal(pages.length, 2);
  for (const page of pages) {
    assert.equal(page.url.searchParams.get('start'), start); assert.equal(page.url.searchParams.get('end'), end);
    assert.equal(page.url.searchParams.get('global_transaction_id'), 'equals:' + transactionId);
    assert.equal(page.url.searchParams.get('limit'), '100');
  }
  assert.equal(pages[1]?.url.searchParams.get('offset'), '1');
  const completion = JSON.parse(String(f.calls.at(-1)?.init?.body));
  const context = JSON.parse(completion.messages.find((m: { role: string }) => m.role === 'user').content);
  assert.deepEqual(context.logs.map((log: { id: string }) => log.id), ['apic:1', 'apic:2']);
});

test('configured gateway-local transaction_id filtering is preserved', async () => {
  const f = fixture({ config: { APIC_TRANSACTION_FIELD: 'transaction_id' }, events: [{ ...event, global_transaction_id: 'different-global', transaction_id: transactionId }] });
  await f.analyzer.analyzeTransaction({ transaction_id: transactionId });
  assert.equal(f.calls[0]?.url.searchParams.get('transaction_id'), 'equals:' + transactionId);
  assert.equal(f.calls[0]?.url.searchParams.has('global_transaction_id'), false);
});

test('successful empty Analytics search yields the specified TRANSACTION_NOT_FOUND response, without Management or LLM calls', async () => {
  const f = fixture({ events: [] });
  await withHttp(f, async post => {
    const response = await post({ transaction_id: transactionId }); assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: { code: 'TRANSACTION_NOT_FOUND',
      message: "Transaction 'abc-123-xyz' was not found in API Analytics within the last 14 days." } });
  });
  assert.equal(f.calls.length, 1); assert.equal(f.logs.records()[0].errorCode, 'TRANSACTION_NOT_FOUND');
  assert.ok(!f.logs.text().includes(transactionId));
});

for (const options of [{ timeout: true }, { analyticsStatus: 401 }, { analyticsStatus: 403 }, { analyticsStatus: 404 }, { analyticsStatus: 503 },
  { analyticsBody: { total: 0 } }, { analyticsBody: { total: 1, events: [] } },
  { events: [{ ...event, global_transaction_id: 'wrong' }] }]) test(`Analytics errors never become HTTP 404: ${JSON.stringify(options)}`, async () => {
  const f = fixture(options);
  await withHttp(f, async post => {
    const response = await post({ transaction_id: transactionId }); assert.equal(response.status, 502);
    assert.notEqual((await response.json()).error.code, 'TRANSACTION_NOT_FOUND');
  });
  assert.equal(f.calls.length, 1);
});

test('valid api_ref takes priority over api_name and never performs a name lookup', async () => {
  const f = fixture({ events: [{ ...event, api_name: 'outdated-name' }] });
  await f.analyzer.analyzeTransaction({ transaction_id: transactionId });
  assert.equal(f.calls.filter(c => c.url.hostname === 'management.example').length, 1);
  assert.ok(f.calls[1]?.url.pathname.includes('maserviceapi%3A1.0.0'));
});

for (const status of [401, 403, 404, 503]) test(`valid api_ref Management HTTP ${status} never falls back to api_name`, async () => {
  const f = fixture({ documentStatus: status });
  await withHttp(f, async post => {
    const response = await post({ transaction_id: transactionId }); assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, 'UPSTREAM_HTTP_ERROR');
  });
  assert.equal(f.calls.length, 2); assert.ok(f.calls[1]?.url.pathname.endsWith('/document'));
});

test('Management timeout for a valid api_ref never starts a name lookup', async () => {
  const f = fixture({ documentTimeout: true });
  await assert.rejects(() => f.analyzer.analyzeTransaction({ transaction_id: transactionId }), { code: 'UPSTREAM_UNAVAILABLE', status: 502 });
  assert.equal(f.calls.length, 2);
});

for (const apiRef of [undefined, '', 'https://untrusted.example/steal-token']) test(`missing/unusable api_ref uses an unambiguous api_name: ${apiRef}`, async () => {
  const f = fixture({ events: [{ ...event, api_ref: apiRef }] });
  const result = await f.analyzer.analyzeTransaction({ transaction_id: transactionId });
  assert.equal(result.apiId, 'published-api-id');
  assert.deepEqual(f.calls.map(c => c.url.hostname), ['analytics.example', 'management.example', 'management.example', 'llm.example']);
  assert.equal(f.calls[1]?.url.pathname, '/api/catalogs/dev/internal/apis/maserviceapi');
  assert.equal((f.calls[1]?.init?.headers as Record<string, string>).accept, 'application/json');
  assert.equal(f.calls[2]?.url.pathname, '/api/catalogs/dev/internal/apis/published-api-id/document');
});

test('name fallback collects the complete API list before selecting a unique transaction version', async () => {
  const f = fixture({ events: [{ ...event, api_ref: undefined, api_version: '1.0.0' }], apiPages: [
    { total_results: 2, results: [{ id: 'api-v2', name: 'maserviceapi', version: '2.0.0' }] },
    { total_results: 2, results: [{ id: 'api-v1', name: 'maserviceapi', version: '1.0.0' }] },
  ] });
  const result = await f.analyzer.analyzeTransaction({ transaction_id: transactionId }); assert.equal(result.apiId, 'api-v1');
  assert.equal(f.calls[2]?.url.searchParams.get('offset'), '1');
});

for (const apiBody of [
  { total_results: 2, results: [{ id: 'one', name: 'maserviceapi', version: '1.0.0' }, { id: 'two', name: 'maserviceapi', version: '2.0.0' }] },
  { total_results: 0, results: [] },
]) test(`name fallback never silently selects an arbitrary version: ${apiBody.total_results} candidates`, async () => {
  const f = fixture({ events: [{ ...event, api_ref: undefined }], apiBody });
  await withHttp(f, async post => {
    const response = await post({ transaction_id: transactionId }); assert.equal(response.status, 422);
    assert.equal((await response.json()).error.code, apiBody.total_results ? 'API_IDENTITY_AMBIGUOUS' : 'API_IDENTITY_UNRESOLVED');
  });
  assert.equal(f.calls.length, 2);
});

for (const apiBody of [{ results: [] }, { total_results: 1, results: [] },
  { total_results: 1, results: [{ id: '..', name: 'maserviceapi', version: '1.0.0' }] },
  { total_results: 1, results: [{ id: 'api', name: 'other-api', version: '1.0.0' }] }]) test('malformed/incomplete name lookup fails safely without document retrieval', async () => {
  const f = fixture({ events: [{ ...event, api_ref: undefined }], apiBody });
  await assert.rejects(() => f.analyzer.analyzeTransaction({ transaction_id: transactionId }), { code: 'UPSTREAM_INVALID_RESPONSE', status: 502 });
  assert.equal(f.calls.length, 2);
});

for (const patch of [{ api_ref: 'maserviceapi:2.0.0' }, { org_id: 'other-org' }, { catalog_id: 'other-catalog' }]) test('conflicting transaction API/version/scope is rejected before Management calls', async () => {
  const f = fixture({ events: [event, { ...event, ...patch }] });
  await assert.rejects(() => f.analyzer.analyzeTransaction({ transaction_id: transactionId }), { code: 'API_IDENTITY_AMBIGUOUS', status: 422 });
  assert.equal(f.calls.length, 1);
});

test('missing API metadata and out-of-scope metadata are structured identity failures, not transaction-not-found', async () => {
  for (const [patch, code] of [[{ api_ref: undefined, api_name: undefined }, 'API_IDENTITY_UNRESOLVED'],
    [{ org_name: 'other', org_id: 'other-id' }, 'API_SCOPE_MISMATCH']] as const) {
    const f = fixture({ events: [{ ...event, ...patch }] });
    await withHttp(f, async post => {
      const response = await post({ transaction_id: transactionId }); assert.equal(response.status, 422);
      assert.equal((await response.json()).error.code, code);
    });
    assert.equal(f.calls.length, 1);
  }
});

test('fixed native Management template cannot silently use a different organization', async () => {
  const f = fixture({ config: { APIC_SPEC_URL_TEMPLATE: 'https://management.example/api/catalogs/other/internal/apis/{apiId}/document' } });
  await assert.rejects(() => f.analyzer.analyzeTransaction({ transaction_id: transactionId }), { code: 'API_SCOPE_MISMATCH' });
  assert.equal(f.calls.length, 1);
});

test('Management document version mismatch is rejected before sending a context to the LLM', async () => {
  const f = fixture({ document: { ...spec, info: { ...spec.info, version: '2.0.0' } } });
  await assert.rejects(() => f.analyzer.analyzeTransaction({ transaction_id: transactionId }), { code: 'API_SPEC_IDENTITY_MISMATCH', status: 502 });
  assert.equal(f.calls.length, 2);
});

test('fixed Management templates preserve equivalent configured organization/catalog names', async () => {
  const f = fixture({ config: { APIC_SPEC_URL_TEMPLATE: 'https://management.example/api/catalogs/dev/internal/apis/{apiId}/document' } });
  await f.analyzer.analyzeTransaction({ transaction_id: transactionId });
  assert.equal(f.calls[1]?.url.pathname, '/api/catalogs/dev/internal/apis/maserviceapi%3A1.0.0/document');
});

test('nonstandard document URLs require an explicit name-list template instead of an invented endpoint', async () => {
  const f = fixture({ config: { APIC_SPEC_URL_TEMPLATE: 'https://management.example/custom/{apiId}' }, events: [{ ...event, api_ref: undefined }] });
  await assert.rejects(() => f.analyzer.analyzeTransaction({ transaction_id: transactionId }), { code: 'API_RESOLUTION_CONFIG_ERROR', status: 503 });
  assert.equal(f.calls.length, 1);
});

test('an explicitly configured name-list template supports custom Management routing', async () => {
  const f = fixture({ config: { APIC_API_LIST_URL_TEMPLATE: 'https://management.example/custom/catalogs/{org}/{catalog}/apis/{apiName}' }, events: [{ ...event, api_ref: undefined }] });
  await f.analyzer.analyzeTransaction({ transaction_id: transactionId });
  assert.equal(f.calls[1]?.url.pathname, '/custom/catalogs/dev/internal/apis/maserviceapi');
});

test('configured organization/catalog IDs are preserved when Analytics includes equivalent names', async () => {
  const f = fixture({ config: { APIC_ORG: event.org_id, APIC_CATALOG: event.catalog_id } });
  await f.analyzer.analyzeTransaction({ transaction_id: transactionId });
  assert.equal(f.calls[0]?.url.pathname, '/analytics/analytics/catalogs/bghs73773gsd/j5884j4i98jj/events');
  assert.equal(f.calls[1]?.url.pathname, '/api/catalogs/bghs73773gsd/j5884j4i98jj/apis/maserviceapi%3A1.0.0/document');
});
