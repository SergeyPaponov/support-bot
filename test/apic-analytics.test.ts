import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../src/config.js';
import { getApiConnectEvents } from '../src/apic-analytics.js';
import type { Fetch } from '../src/http.js';

const config = readConfig({
  SERVER_API_KEY: 'test-server-key-at-least-24-chars',
  SPLUNK_EXPORT_URL: 'https://splunk.example/export', SPLUNK_TOKEN: 'splunk-test-token', SPLUNK_INDEX: 'gateway',
  APIC_PLATFORM_URL: 'https://platform.example', APIC_ANALYTICS_SERVICE: 'analytics-1',
  APIC_ORG: 'provider-org', APIC_CATALOG: 'sandbox', APIC_TOKEN: 'apic-test-token',
  APIC_SPEC_URL_TEMPLATE: 'https://platform.example/api/catalogs/provider-org/sandbox/apis/{apiId}/document',
  LLM_URL: 'https://llm.example/chat', LLM_API_KEY: 'llm-test-token', LLM_MODEL: 'test',
});
const input = { transactionId: 'tx-42', apiId: 'api-1', from: '2026-11-01T09:00:00Z', to: '2026-11-01T10:00:00Z' };
const event = { global_transaction_id: 'tx-42', datetime: '2026-11-01T09:30:00Z', status_code: '500 Internal Server Error' };
function pages(responses: unknown[]) {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const fetcher: Fetch = async (url, init) => {
    const index = calls.length;
    calls.push({ url: new URL(String(url)), init });
    assert.ok(index < responses.length, 'Unexpected extra request');
    return new Response(JSON.stringify(responses[index]));
  };
  return { calls, fetcher };
}

test('native catalog endpoint uses Bearer auth, exact ID and bounded dates', async () => {
  const f = pages([{ total: 1, search_time: 1, events: [{ id: 'event-1', event }] }]);
  const logs = await getApiConnectEvents(config, input, f.fetcher);
  assert.deepEqual(logs, [{ id: 'apic:1', source: 'api-connect', data: { id: 'event-1', event } }]);
  const { url, init } = f.calls[0]!;
  assert.equal(url.origin, 'https://platform.example');
  assert.equal(url.pathname, '/analytics/analytics-1/catalogs/provider-org/sandbox/events');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    global_transaction_id: 'equals:tx-42', start: input.from, end: input.to, limit: '100', offset: '0',
  });
  assert.equal((init?.headers as Record<string,string>).authorization, 'Bearer apic-test-token');
  assert.equal((init?.headers as Record<string,string>).accept, 'application/json');
});
test('pagination collects all events and never follows upstream next URLs', async () => {
  const f = pages([
    { total: 2, offset: 0, events: [{ id: 'event-1', event }], next: 'https://untrusted.example/steal-token' },
    { total: 2, offset: 1, events: [{ id: 'event-2', event }] },
  ]);
  assert.equal((await getApiConnectEvents(config, input, f.fetcher)).length, 2);
  assert.equal(f.calls[1]?.url.searchParams.get('offset'), '1');
  assert.ok(f.calls.every(c => c.url.origin === 'https://platform.example'));
});
test('flattened event format and gateway-local transaction_id are supported', async () => {
  const f = pages([{ total: 1, events: [{ transaction_id: 123, datetime: event.datetime }] }]);
  const logs = await getApiConnectEvents({ ...config, APIC_TRANSACTION_FIELD: 'transaction_id' }, { ...input, transactionId: '123' }, f.fetcher);
  assert.equal(logs.length, 1);
  assert.equal(f.calls[0]?.url.searchParams.get('transaction_id'), 'equals:123');
  assert.equal(f.calls[0]?.url.searchParams.has('global_transaction_id'), false);
});
test('operator-looking transaction ID is treated as a literal', async () => {
  const f = pages([{ total: 0, events: [] }]);
  await getApiConnectEvents(config, { ...input, transactionId: 'not:123' }, f.fetcher);
  assert.equal(f.calls[0]?.url.searchParams.get('global_transaction_id'), 'equals:not:123');
});
for (const [name, responses, code] of [
  ['legacy logs wrapper is rejected', [{ logs: [] }], 'UPSTREAM_INVALID_RESPONSE'],
  ['missing events is rejected', [{ total: 0 }], 'UPSTREAM_INVALID_RESPONSE'],
  ['too many matches is rejected', [{ total: 201, events: [] }], 'LOG_LIMIT_EXCEEDED'],
  ['incomplete result is rejected', [{ total: 1, events: [] }], 'APIC_INCOMPLETE_RESULTS'],
  ['incorrect offset is rejected', [{ total: 1, offset: 1, events: [{ event }] }], 'UPSTREAM_INVALID_RESPONSE'],
  ['count changing across pages is rejected', [{ total: 2, events: [{ event }] }, { total: 3, events: [] }], 'APIC_RESULTS_CHANGED'],
  ['duplicate event across pages is rejected', [{ total: 2, events: [{ id: 'same', event }] }, { total: 2, events: [{ id: 'same', event }] }], 'UPSTREAM_INVALID_RESPONSE'],
  ['wrong transaction is rejected', [{ total: 1, events: [{ event: { ...event, global_transaction_id: 'other' } }] }], 'APIC_EVENT_SCOPE_MISMATCH'],
  ['out-of-range event is rejected', [{ total: 1, events: [{ event: { ...event, datetime: '2026-11-01T08:59:59Z' } }] }], 'APIC_EVENT_SCOPE_MISMATCH'],
  ['invalid event datetime is rejected', [{ total: 1, events: [{ event: { ...event, datetime: 'yesterday' } }] }], 'APIC_EVENT_SCOPE_MISMATCH'],
] as const) test(name, async () => {
  const f = pages([...responses]);
  await assert.rejects(() => getApiConnectEvents(config, input, f.fetcher), { code });
});
test('platform settings must identify an origin and safe catalog scope', () => {
  const env = Object.fromEntries(Object.entries(config).map(([k,v]) => [k, String(v)]));
  for (const patch of [{ APIC_PLATFORM_URL: 'https://platform.example/api' }, { APIC_ORG: '..' }, { APIC_ANALYTICS_SERVICE: 'service/other' }, { APIC_TRANSACTION_FIELD: 'untrusted_field' }])
    assert.throws(() => readConfig({ ...env, ...patch }));
});
