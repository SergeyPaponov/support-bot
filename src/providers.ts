import { parseDocument } from 'yaml';
import { z } from 'zod';
import type { Config } from './config.js';
import { ServiceError, type AnalysisInput, type LogEntry } from './contracts.js';
import { requestText, type Fetch } from './http.js';
import { getApiConnectEvents } from './apic-analytics.js';

const objectSchema = z.record(z.unknown());
export class Providers {
  constructor(private config: Config, private fetcher: Fetch = fetch) {}
  private get(name: string, url: string, token: string) {
    return requestText(this.fetcher, name, url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json, application/yaml, text/yaml' } }, this.config.UPSTREAM_TIMEOUT_MS);
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
