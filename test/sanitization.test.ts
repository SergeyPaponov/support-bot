import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPolicy, policySchema, ruleFor, type Policy } from '../src/sanitization/policy.js';
import { buildDiagnosticContext } from '../src/sanitization/context-builder.js';
import { describeShape } from '../src/sanitization/shape.js';
import { Analyzer } from '../src/analyzer.js';
import { readConfig } from '../src/config.js';
import type { Diagnosis } from '../src/contracts.js';

const input = { transactionId: 'tx-synthetic', apiId: 'synthetic-api', from: '2026-11-01T09:00:00Z', to: '2026-11-01T10:00:00Z' };
const secret = 'synthetic-credential-must-stay-local';
function policy(detailed = false): Policy {
  const p = loadPolicy();
  p.rules = p.rules.filter(r => !r.path.includes('/request_body/'));
  p.rules.push({ path: '/logs/*/data/request_body/**', action: 'shape_and_validate', ...(detailed ? { shape: { length: true, categories: true, positions: true, separators: ['-', '#'], numericFormat: true, correlate: true } } : {}) });
  return policySchema.parse(p);
}
function spec(properties: Record<string,unknown> = { code: { type: 'string', pattern: '^[A-Z]{2}-[0-9]{2}[A-Z]$' } }, extra: Record<string,unknown> = {}) {
  return { openapi: '3.0.3', paths: { '/payments': { post: { requestBody: {
    required: true, content: { 'application/json': { schema: { type: 'object', properties, ...extra } } },
  } } } } };
}
function data(body: unknown) {
  return { status: 400, method: 'POST', operation_path: '/payments', request_content_type: 'application/json', request_body: body };
}
async function build(body: unknown, schema: Record<string,unknown> = spec(), p = policy(), patch: Record<string,unknown> = {}) {
  return buildDiagnosticContext(input, [{ id: 'splunk:1', source: 'splunk', data: { ...data(body), ...patch } }], schema, p, [secret]);
}
const findingFor = (built: Awaited<ReturnType<typeof build>>, field: string, constraint: string) => built.context.validationFindings.find(f => f.fieldPath.endsWith('/'+field) && f.constraint === constraint);

