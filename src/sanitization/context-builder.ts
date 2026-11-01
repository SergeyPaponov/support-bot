import type { AnalysisInput, Diagnosis, LogEntry } from '../contracts.js';
import { ServiceError } from '../contracts.js';
import { redactText } from '../redact.js';
import { childPath, freeTextKey, mandatoryKey, protectedKey, ruleFor, type Policy } from './policy.js';
import { describeShape, ProtectionScope } from './shape.js';
import { record, validateRequest, type Finding } from './validation.js';

function classify(text: string) {
  const codes: string[] = [];
  for (const [pattern, code] of [
    [/\b(?:missing|required)\b/i, 'required_field_error'], [/\b(?:pattern|regex|format)\b/i, 'format_error'],
    [/\b(?:length|too short|too long)\b/i, 'length_error'], [/\benum\b/i, 'enum_error'],
    [/\b(?:type|integer|numeric)\b/i, 'type_error'], [/\b400\b/, 'http_400'],
  ] as const) if (pattern.test(text)) codes.push(code);
  return { protected: true, diagnosticSignals: codes };
}

export async function buildDiagnosticContext(input: AnalysisInput, logs: LogEntry[], spec: Record<string, unknown>, policy: Policy, secrets: string[]) {
  const scope = new ProtectionScope();
  let selectedFields: { fieldPath: string; observed: Record<string, unknown> }[] = [];
  const fieldNames = new Set(['logs','data','event','request_body','_raw']);
  for (const rule of policy.rules) for (const segment of rule.path.split('/').slice(1)) {
    if (segment !== '*' && segment !== '**') fieldNames.add(segment.replaceAll('~1','/').replaceAll('~0','~'));
  }
  let nodes = 0;
  const budget = (depth: number) => {
    if (++nodes > policy.limits.maxNodes || depth > policy.limits.maxDepth)
      throw new ServiceError('CONTEXT_TOO_LARGE', 'Source data exceeds the sanitization resource budget', 422);
  };
  const rememberText = (text: string) => {
    scope.remember(text);
    // Additional defense for values embedded in free text. Free text itself never leaves the process.
    for (const match of text.matchAll(/(?:[A-Za-z_][A-Za-z0-9_-]{0,63})\s*[=:]\s*(?:"([^"\r\n]{1,4096})"|'([^'\r\n]{1,4096})'|([^\s,;]{1,4096}))/g)) scope.remember(match[1] ?? match[2] ?? match[3]);
    for (const match of text.matchAll(/\b(?:Bearer|Basic)\s+([^\s,;]{1,4096})|[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,63}/gi)) scope.remember(match[1] ?? match[0]);
  };
  function collectSchemaNames(value: unknown, depth = 0) {
    budget(depth);
    if (Array.isArray(value)) value.forEach(v => collectSchemaNames(v,depth + 1));
    else if (record(value)) {
      if (record(value.properties)) Object.keys(value.properties).forEach(key => fieldNames.add(key));
      Object.values(value).forEach(v => { if (v && typeof v === 'object') collectSchemaNames(v,depth + 1); });
    }
  }
  const safeFieldName = (name: string) => (fieldNames.has(name) || /^\d{1,4}$/.test(name)) && redactText(name, secrets) === name;
  const safeFieldPath = (path: string) => path.split('/').map((s,i) => !i || safeFieldName(s.replaceAll('~1','/').replaceAll('~0','~')) ? s : '*').join('/');
  function remember(value: unknown, depth = 0) {
    budget(depth);
    if (typeof value === 'string') rememberText(value);
    else if (Array.isArray(value)) value.forEach(v => remember(v, depth + 1));
    else if (record(value)) Object.values(value).forEach(v => remember(v, depth + 1));
    else scope.remember(value);
  }
  secrets.forEach(s => scope.remember(s));
  // Correlation identifiers are echoed by the public API, but are not sent to the LLM.
  scope.remember(input.transactionId); scope.remember(input.apiId);
  const credentialValue = (value: unknown) => typeof value === 'string' && (
    secrets.some(secret => secret.length > 0 && value.includes(secret)) ||
    /^\s*(?:Bearer|Basic)\s+\S+/i.test(value) || /-----BEGIN(?: [A-Z]+)* PRIVATE KEY-----/i.test(value));
  const shape = (value: unknown, path: string) => {
    const key = path.split('/').at(-1)!;
    if (mandatoryKey(key) || credentialValue(value)) return { protected: true };
    if (typeof value === 'string' && value.length > policy.limits.maxFieldChars) return { protected: true, type: 'string', budgetExceeded: true };
    const options = ruleFor(policy, path)?.shape;
    const result = describeShape(value, options);
    if (options?.correlate && (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)))) result.reference = scope.reference(value);
    return result;
  };
  function sanitize(value: unknown, path: string, key: string, depth: number): unknown {
    budget(depth);
    const rule = ruleFor(policy, path);
    if (mandatoryKey(key)) { remember(value); return rule && rule.action !== 'exclude' ? { protected: true } : undefined; }
    if (rule?.action === 'exclude') { remember(value); return undefined; }
    if (rule?.action === 'redact') { remember(value); return { protected: true }; }
    if (rule?.action === 'shape_and_validate') {
      remember(value);
      if (credentialValue(value)) return { protected: true };
      const observed = shape(value, path);
      selectedFields.push({ fieldPath: path, observed });
      return observed;
    }
    if (typeof value === 'string' && rule?.action === 'sanitize_nested') {
      // Parse only explicitly selected JSON containers; parsing failure never falls back to raw text.
      rememberText(value);
      if (value.length > policy.limits.maxFieldChars) return { protected: true, parsing: 'size_limit' };
      try { return sanitize(JSON.parse(value), path, key, depth + 1); }
      catch (error) { if (error instanceof ServiceError) throw error; return { protected: true, parsing: 'failed' }; }
    }
    if (rule?.action === 'allow' && !record(value) && !Array.isArray(value)) {
      if (freeTextKey(key)) { remember(value); return policy.freeText === 'classify' && typeof value === 'string' ? classify(value.slice(0, policy.limits.maxFieldChars)) : undefined; }
      if (protectedKey(key) || (typeof value === 'string' && (value.length > policy.limits.maxFieldChars || redactText(value, secrets) !== value || /-----BEGIN.*PRIVATE KEY/.test(value)))) {
        remember(value); return { protected: true };
      }
      if (rule.values && !rule.values.includes(value as string | number | boolean)) { remember(value); return { protected: true }; }
      if (typeof value === 'string' && !rule.values) { remember(value); return { protected: true }; }
      if (value === null || ['string','number','boolean'].includes(typeof value)) return value;
      return undefined;
    }
    // An allow rule never recursively allows an object. Every descendant needs its own rule.
    if (record(value)) {
      const entries: [string, unknown][] = [];
      for (const [name, child] of Object.entries(value)) {
        const safe = sanitize(child, childPath(path, name), name, depth + 1);
        if (safe !== undefined) entries.push([safeFieldName(name) ? name : `[unmapped-field-${entries.length + 1}]`, safe]);
      }
      return entries.length ? Object.fromEntries(entries) : undefined;
    }
    if (Array.isArray(value)) {
      const safe = value.map((v,i) => sanitize(v, childPath(path, String(i)), String(i), depth + 1));
      return safe.some(v => v !== undefined) ? safe.map(v => v ?? { protected: true }) : undefined;
    }
    remember(value); return undefined;
  }

  function projectSpec(value: unknown, path = '', mode = 'schema', depth = 0): unknown {
    budget(depth);
    const selected = ruleFor(policy, '/spec' + path);
    if (selected && ['exclude','redact','shape_and_validate'].includes(selected.action)) {
      remember(value);
      return selected.action === 'exclude' ? undefined : { protected: true };
    }
    if (Array.isArray(value)) return value.map((v,i) => projectSpec(v, childPath(path, String(i)), mode, depth + 1));
    if (!record(value)) return {};
    const result: Record<string, unknown> = Object.create(null);
    const containers = new Set(['schema','properties','items','requestBody','content','parameters','responses','components','schemas','definitions','requestBodies','paths']);
    const dynamic = ['paths','properties','schemas','definitions','content','requestBodies','responses'].includes(mode);
    for (const [key, child] of Object.entries(value)) {
      const childPointer = childPath(path, key);
      if (redactText(key, secrets) !== key) { remember(child); continue; }
      const childRule = ruleFor(policy, '/spec' + childPointer);
      if (childRule?.action === 'exclude') { remember(child); continue; }
      if (childRule?.action === 'redact') { remember(child); result[key] = { protected: true }; continue; }
      if (mandatoryKey(key) && !dynamic) { remember(child); result[key] = { protected: true }; continue; }
      if (['description','summary','title','example','examples','default','enum','const','pattern','$ref'].includes(key) && !dynamic) {
        remember(child); result[key] = { protected: true }; continue;
      }
      if (dynamic || containers.has(key) || /^(get|put|post|patch|delete|head|options|trace)$/i.test(key)) {
        result[key] = projectSpec(child, childPointer, dynamic && mode === 'paths' ? 'pathItem' : dynamic ? 'schema' : key, depth + 1);
      } else if (['openapi','swagger','type','required','minLength','maxLength','minimum','maximum','nullable','in','name'].includes(key)) {
        // Only approved technical metadata can be allowed; examples/enum/pattern literals cannot.
        if (ruleFor(policy, '/spec' + childPointer)?.action !== 'allow') { remember(child); result[key] = { protected: true }; }
        else if (typeof child === 'string') {
          const valid = child.length <= policy.limits.maxFieldChars && (
            (key === 'type' && ['null','object','array','string','number','integer','boolean'].includes(child)) ||
            (key === 'openapi' && /^3\.[01]\.\d+$/.test(child)) || (key === 'swagger' && child === '2.0') ||
            (key === 'in' && ['body','query','path','header','cookie','formData'].includes(child)) ||
            (key === 'name' && /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(child)));
          result[key] = valid ? redactText(child, secrets) : { protected: true };
          if (result[key] !== child) remember(child);
        } else if (typeof child === 'boolean' || typeof child === 'number') result[key] = child;
        else if ((key === 'required' || key === 'type') && Array.isArray(child) && child.every(v => typeof v === 'string' && (key !== 'type' || ['null','object','array','string','number','integer','boolean'].includes(v)))) result[key] = child.map(v => {
          budget(depth + 1);
          if (v.length > policy.limits.maxFieldChars) { remember(v); return { protected: true }; }
          return redactText(v, secrets);
        });
        else { remember(child); result[key] = { protected: true }; }
      } else { remember(child); result[key] = { protected: true }; }
    }
    return result;
  }
  try {
    collectSchemaNames(spec);
    const safeLogs: { id: string; source: LogEntry['source']; data: unknown }[] = [];
    const findings: Finding[] = [];
    for (const [index, log] of logs.entries()) {
      selectedFields = [];
      const base = `/logs/${index}/data`;
      const data = record(log.data) ? log.data : {};
      const event = record(data.event) ? data.event : data;
      const eventPath = record(data.event) ? base + '/event' : base;
      const localFindings = await validateRequest(spec, event, eventPath, log.id, policy, shape, credentialValue);
      if (typeof data._raw === 'string' && ruleFor(policy, base + '/_raw')?.action === 'sanitize_nested' && data._raw.length <= policy.limits.maxFieldChars) {
        let parsed: unknown;
        try { parsed = JSON.parse(data._raw); } catch { /* The sanitized context already records parsing failure. */ }
        if (record(parsed)) {
          const rawFindings = await validateRequest(spec, parsed, base + '/_raw', log.id, policy, shape, credentialValue);
          localFindings.push(...rawFindings);
        }
      }
      // Validate untouched original values first, then select and sanitize outbound fields.
      safeLogs.push({ id: log.id, source: log.source, data: sanitize(log.data, base, 'data', 0) ?? { protected: true } });
      for (const selected of selectedFields) {
        if (!localFindings.some(f => f.fieldPath === selected.fieldPath)) localFindings.push({
          logId: log.id, fieldPath: selected.fieldPath, specPointer: null, constraint: 'mapping', observed: selected.observed,
          result: 'not_evaluated', explanation: 'Field has no supported JSON request-body schema mapping',
        });
      }
      findings.push(...localFindings.map(f => ({ ...f, fieldPath: safeFieldPath(f.fieldPath),
        constraint: redactText(f.constraint, secrets),
        specPointer: f.specPointer !== null && redactText(f.specPointer, secrets) !== f.specPointer ? null : f.specPointer,
      })));
      if (findings.length > policy.limits.maxFindings) throw new ServiceError('CONTEXT_TOO_LARGE', 'Too many validation findings for the sanitization budget', 422);
    }
    const safeSpec = projectSpec(spec);
    const context = { logs: safeLogs, spec: safeSpec, validationFindings: findings,
      sanitization: { policyVersion: policy.version, shapeIsNotValidationEquivalent: true, validationScope: 'individual supported constraints only; not whole-request validity' } };
    function protectDiagnosis(diagnosis: Diagnosis): Diagnosis {
      const scrub = (text: string) => redactText(scope.scrub(text), secrets);
      // Preserve protocol metadata. A pointer containing a credential must be withheld, not rewritten.
      return { ...diagnosis, summary: scrub(diagnosis.summary), probableCause: scrub(diagnosis.probableCause),
        evidence: diagnosis.evidence.map(e => ({ ...e, explanation: scrub(e.explanation), specPointer: e.specPointer !== null && redactText(e.specPointer,secrets) !== e.specPointer ? null : e.specPointer })),
        nextSteps: diagnosis.nextSteps.map(scrub), missingInformation: diagnosis.missingInformation.map(scrub) };
    }
    return { context, safeSpec, protectDiagnosis, dispose: () => scope.clear() };
  } catch (error) { scope.clear(); throw error; }
}
