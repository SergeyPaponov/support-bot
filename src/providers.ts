import { parseDocument } from 'yaml';
import { z } from 'zod';
import type { Config } from './config.js';
import { ServiceError, type AnalyticsSearchInput, type LogEntry } from './contracts.js';
import { parseJson, requestText, type Fetch } from './http.js';
import { getApiConnectEvents } from './apic-analytics.js';
import { transactionApiIdentity, type ApiIdentity } from './api-identity.js';

const objectSchema = z.record(z.unknown());
const apiListSchema = z.object({
  total_results: z.number().int().nonnegative(),
  results: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,199}$/), name: z.string().min(1), version: z.string().min(1) })).max(100),
});
export class Providers {
  constructor(private config: Config, private fetcher: Fetch = fetch) {}
  private get(name: string, url: string, token: string, accept = 'application/json, application/yaml, text/yaml') {
    return requestText(this.fetcher, name, url, { headers: { authorization: `Bearer ${token}`, accept } }, this.config.UPSTREAM_TIMEOUT_MS);
  }
  async apiConnectEvents(input: AnalyticsSearchInput): Promise<LogEntry[]> {
    return getApiConnectEvents(this.config, input, this.fetcher);
  }
  private identityUrl(template: string, identity: ApiIdentity, key: 'apiId' | 'apiName', value: string) {
    const rendered = template.replaceAll('{org}', encodeURIComponent(identity.org))
      .replaceAll('{catalog}', encodeURIComponent(identity.catalog)).replaceAll('{' + key + '}', encodeURIComponent(value));
    const url = new URL(rendered);
    // Fixed native templates must refer to the same scope too. Host and route are
    // exclusively server configuration; no upstream URL or redirect is followed.
    const native = /^\/api\/catalogs\/([^/]+)\/([^/]+)\/apis\//.exec(url.pathname);
    if (native && (!identity.orgAliases.includes(decodeURIComponent(native[1]!)) || !identity.catalogAliases.includes(decodeURIComponent(native[2]!)))) {
      throw new ServiceError('API_SCOPE_MISMATCH', 'Management URL does not match the transaction scope', 422);
    }
    return url;
  }
  async resolveTransactionApi(logs: LogEntry[]) {
    const identity = transactionApiIdentity(logs, this.config);
    if (identity.apiRef) return { apiId: identity.apiRef, identity };
    const derived = this.config.APIC_SPEC_URL_TEMPLATE.replace(/\/\{apiId\}\/document(?=\?|$)/, '/{apiName}');
    const template = this.config.APIC_API_LIST_URL_TEMPLATE ??
      (derived !== this.config.APIC_SPEC_URL_TEMPLATE ? derived : undefined);
    if (!template) throw new ServiceError('API_RESOLUTION_CONFIG_ERROR', 'API name resolution requires a configured API list URL template', 503);
    const base = this.identityUrl(template, identity, 'apiName', identity.name);
    const matches: { id: string; version: string }[] = [];
    const seen = new Set<string>();
    let offset = 0, total: number | undefined;
    for (let page = 0; page < 20; page++) {
      const url = new URL(base); url.searchParams.set('offset', String(offset)); url.searchParams.set('limit', '100');
      const raw = await this.get('API Connect', url.href, this.config.APIC_TOKEN, 'application/json');
      const result = apiListSchema.safeParse(parseJson(raw, 'API Connect API list'));
      if (!result.success) throw new ServiceError('UPSTREAM_INVALID_RESPONSE', 'API Connect must return a complete API list', 502);
      const data = result.data;
      if ((total !== undefined && total !== data.total_results) || offset + data.results.length > data.total_results) {
        throw new ServiceError('UPSTREAM_INVALID_RESPONSE', 'API Connect returned inconsistent API list pagination', 502);
      }
      total = data.total_results;
      for (const api of data.results) {
        if (seen.has(api.id) || api.name !== identity.name) throw new ServiceError('UPSTREAM_INVALID_RESPONSE', 'API Connect returned inconsistent API identities', 502);
        seen.add(api.id);
        if (!identity.version || api.version === identity.version) matches.push(api);
      }
      offset += data.results.length;
      if (offset === total) {
        if (matches.length !== 1) throw new ServiceError(matches.length ? 'API_IDENTITY_AMBIGUOUS' : 'API_IDENTITY_UNRESOLVED', 'API name does not resolve to exactly one published API version', 422);
        const selected = matches[0]!;
        return { apiId: selected.id, identity: { ...identity, version: selected.version } };
      }
      if (!data.results.length) break;
    }
    throw new ServiceError('UPSTREAM_INVALID_RESPONSE', 'API Connect API list is incomplete or exceeds the pagination budget', 502);
  }
  async spec(apiId: string, identity?: ApiIdentity): Promise<Record<string, unknown>> {
    const url = identity ? this.identityUrl(this.config.APIC_SPEC_URL_TEMPLATE, identity, 'apiId', apiId).href :
      this.config.APIC_SPEC_URL_TEMPLATE.replaceAll('{org}', encodeURIComponent(this.config.APIC_ORG))
        .replaceAll('{catalog}', encodeURIComponent(this.config.APIC_CATALOG)).replaceAll('{apiId}', encodeURIComponent(apiId));
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
    if (identity) {
      const info = objectSchema.safeParse(spec.data.info);
      if (!info.success || info.data.version !== identity.version ||
          (info.data['x-ibm-name'] !== undefined && info.data['x-ibm-name'] !== identity.name)) {
        throw new ServiceError('API_SPEC_IDENTITY_MISMATCH', 'API document does not match the resolved API identity', 502);
      }
    }
    return spec.data;
  }
}