test('HTTP 400 pattern anomaly is evaluated against the original, with safe shape and evidence', async () => {
  const b = await build({ code: 'AB-12#C' }, spec(), policy(true));
  try {
    const f = findingFor(b, 'code', 'pattern')!;
    assert.equal(f.result, 'fail');
    assert.equal(f.logId, 'splunk:1');
    assert.equal(f.specPointer, '/paths/~1payments/post/requestBody/content/application~1json/schema/properties/code/pattern');
    assert.equal(f.observed.length, 7);
    assert.equal(f.observed.shape, 'UU-DD#U');
    assert.deepEqual(f.observed.categories, ['D','S','U']);
    assert.ok(!JSON.stringify(b.context).includes('AB-12#C'));
    assert.equal((b.context.logs[0]!.data as {status:number}).status, 400);
  } finally { b.dispose(); }
});
test('wrong categories, lengths and unexpected special characters remain distinguishable', async () => {
  for (const [value, expectedPattern, expectedLength] of [['ab-12C', 'fail','pass'], ['AB-1C','fail','fail'], ['AB-1#C','fail','pass'], ['AB-12C','pass','pass']] as const) {
    const b = await build({ code: value }, spec({ code: { type:'string', pattern:'^[A-Z]{2}-[0-9]{2}[A-Z]$', minLength:6, maxLength:6 } }), policy(true));
    try {
      assert.equal(findingFor(b,'code','pattern')?.result, expectedPattern);
      assert.equal(findingFor(b,'code','minLength')?.result, expectedLength);
      assert.ok(!JSON.stringify(b.context).includes(value));
    } finally { b.dispose(); }
  }
});
test('pattern matching is unanchored and uses the original rather than its category mask', async () => {
  const b = await build({ code: 'xxAB-12yy' }, spec({ code: { pattern:'AB-[0-9]{2}' } }));
  try { assert.equal(findingFor(b,'code','pattern')?.result,'pass'); }
  finally { b.dispose(); }
});
test('Unicode patterns operate on original characters and string maxLength can fail', async () => {
  const b = await build({code:'ЖЯБВ',long:'synthetic-too-long'},spec({code:{pattern:'^\\p{Lu}+$'},long:{maxLength:4}}));
  try {assert.equal(findingFor(b,'code','pattern')?.result,'pass');assert.equal(findingFor(b,'long','maxLength')?.result,'fail');}
  finally {b.dispose();}
});
test('missing required and invalid enums never disclose enum literals', async () => {
  const b = await build({ code:'ZZ-synthetic-9' }, spec({ code:{ enum:['AA-synthetic-1','BB-synthetic-2'] }, customerId:{type:'string'} }, { required:['customerId'] }));
  try {
    assert.equal(findingFor(b,'code','enum')?.result, 'fail');
    assert.equal(findingFor(b,'customerId','required')?.result,'fail');
    assert.deepEqual(findingFor(b,'customerId','required')?.observed,{presence:'missing'});
    for (const value of ['ZZ-synthetic-9','AA-synthetic-1','BB-synthetic-2']) assert.ok(!JSON.stringify(b.context).includes(value));
  } finally { b.dispose(); }
});
test('type, numeric bounds and Unicode code-point length use original values', async () => {
  const b = await build({ amount: -5, code:'😀', wrong:'12' }, spec({ amount:{type:'number',minimum:0,maximum:100}, code:{type:'string',minLength:1,maxLength:1},wrong:{type:'integer'} }));
  try {
    assert.equal(findingFor(b,'amount','minimum')?.result,'fail');
    assert.equal(findingFor(b,'amount','maximum')?.result,'pass');
    assert.equal(findingFor(b,'code','maxLength')?.result,'pass');
    assert.equal(findingFor(b,'wrong','type')?.result,'fail');
  } finally { b.dispose(); }
});
test('nested JSON strings are sanitized and validated, including arrays', async () => {
  const raw = JSON.stringify({ customer:{accountNumber:'00123457', private_key:'dummy-private-key'}, items:[{code:'ab-12C'}] });
  const b = await build(raw, spec({ customer:{type:'object',properties:{accountNumber:{type:'string',pattern:'^[0-9]{8}$'}, private_key:{type:'string'}}}, items:{type:'array',items:{type:'object',properties:{code:{pattern:'^[A-Z]{2}-[0-9]{2}[A-Z]$'}}}} }), policy(true));
  try {
    assert.equal(findingFor(b,'accountNumber','pattern')?.result,'pass');
    assert.equal(findingFor(b,'code','pattern')?.result,'fail');
    for (const value of ['00123457','dummy-private-key','ab-12C']) assert.ok(!JSON.stringify(b.context).includes(value));
    assert.ok(!b.context.validationFindings.some(f=>f.fieldPath.includes('private_key')));
  } finally { b.dispose(); }
});
test('detailed shape and repeated-value correlation are opt-in and request-local', async () => {
  const raw = { code:'AB-12#C', repeat:'AB-12#C' };
  const schema = spec({code:{type:'string'},repeat:{type:'string'}});
  const a = await build(raw, schema);
  const b = await build(raw, schema, policy(true));
  const c = await build(raw, schema, policy(true));
  try {
    const fields = (x: typeof a) => (x.context.logs[0]!.data as {request_body:Record<string,Record<string,unknown>>}).request_body;
    assert.equal(fields(a).code?.length,undefined);
    assert.equal(fields(a).code?.shape,undefined);
    assert.equal(fields(a).code?.reference,undefined);
    assert.equal(fields(b).code?.reference,fields(b).repeat?.reference);
    assert.notEqual(fields(b).code?.reference,fields(c).code?.reference);
  } finally { a.dispose(); b.dispose(); c.dispose(); }
});
test('leading zeros and numeric format are explicit metadata, low entropy is suppressed', () => {
  const options = {length:true,categories:true,positions:true,separators:[],numericFormat:true,correlate:false};
  const s = describeShape('001234.50', options);
  assert.deepEqual(s.numericFormat,{numericString:true,leadingZero:true,sign:false,decimal:true,exponent:false});
  assert.equal(s.shape,'DDDDDDSDD');
  assert.deepEqual(describeShape('1111',options),{protected:true,type:'string',detailSuppressed:'low_entropy'});
  assert.equal(describeShape('A',options).shape,undefined);
});
test('free-text content is classified, never forwarded, and embedded secrets are removed from diagnosis', async () => {
  const b = await build({}, spec(), policy(), {message:'Missing required accountNumber=1122334455 email=user@example.test Authorization=Bearer dummy-token'});
  try {
    const text = JSON.stringify(b.context);
    for (const value of ['1122334455','user@example.test','dummy-token']) assert.ok(!text.includes(value));
    assert.ok(text.includes('required_field_error'));
    const diagnosis: Diagnosis = {summary:'1122334455 user@example.test dummy-token',probableCause:'safe',confidence:'low',evidence:[],nextSteps:[],missingInformation:[]};
    const output = JSON.stringify(b.protectDiagnosis(diagnosis));
    for (const value of ['1122334455','user@example.test','dummy-token']) assert.ok(!output.includes(value));
  } finally { b.dispose(); }
});
test('mandatory credential protection cannot be overridden by allow or shape policy', async () => {
  const p = policy(true);
  p.rules.push({path:'/logs/*/data/request_body/PaSsWoRd',action:'allow'});
  const b = await build({PaSsWoRd:secret,access_token:'dummy-access-token',privateKey:'dummy-private-key',accountNumber:'12345678'},spec(),p);
  try {
    for (const value of [secret,'dummy-access-token','dummy-private-key','12345678']) assert.ok(!JSON.stringify(b.context).includes(value));
    assert.ok(!b.context.validationFindings.some(f=>/password|token|privatekey/i.test(f.fieldPath)));
  } finally { b.dispose(); }
});
test('known credentials, bearer strings and private key contents never receive detailed shapes under generic keys', async () => {
  const b=await build({code:secret,bearer:'Bearer synthetic-new-token',pem:'-----BEGIN PRIVATE KEY-----\nSYNTHETIC\n-----END PRIVATE KEY-----'},spec(),policy(true));
  try {
    assert.equal(b.context.validationFindings.length,1); // Only the body-level object type is evaluated.
    const fields=(b.context.logs[0]!.data as {request_body:Record<string,unknown>}).request_body;
    for(const value of Object.values(fields))assert.deepEqual(value,{protected:true});
    assert.ok(!JSON.stringify(b.context).includes(secret));
  }finally{b.dispose();}
});
test('default policy excludes unapproved body fields and detailed metadata', async () => {
  const b = await build({accountNumber:'00123457',unknown:'synthetic-customer-information'},spec(),loadPolicy());
  try {
    const text = JSON.stringify(b.context);
    assert.ok(!text.includes('synthetic-customer-information'));
    assert.ok(!text.includes('00123457'));
    assert.ok(!text.includes('"shape":'));
    assert.ok(!text.includes('"length":'));
  } finally { b.dispose(); }
});
test('missing operation or media type yields not_evaluated without blocking analysis', async () => {
  for (const patch of [{operation_path:undefined},{request_content_type:undefined},{method:'GET'}]) {
    const b=await build({code:'AB-12#C'},spec(),policy(),patch);
    try { assert.equal(findingFor(b,'code','mapping')?.result,'not_evaluated'); }
    finally { b.dispose(); }
  }
});
test('invalid JSON, unsupported format, missing and invalid constraints are explicit', async () => {
  const malformed=await build('{invalid-json-synthetic');
  const b=await build({code:'invalid-synthetic',empty:'local-only'},spec({code:{type:'string',minLength:-1,format:'uuid',pattern:'['},empty:{}}));
  try {
    assert.equal(malformed.context.validationFindings[0]?.result,'not_evaluated');
    for (const keyword of ['minLength','format','pattern']) assert.equal(findingFor(b,'code',keyword)?.result,'not_evaluated');
    assert.equal(findingFor(b,'empty','schema')?.result,'not_evaluated');
    assert.ok(!JSON.stringify(malformed.context).includes('{invalid-json-synthetic'));
  } finally { malformed.dispose(); b.dispose(); }
});
test('external references and composition are not claimed as evaluated', async () => {
  const b=await build({code:'sensitive-synthetic',other:'sensitive-second'},spec({code:{$ref:'https://external.example/schema'},other:{oneOf:[{type:'string'}]}}));
  try {
    assert.equal(findingFor(b,'code','mapping')?.result,'not_evaluated');
    assert.equal(findingFor(b,'other','oneOf')?.result,'not_evaluated');
  } finally { b.dispose(); }
});
test('internal schema refs are supported with original JSON pointers', async () => {
  const schema={...spec({code:{$ref:'#/components/schemas/Code'}}),components:{schemas:{Code:{type:'string',pattern:'^[A-Z]+$'}}}};
  const b=await build({code:'lowercase-synthetic'},schema);
  try { assert.equal(findingFor(b,'code','pattern')?.specPointer,'/components/schemas/Code/pattern');assert.equal(findingFor(b,'code','pattern')?.result,'fail'); }
  finally { b.dispose(); }
});
test('Swagger 2 JSON body schema is validated at its native pointer', async () => {
  const schema={swagger:'2.0',consumes:['application/json'],paths:{'/payments':{post:{parameters:[{in:'body',name:'body',schema:{type:'object',required:['code'],properties:{code:{type:'string',pattern:'^[A-Z]+$'}}}}]}}}};
  const b=await build({code:'lowercase-synthetic'},schema);
  try { assert.equal(findingFor(b,'code','pattern')?.result,'fail');assert.equal(findingFor(b,'code','pattern')?.specPointer,'/paths/~1payments/post/parameters/0/schema/properties/code/pattern'); }
  finally { b.dispose(); }
});
test('catastrophic regex runs outside the event loop and is not_evaluated on timeout', async () => {
  const p=policy();p.limits.regexTimeoutMs=20;
  const b=await build({code:'a'.repeat(1000)+'!'},spec({code:{pattern:'^(a+)+$'}}),p);
  try {assert.equal(findingFor(b,'code','pattern')?.result,'not_evaluated');}
  finally {b.dispose();}
});
test('policy schema rejects unsupported versions, invalid limits, duplicate paths and unsafe separator policies', () => {
  const p=loadPolicy();
  for (const value of [{...p,version:2},{...p,defaultAction:'allow'},{...p,limits:{...p.limits,maxDepth:100}},{...p,rules:[{path:'no-leading-slash',action:'allow'}]},{...p,rules:[p.rules[0],p.rules[0]]},{...p,rules:[{path:'/logs/**',action:'shape_and_validate',shape:{separators:['A']}}]}]) assert.equal(policySchema.safeParse(value).success,false);
  assert.throws(()=>loadPolicy('/no-such-sanitization-policy.json'),/Invalid or unreadable/);
});
test('exact rules take precedence over wildcards, with case-insensitive key protection', () => {
  const p=policySchema.parse({...loadPolicy(),rules:[{path:'/logs/**',action:'allow'},{path:'/logs/*/data/customerId',action:'redact'}]});
  assert.equal(ruleFor(p,'/logs/0/data/CUSTOMERID')?.action,'redact');
});
test('depth and node limits fail closed instead of forwarding unprocessed values', async () => {
  const p=policy();p.limits.maxDepth=2;
  await assert.rejects(()=>build({nested:{deeper:{value:'synthetic-hidden'}}},spec(),p),{code:'CONTEXT_TOO_LARGE'});
});
test('explicit _raw JSON selection permits local validation without provider changes', async () => {
  const p=loadPolicy();
  p.rules.push({path:'/logs/*/data/_raw',action:'sanitize_nested'},{path:'/logs/*/data/_raw/request_body',action:'sanitize_nested'},{path:'/logs/*/data/_raw/request_body/code',action:'shape_and_validate'});
  const b=await buildDiagnosticContext(input,[{id:'splunk:7',source:'splunk',data:{_raw:JSON.stringify(data({code:'ab-12C'}))}}],spec(),p,[secret]);
  try {assert.equal(findingFor(b,'code','pattern')?.result,'fail');assert.equal(findingFor(b,'code','pattern')?.logId,'splunk:7');assert.ok(!JSON.stringify(b.context).includes('ab-12C'));}
  finally {b.dispose();}
});
test('API Connect event wrappers retain evidence IDs for mapped request bodies', async () => {
  const p=policy();p.rules.push({path:'/logs/*/data/event/request_body/code',action:'shape_and_validate'});
  const b=await buildDiagnosticContext(input,[{id:'apic:5',source:'api-connect',data:{event:data({code:'ab-12C'})}}],spec(),p,[]);
  try {assert.equal(findingFor(b,'code','pattern')?.logId,'apic:5');assert.equal(findingFor(b,'code','pattern')?.result,'fail');}
  finally {b.dispose();}
});
test('shape-selected headers are explicitly not_evaluated and dynamic field names are withheld', async () => {
  const p=policy();p.rules.push({path:'/logs/*/data/request_headers/**',action:'shape_and_validate'});
  const b=await build({ 'user@example.test':'synthetic-value' },spec(),p,{request_headers:{'X-Customer':'synthetic-header'}});
  try {
    assert.ok(b.context.validationFindings.some(f=>f.fieldPath.includes('request_headers')&&f.result==='not_evaluated'));
    assert.ok(!JSON.stringify(b.context).includes('user@example.test'));
    assert.ok(!JSON.stringify(b.context).includes('synthetic-header'));
  } finally {b.dispose();}
});
test('readOnly required properties do not cause false missing-request failures', async () => {
  const b=await build({},spec({code:{type:'string',readOnly:true}},{required:['code']}));
  try {assert.ok(!b.context.validationFindings.some(f=>f.fieldPath.endsWith('/code')&&f.result==='fail'));assert.equal(findingFor(b,'code','readOnly')?.result,'not_evaluated');}
  finally {b.dispose();}
});
test('OpenAPI 3.1 union types and exclusive bounds are handled conservatively', async () => {
  const b=await build({code:null,amount:10},{...spec({code:{type:['null','string']},amount:{type:'number',minimum:10,exclusiveMinimum:true}}),openapi:'3.1.0'});
  try {assert.equal(findingFor(b,'code','type')?.result,'pass');assert.equal(findingFor(b,'amount','minimum')?.result,'not_evaluated');}
  finally {b.dispose();}
});
test('oversized fields and unsafe numeric precision are not validated from a lossy representation', async () => {
  const p=policy(true);p.limits.maxFieldChars=16;
  const b=await build({code:'synthetic-value-too-long',amount:Number.MAX_SAFE_INTEGER+2},spec({code:{pattern:'^[A-Z]+$'},amount:{minimum:0}}),p);
  try {assert.equal(findingFor(b,'code','validation_budget')?.result,'not_evaluated');assert.equal(findingFor(b,'amount','validation_budget')?.result,'not_evaluated');assert.ok(!JSON.stringify(b.context).includes('synthetic-value-too-long'));}
  finally {b.dispose();}
});
test('findings budget overflow fails safely and cannot silently omit constraints', async () => {
  const p=policy();p.limits.maxFindings=1;
  await assert.rejects(()=>build({code:'synthetic-value'},spec(),p),{code:'CONTEXT_TOO_LARGE'});
});
test('schema credentials and examples cannot be released by permissive policy rules', async () => {
  const p=policy();p.rules.push({path:'/spec/**/example',action:'allow'},{path:'/spec/**/enum',action:'allow'});
  const b=await build({code:'synthetic-request'},spec({code:{type:'string',example:secret,default:secret,enum:[secret],description:secret}}),p);
  try {assert.ok(!JSON.stringify(b.context).includes(secret));}
  finally {b.dispose();}
});
test('terminal exclude rules and freeText exclude suppress the entire selected subtree', async () => {
  const p=policy();p.freeText='exclude';
  p.rules.push({path:'/logs/*/data/request_body',action:'exclude'},{path:'/spec/paths',action:'exclude'});
  // Replace, rather than duplicate, the existing body-container rule.
  p.rules=p.rules.filter((r,i)=>r.path!=='/logs/*/data/request_body'||i===p.rules.findLastIndex(x=>x.path==='/logs/*/data/request_body'));
  const b=await build({code:'synthetic-private'},spec(),p,{message:'Missing synthetic-account'});
  try {assert.equal(b.context.validationFindings.length,0);assert.ok(!JSON.stringify(b.context).includes('diagnosticSignals'));assert.ok(!JSON.stringify(b.context).includes('synthetic-private'));assert.ok(!JSON.stringify(b.context).includes('/payments'));}
  finally{b.dispose();}
});

