import { Worker } from 'node:worker_threads';
import { childPath, mandatoryKey, ruleFor, type Policy } from './policy.js';
import { valueType } from './shape.js';
import { ServiceError } from '../contracts.js';

type RecordValue = Record<string, unknown>;
export const record = (v: unknown): v is RecordValue => !!v && typeof v === 'object' && !Array.isArray(v);
export type Finding = {
  logId: string; fieldPath: string; specPointer: string | null; constraint: string;
  observed: Record<string, unknown>; result: 'pass' | 'fail' | 'not_evaluated'; explanation: string;
};
type Resolved = { schema: RecordValue; pointer: string } | { reason: string; pointer: string | null };
function resolve(spec: RecordValue, schema: unknown, pointer: string, seen = new Set<string>()): Resolved {
  if (!record(schema)) return { reason: 'Schema is missing or is outside the supported object-schema subset', pointer: schema === undefined ? null : pointer };
  if (!Object.hasOwn(schema, '$ref')) return { schema, pointer };
  if (typeof schema.$ref !== 'string' || !schema.$ref.startsWith('#/')) return { reason: 'External or unsupported reference; not resolved', pointer: childPath(pointer, '$ref') };
  if (Object.keys(schema).length !== 1) return { reason: 'Reference siblings are outside the supported subset', pointer };
  const ref = schema.$ref;
  if (seen.has(ref) || seen.size >= 16 || /~(?![01])/.test(ref)) return { reason: 'Cyclic or unsupported reference', pointer };
  seen.add(ref);
  let target: unknown = spec;
  for (const key of ref.slice(2).split('/').map(s => s.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (!record(target) || !Object.hasOwn(target, key)) return { reason: 'Reference target is unavailable', pointer };
    target = target[key];
  }
  return resolve(spec, target, ref.slice(1), seen);
}

// Native ECMAScript matching (unanchored unless the schema anchors it), off the event loop.
// Pattern/input limits and worker termination bound both invalid and adversarial expressions.
async function testPatterns(jobs: { pattern: string; value: string }[], policy: Policy): Promise<('pass' | 'fail' | 'not_evaluated')[]> {
  if (!jobs.length) return [];
  return new Promise(resolveResult => {
    const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads');
      parentPort.postMessage('ready'); parentPort.once('message',()=>{
        parentPort.postMessage(workerData.map(j=>{try{return new RegExp(j.pattern,'u').test(j.value)?'pass':'fail'}catch{return 'not_evaluated'}}));
      });`, { eval: true, workerData: jobs, resourceLimits: { maxOldGenerationSizeMb: 16, stackSizeMb: 1 } });
    let finished = false;
    let timer = setTimeout(() => finish(jobs.map(() => 'not_evaluated')), 2000);
    function finish(result: ('pass' | 'fail' | 'not_evaluated')[]) {
      if (finished) return;
      finished = true; clearTimeout(timer); void worker.terminate(); resolveResult(result);
    }
    worker.on('message', message => {
      if (message === 'ready') {
        clearTimeout(timer); timer = setTimeout(() => finish(jobs.map(() => 'not_evaluated')), policy.limits.regexTimeoutMs);
        worker.postMessage('run');
      } else finish(message);
    });
    worker.once('error', () => finish(jobs.map(() => 'not_evaluated')));
    worker.once('exit', () => finish(jobs.map(() => 'not_evaluated')));
  });
}

/** Only explicit operation_path + method + JSON content type can establish a body mapping.
 * Mapping failures produce findings, never block the existing analysis workflow. */
export async function validateRequest(
  spec: RecordValue, data: RecordValue, basePath: string, logId: string, policy: Policy,
  shape: (value: unknown, path: string) => Record<string, unknown>,
  credentialValue: (value: unknown) => boolean = () => false,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const jobs: { pattern: string; value: string; finding: Finding }[] = [];
  const bodyPath = childPath(basePath, 'request_body');
  const bodyRule = ruleFor(policy, bodyPath);
  if (!bodyRule || !['sanitize_nested', 'shape_and_validate'].includes(bodyRule.action)) return findings;
  let body: unknown = data.request_body;
  const bodyPresent = Object.hasOwn(data, 'request_body');
  function add(path: string, value: unknown, pointer: string | null, constraint: string, result: Finding['result'], explanation: string, present = true) {
    if (findings.length >= policy.limits.maxFindings) throw new ServiceError('CONTEXT_TOO_LARGE', 'Local validation exceeds the findings budget', 422);
    const f: Finding = { logId, fieldPath: path, specPointer: pointer, constraint, observed: present ? shape(value, path) : { presence: 'missing' }, result, explanation };
    findings.push(f); return f;
  }
  if (typeof body === 'string') {
    if (body.length > policy.limits.maxFieldChars) {
      add(bodyPath, body, null, 'mapping', 'not_evaluated', 'JSON body exceeds the parsing budget'); return findings;
    }
    try { body = JSON.parse(body); }
    catch { add(bodyPath, body, null, 'mapping', 'not_evaluated', 'Request body is not parseable JSON'); return findings; }
  }
  let resolved: Resolved = { reason: 'No reliable operation and JSON media-type mapping', pointer: null };
  const method = data.method ?? data.request_method;
  const path = data.operation_path;
  const contentType = typeof data.request_content_type === 'string' ? data.request_content_type.split(';')[0]!.trim().toLowerCase() : '';
  const supportedVersion = spec.swagger === '2.0' || /^3\.[01]\.\d+$/.test(String(spec.openapi));
  if (supportedVersion && typeof path === 'string' && typeof method === 'string' &&
      (!data.request_method || !data.method || String(data.request_method).toLowerCase() === String(data.method).toLowerCase()) &&
      record(spec.paths) && Object.hasOwn(spec.paths, path)) {
    const item = spec.paths[path];
    const op = record(item) ? item[method.toLowerCase()] : undefined;
    const opPath = `/paths/${path.replaceAll('~', '~0').replaceAll('/', '~1')}/${method.toLowerCase()}`;
    if (record(op)) {
      if (spec.swagger === '2.0') {
        const consumes = op.consumes ?? spec.consumes;
        const parameters = Array.isArray(op.parameters) ? op.parameters : [];
        const candidates = parameters.map((p, i) => ({ p, i })).filter(({p}) => record(p) && p.in === 'body');
        if (Array.isArray(consumes) && consumes.includes(contentType) && contentType === 'application/json' && candidates.length === 1) {
          const candidate = candidates[0]!;
          const param = candidate.p as RecordValue;
          resolved = resolve(spec, param.schema, `${opPath}/parameters/${candidate.i}/schema`);
          if (!bodyPresent && param.required === true) add(bodyPath, undefined, `${opPath}/parameters/${candidate.i}/required`, 'required', 'fail', 'Required JSON body is absent', false);
        }
      } else {
        const rb = resolve(spec, op.requestBody, `${opPath}/requestBody`);
        if ('schema' in rb && record(rb.schema.content) && (contentType === 'application/json' || contentType.endsWith('+json')) && Object.hasOwn(rb.schema.content, contentType)) {
          const media = rb.schema.content[contentType];
          resolved = resolve(spec, record(media) ? media.schema : undefined, childPath(`${rb.pointer}/content`, contentType) + '/schema');
          if (!bodyPresent && rb.schema.required === true) add(bodyPath, undefined, `${rb.pointer}/required`, 'required', 'fail', 'Required JSON body is absent', false);
        } else if ('reason' in rb) resolved = rb;
      }
    }
  }
  let nodes = 0;
  function visit(value: unknown, present: boolean, schema: Resolved, path: string, depth: number, required?: { pointer: string; required: boolean }) {
    if (++nodes > policy.limits.maxNodes || depth > policy.limits.maxDepth) throw new ServiceError('CONTEXT_TOO_LARGE', 'Local validation exceeds the traversal budget', 422);
    const key = path.split('/').at(-1)!;
    if (mandatoryKey(key) || credentialValue(value)) return;
    const rule = ruleFor(policy, path);
    if (rule?.action === 'exclude' || rule?.action === 'redact') return;
    const evaluate = rule?.action === 'shape_and_validate' || (path === bodyPath && rule?.action === 'sanitize_nested');
    if ('schema' in schema && schema.schema.readOnly === true) {
      if (evaluate) add(path, value, childPath(schema.pointer, 'readOnly'), 'readOnly', 'not_evaluated', 'Response-only property; required does not apply to request validation', present);
      return;
    }
    if (evaluate && required?.required) add(path, value, required.pointer, 'required', present ? 'pass' : 'fail', present ? 'Required field is present' : 'Required field is absent', present);
    if (!present) return;
    if (evaluate) {
      if ('reason' in schema) add(path, value, schema.pointer, 'mapping', 'not_evaluated', schema.reason);
      else {
        const s = schema.schema;
        let constraints = 0;
        const check = (keyword: string, result: Finding['result'], message: string) => { constraints++; return add(path, value, childPath(schema.pointer, keyword), keyword, result, message); };
        const oversized = (typeof value === 'string' && value.length > policy.limits.maxFieldChars) ||
          (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))));
        if (oversized) { constraints++; add(path, value, schema.pointer, 'validation_budget', 'not_evaluated', 'Value exceeds the local validation budget'); }
        else {
          if (Object.hasOwn(s, 'type')) {
            const types = Array.isArray(s.type) && String(spec.openapi).startsWith('3.1.') ? s.type : [s.type];
            const validTypes = ['null','object','array','string','number','integer','boolean'];
            if (Object.hasOwn(s, 'x-nullable')) check('type', 'not_evaluated', 'Swagger nullable extension is outside the supported subset');
            else if (!types.length || types.some(t => typeof t !== 'string' || !validTypes.includes(t))) check('type', 'not_evaluated', 'Unsupported or invalid type constraint');
            else {
              const nullable = String(spec.openapi).startsWith('3.0.') && s.nullable === true && typeof s.type === 'string';
              const ok = (value === null && nullable) || types.some(t => t === 'integer' ? typeof value === 'number' && Number.isInteger(value) : t === valueType(value));
              check('type', ok ? 'pass' : 'fail', ok ? 'Observed type satisfies this constraint' : 'Observed type violates this constraint');
            }
          }
          for (const keyword of ['minLength', 'maxLength', 'minimum', 'maximum'] as const) {
            if (!Object.hasOwn(s, keyword)) continue;
            const bound = s[keyword];
            const length = keyword.endsWith('Length');
            const exclusive = keyword === 'minimum' ? 'exclusiveMinimum' : keyword === 'maximum' ? 'exclusiveMaximum' : undefined;
            if (exclusive && Object.hasOwn(s, exclusive)) check(keyword, 'not_evaluated', 'Exclusive-bound interaction is outside the supported subset');
            else if (typeof bound !== 'number' || !Number.isFinite(bound) || (length && (!Number.isInteger(bound) || bound < 0))) check(keyword, 'not_evaluated', 'Invalid schema constraint');
            else if ((length && typeof value !== 'string') || (!length && typeof value !== 'number')) check(keyword, 'not_evaluated', 'Constraint is not applicable to the observed type');
            else {
              const actual = length ? Array.from(value as string).length : value as number;
              const ok = keyword.startsWith('min') ? actual >= bound : actual <= bound;
              check(keyword, ok ? 'pass' : 'fail', ok ? 'Value satisfies this bound' : 'Value violates this bound');
            }
          }
          if (Object.hasOwn(s, 'enum')) {
            if (!Array.isArray(s.enum) || !s.enum.length || s.enum.length > 100 || s.enum.some(v => (v !== null && !['string','number','boolean'].includes(typeof v)) || (typeof v === 'number' && !Number.isFinite(v)))) check('enum', 'not_evaluated', 'Only nonempty bounded primitive enums are supported');
            else check('enum', s.enum.some(v => v === value) ? 'pass' : 'fail', 'Compared original value to enum locally; literals withheld');
          }
          if (Object.hasOwn(s, 'pattern')) {
            if (typeof s.pattern !== 'string' || s.pattern.length > policy.limits.maxPatternChars || typeof value !== 'string') check('pattern', 'not_evaluated', 'Pattern is invalid, inapplicable or exceeds the budget');
            else {
              const finding = check('pattern', 'not_evaluated', 'Pattern evaluation pending');
              if (finding) jobs.push({ pattern: s.pattern, value, finding });
            }
          }
        }
        const supported = new Set(['type','nullable','properties','required','items','minLength','maxLength','pattern','enum','minimum','maximum','title','description','example','examples','default','deprecated']);
        for (const keyword of Object.keys(s)) {
          if (!supported.has(keyword)) check(keyword, 'not_evaluated', 'Constraint or annotation is outside the supported validation subset');
        }
        if (s.required !== undefined && (!Array.isArray(s.required) || s.required.some(v => typeof v !== 'string'))) check('required', 'not_evaluated', 'Invalid required constraint');
        if (!constraints) add(path, value, schema.pointer, 'schema', 'not_evaluated', 'No supported constraints available');
      }
    }
    const current = 'schema' in schema ? schema.schema : undefined;
    if (record(value)) {
      const properties = current && record(current.properties) ? current.properties : {};
      const requiredNames = current && Array.isArray(current.required) ? current.required.filter((v): v is string => typeof v === 'string') : [];
      for (const name of new Set([...Object.keys(value), ...requiredNames])) {
        const next = current && Object.hasOwn(properties, name) ? resolve(spec, properties[name], childPath(schema.pointer! + '/properties', name)) : { reason: 'Field cannot be reliably mapped to a schema property', pointer: null };
        visit(value[name], Object.hasOwn(value, name), next, childPath(path, name), depth + 1,
          current ? { pointer: schema.pointer! + '/required', required: requiredNames.includes(name) } : undefined);
      }
    } else if (Array.isArray(value)) value.forEach((item, i) => visit(item, true, current ? resolve(spec, current.items, schema.pointer! + '/items') : schema, childPath(path, String(i)), depth + 1));
  }
  visit(body, bodyPresent, resolved, bodyPath, 0);
  const results = await testPatterns(jobs, policy);
  jobs.forEach((job, i) => {
    job.finding.result = results[i]!;
    job.finding.explanation = results[i] === 'not_evaluated' ? 'Pattern is invalid or exceeded the isolated execution budget' : results[i] === 'pass' ? 'Original string matches the schema pattern' : 'Original string does not match the schema pattern';
  });
  return findings;
}
