import { z } from 'zod';
import type { Config } from './config.js';
import { ServiceError, type AnalyticsSearchInput, type LogEntry } from './contracts.js';
import { parseJson, requestText, type Fetch } from './http.js';

const pageSchema = z.object({
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative().optional(),
  events: z.array(z.record(z.unknown())).max(200),
});
const datetimeSchema = z.string().datetime({ offset: true });

/** API Connect v10 native Analytics API, exposed through the Platform API host.
 * Contract: IBM apidocs v10/10.0.8.LATEST/apis.js, events_catalogList.
 * Never follow pagination URLs from upstream: keep token and requests on this origin.
 */
export async function getApiConnectEvents(config: Config, input: AnalyticsSearchInput, fetcher: Fetch): Promise<LogEntry[]> {
  const segments = [config.APIC_ANALYTICS_SERVICE, config.APIC_ORG, config.APIC_CATALOG].map(encodeURIComponent);
  const url = new URL(`/analytics/${segments[0]}/catalogs/${segments[1]}/${segments[2]}/events`, config.APIC_PLATFORM_URL);
  // "equals:" prevents IDs like "not:123" being interpreted as Analytics operators.
  url.searchParams.set(config.APIC_TRANSACTION_FIELD, `equals:${input.transactionId}`);
  url.searchParams.set('start', input.from);
  url.searchParams.set('end', input.to);
  url.searchParams.set('limit', '100');
  const entries: LogEntry[] = [];
  let expectedTotal: number | undefined;
  const ids = new Set<string>();
  for (let page = 0; page < 20; page++) {
    url.searchParams.set('offset', String(entries.length));
    const text = await requestText(fetcher, 'API Connect Analytics', url.href, {
      headers: { authorization: `Bearer ${config.APIC_TOKEN}`, accept: 'application/json' },
    }, config.UPSTREAM_TIMEOUT_MS);
    const parsed = pageSchema.safeParse(parseJson(text, 'API Connect Analytics'));
    if (!parsed.success) throw new ServiceError('UPSTREAM_INVALID_RESPONSE', 'API Connect Analytics must return {total, events: [...]}');
    const data = parsed.data;
    if (data.total > 200) throw new ServiceError('LOG_LIMIT_EXCEEDED', 'More than 200 API Connect events; narrow the time range', 422);
    if (expectedTotal !== undefined && data.total !== expectedTotal)
      throw new ServiceError('APIC_RESULTS_CHANGED', 'API Connect event count changed during pagination; retry the analysis');
    expectedTotal = data.total;
    if ((data.offset !== undefined && data.offset !== entries.length) || data.events.length > 100 || entries.length + data.events.length > data.total)
      throw new ServiceError('UPSTREAM_INVALID_RESPONSE', 'API Connect returned inconsistent pagination');
    for (const row of data.events) {
      // The published Event schema wraps the body in "event"; some deployments flatten it.
      const body = z.record(z.unknown()).safeParse(row.event === undefined ? row : row.event);
      if (!body.success || !datetimeSchema.safeParse(body.data.datetime).success ||
          !['string', 'number'].includes(typeof body.data[config.APIC_TRANSACTION_FIELD]) ||
          String(body.data[config.APIC_TRANSACTION_FIELD]) !== input.transactionId)
        throw new ServiceError('APIC_EVENT_SCOPE_MISMATCH', 'API Connect returned an event outside the requested transaction scope or without a valid datetime');
      const time = Date.parse(body.data.datetime as string);
      if (time < Date.parse(input.from) || time > Date.parse(input.to))
        throw new ServiceError('APIC_EVENT_SCOPE_MISMATCH', 'API Connect returned an event outside the requested time range');
      if (typeof row.id === 'string') {
        if (ids.has(row.id)) throw new ServiceError('UPSTREAM_INVALID_RESPONSE', 'API Connect returned duplicate event IDs during pagination');
        ids.add(row.id);
      }
      entries.push({ id: `apic:${entries.length + 1}`, source: 'api-connect', data: row });
    }
    if (entries.length === data.total) return entries;
    if (!data.events.length) throw new ServiceError('APIC_INCOMPLETE_RESULTS', 'API Connect returned an incomplete event list');
  }
  throw new ServiceError('APIC_INCOMPLETE_RESULTS', 'API Connect pagination exceeded the request budget');
}