test('Analyzer sends only sanitized context and protects all diagnosis text while preserving contracts', async () => {
  const dir=mkdtempSync(join(tmpdir(),'support-policy-'));
  const file=join(dir,'policy.json');writeFileSync(file,JSON.stringify(policy(true)));
  const config=readConfig({SERVER_API_KEY:'synthetic-server-key-at-least-24',APIC_PLATFORM_URL:'https://analytics.example',APIC_ANALYTICS_SERVICE:'analytics',APIC_ORG:'org',APIC_CATALOG:'cat',APIC_SPEC_URL_TEMPLATE:'https://spec.example/{apiId}',APIC_TOKEN:'synthetic-apic-token',LLM_URL:'https://llm.example/chat',LLM_API_KEY:secret,LLM_MODEL:'test',DATA_POLICY_FILE:file});
  const originals=['AB-12#C','synthetic-customer-payload','synthetic-password','synthetic-enum-allowed','spec-private-description'];
  let outbound='';
  const schema={...spec({code:{type:'string',pattern:'^[A-Z]{2}-[0-9]{2}[A-Z]$',enum:['synthetic-enum-allowed']} }),description:'spec-private-description'};
  const diagnosis={summary:originals.join(' '),probableCause:originals.join(' '),confidence:'high',evidence:[{logId:'apic:1',specPointer:'/paths/~1payments/post/requestBody/content/application~1json/schema/properties/code/pattern',explanation:originals.join(' ')}],nextSteps:[originals.join(' ')],missingInformation:[originals.join(' ')]};
  try {
    const analyzer=new Analyzer(config,async(url,init)=>{
      const host=new URL(String(url)).hostname;
      if(host==='analytics.example')return new Response(JSON.stringify({total:1,events:[{id:'event-1',global_transaction_id:input.transactionId,datetime:'2026-11-01T09:30:00Z',...data({code:originals[0],password:originals[2],customerData:originals[1]})}]}));
      if(host==='spec.example')return new Response(JSON.stringify(schema));
      outbound=String(init?.body);
      return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(diagnosis)}}]}));
    });
    const result=await analyzer.analyze(input);
    assert.deepEqual(Object.keys(result).sort(),['apiId','diagnosis','sources','transactionId','warnings']);
    assert.equal(result.diagnosis.evidence[0]?.logId,'apic:1');
    assert.equal(result.diagnosis.evidence[0]?.specPointer,diagnosis.evidence[0]?.specPointer);
    assert.ok(outbound.includes('validationFindings'));
    assert.ok(outbound.includes('UU-DD#U'));
    for(const raw of [...originals,secret,input.transactionId,input.apiId])assert.ok(!outbound.includes(raw), 'Original must not appear in LLM body');
    for(const raw of [...originals,secret])assert.ok(!JSON.stringify(result.diagnosis).includes(raw),'Original must not appear in diagnosis');
    writeFileSync(file,'{"version":2}');
    assert.throws(()=>new Analyzer(config),/Invalid or unreadable sanitization policy/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
