import type { Config } from './config.js';
import { ServiceError, type LogEntry } from './contracts.js';

const namePattern = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}$/;
const versionPattern = /^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,254}$/;
const scopePattern = /^[A-Za-z0-9_-]{1,200}$/;
export type ApiIdentity = {
  name: string; version?: string; apiRef?: string;
  org: string; catalog: string; orgAliases: string[]; catalogAliases: string[];
};
function conflict(): never {
  throw new ServiceError('API_IDENTITY_AMBIGUOUS', 'Transaction metadata does not identify a single API and scope', 422);
}
function one(values: Set<string>): string | undefined {
  if (values.size > 1) conflict();
  return values.values().next().value;
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Confirmed Analytics api_ref format is name:version; never interpret it as a URL.
 * Missing fields in individual records do not discard other records of the transaction.
 */
export function transactionApiIdentity(logs: LogEntry[], config: Config): ApiIdentity {
  const refs = new Set<string>(), names = new Set<string>(), versions = new Set<string>();
  const scopes = Object.fromEntries(['org_id', 'org_name', 'catalog_id', 'catalog_name'].map(key => [key, new Set<string>()]));
  for (const log of logs) {
    if (!object(log.data)) continue;
    const event = object(log.data.event) ? log.data.event : log.data;
    const ref = typeof event.api_ref === 'string' ? event.api_ref.split(':') : [];
    const validRef = ref.length === 2 && namePattern.test(ref[0]!) && versionPattern.test(ref[1]!);
    if (validRef) {
      refs.add(event.api_ref as string); names.add(ref[0]!); versions.add(ref[1]!);
    } else if (typeof event.api_name === 'string' && namePattern.test(event.api_name)) {
      names.add(event.api_name);
    }
    if (event.api_version !== undefined && event.api_version !== null && event.api_version !== '') {
      if (typeof event.api_version !== 'string' || !versionPattern.test(event.api_version)) conflict();
      versions.add(event.api_version);
    }
    for (const [key, values] of Object.entries(scopes)) {
      const value = event[key];
      if (value === undefined || value === null || value === '') continue;
      if (typeof value !== 'string' || !scopePattern.test(value)) conflict();
      values.add(value);
    }
  }
  const apiRef = one(refs), name = one(names), version = one(versions);
  if (!name) throw new ServiceError('API_IDENTITY_UNRESOLVED', 'Transaction metadata does not contain a usable API reference or name', 422);
  function scope(kind: 'org' | 'catalog', configured: string) {
    const id = one(scopes[kind + '_id']!), scopeName = one(scopes[kind + '_name']!);
    const aliases = [id, scopeName].filter((s): s is string => !!s);
    if (aliases.length && !aliases.includes(configured)) {
      throw new ServiceError('API_SCOPE_MISMATCH', 'Transaction scope does not match the configured Analytics scope', 422);
    }
    // Analytics was queried in this configured scope. Keep that authoritative
    // selector instead of letting a returned id/name pair expand tenant access.
    return { selected: configured, aliases: aliases.length ? aliases : [configured] };
  }
  const org = scope('org', config.APIC_ORG), catalog = scope('catalog', config.APIC_CATALOG);
  return { apiRef, name, version, org: org.selected, catalog: catalog.selected, orgAliases: org.aliases, catalogAliases: catalog.aliases };
}
