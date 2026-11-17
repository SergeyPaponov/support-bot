import { readConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { Analyzer } from '../src/analyzer.js';
import type { Fetch } from '../src/http.js';

export const sensitive = ['synthetic-server-credential-123456', 'synthetic-splunk-credential', 'synthetic-apic-credential',
  'synthetic-llm-credential', 'private-transaction-42', 'private-api-42', 'customer-private-42',
  'private-request-body', 'private-specification', 'private-completion', 'private-prompt',
  'https://upstream.example/path?token=private-query', 'untrusted-error-message'];
export const config = readConfig({
  SERVER_API_KEY: sensitive[0], APIC_TOKEN: sensitive[2], LLM_API_KEY: sensitive[3],
  APIC_PLATFORM_URL: 'http://127.0.0.1:3999', APIC_ANALYTICS_SERVICE: 'analytics', APIC_ORG: 'org', APIC_CATALOG: 'catalog',
  APIC_SPEC_URL_TEMPLATE: 'http://127.0.0.1:3999/spec/{apiId}', LLM_URL: 'http://127.0.0.1:3999/llm', LLM_MODEL: 'mock',
});
export const input = { transactionId: sensitive[4]!, apiId: sensitive[5]!, from: '2026-11-01T09:00:00Z', to: '2026-11-01T10:00:00Z' };
export const headers = { authorization: `Bearer ${config.SERVER_API_KEY}`, 'content-type': 'application/json' };
export const diagnosis = { summary: 'private-completion', probableCause: 'private-prompt', confidence: 'low', evidence: [], nextSteps: [], missingInformation: [] };
export function captureLogs() {
  const out: string[] = [], err: string[] = [];
  const logger = createLogger({ stdout: line => out.push(line), stderr: line => err.push(line) });
  return { logger, out, err, records: () => [...out, ...err].map(line => JSON.parse(line)), text: () => [...out, ...err].join('') };
}
export function mockAnalyzer(options: { fail?: boolean } = {}) {
  let calls = 0;
  const fetcher: Fetch = async url => {
    calls++;
    if (options.fail) throw new Error(sensitive.join(' '));
    const path = new URL(String(url)).pathname;
    if (path.startsWith('/analytics/')) return Response.json({ total: 1, events: [{ id: 'event-1', event: {
      global_transaction_id: input.transactionId, datetime: '2026-11-01T09:30:00Z', status: 400, customerId: sensitive[6], payload: sensitive[7],
    } }] });
    if (path.startsWith('/spec/')) return Response.json({ openapi: '3.0.3', info: { title: sensitive[8] }, paths: {} });
    if (path === '/llm') return Response.json({ choices: [{ message: { content: JSON.stringify(diagnosis) } }] });
    throw new Error('Unexpected mock route');
  };
  return { analyzer: new Analyzer(config, fetcher), calls: () => calls };
}
