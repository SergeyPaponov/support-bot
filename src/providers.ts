import { parseDocument } from 'yaml';
import { z } from 'zod';
import type { Config } from './config.js';
import { ServiceError, type AnalysisInput, type LogEntry } from './contracts.js';
import { parseJson, requestText, type Fetch } from './http.js';
import { getApiConnectEvents } from './apic-analytics.js';

const objectSchema = z.record(z.unknown());
export class Providers {
  constructor(private config: Config, private fetcher: Fetch = fetch) {}
  private get(name: string, url: string, token: string) {
    return requestText(this.fetcher, name, url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json, application/yaml, text/yaml' } }, this.config.UPSTREAM_TIMEOUT_MS);
  }
  async splunk(input: AnalysisInput): Promise<LogEntry[]> {
    const c = this.config;
    const form = new URLSearchParams({
      search: `search index="${c.SPLUNK_INDEX}" ${c.SPLUNK_TRANSACTION_FIELD}="${input.transactionId}" | head 201`,
      earliest_time: input.from, latest_time: input.to, output_mode: 'json', preview: 'false',
    });
    const text = await requestText(this.fetcher, 'Splunk', c.SPLUNK_EXPORT_URL, {
      method: 'POST', headers: { authorization: `Splunk ${c.SPLUNK_TOKEN}`, 'content-type': 'application/x-www-form-urlencoded' }, body: form,
    }, c.UPSTREAM_TIMEOUT_MS);
    const entries: LogEntry[] = [];
    for (const line of text.split('\n').filter(s => s.trim())) {
      const row = objectSchema.safeParse(parseJson(line, 'Splunk'));
      if (!row.success || row.data.error || row.data.messages) throw new ServiceError('SPLUNK_SEARCH_ERROR', 'Splunk search returned an error or diagnostic message');
      if (row.data.preview === true) continue;
      if (row.data.result) entries.push({ id: `splunk:${entries.length + 1}`, source: 'splunk', data: row.data.result });
    }
    if (entries.length > 200) throw new ServiceError('LOG_LIMIT_EXCEEDED', 'More than 200 Splunk events; narrow the time range', 422);
    return entries;
  }
  async apiConnectEvents(input: AnalysisInput): Promise<LogEntry[]> {
    return getApiConnectEvents(this.config, input, this.fetcher);
  }
  async spec(apiId: string): Promise<Record<string, unknown>> {
    const url = this.config.APIC_SPEC_URL_TEMPLATE.replaceAll('{apiId}', encodeURIComponent(apiId));
    const text = await this.get('API Connect', url, this.config.APIC_TOKEN);
    let value: unknown;
    try {
      const document = parseDocument(text, { uniqueKeys: true });
      if (document.errors.length) throw new Error();
      value = document.toJS({ maxAliasCount: 50 });
    } catch { throw new ServiceError('INVALID_SPEC', 'API Connect returned invalid JSON/YAML'); }
    const spec = objectSchema.safeParse(value);
    if (!spec.success || !(spec.data.swagger === '2.0' || /^3\.[01]\.\d+$/.test(String(spec.data.openapi))) || !objectSchema.safeParse(spec.data.paths).success)
      throw new ServiceError('INVALID_SPEC', 'Expected a raw Swagger 2.0 or OpenAPI 3.0/3.1 document with paths');
    return spec.data;
  }
}
