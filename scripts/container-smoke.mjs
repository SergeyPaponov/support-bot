// Run after building the image: node scripts/container-smoke.mjs support-bot:wp2
// All credentials and upstream responses in this harness are synthetic.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const image = process.argv[2] ?? 'support-bot:wp2';
const uid = '1000770001';
const temp = mkdtempSync(join(tmpdir(), 'support-bot-container-'));
chmodSync(temp, 0o755);
const containers = [];
function docker(args, input) {
  const result = spawnSync('docker', args, { input, encoding: 'utf8', timeout: 90000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`docker ${args[0]} failed (${result.status}): ${result.error?.message ?? (result.stderr || result.stdout)}`);
  return result.stdout.trim();
}
const env = {
  HOST: '0.0.0.0', PORT: '3000', SERVER_API_KEY: 'wp2-synthetic-server-key-at-least-24',
  APIC_PLATFORM_URL: 'http://127.0.0.1:3999', APIC_ANALYTICS_SERVICE: 'analytics', APIC_ORG: 'org', APIC_CATALOG: 'catalog',
  APIC_SPEC_URL_TEMPLATE: 'http://127.0.0.1:3999/spec/{apiId}', APIC_TOKEN: 'wp2-synthetic-apic-token',
  LLM_URL: 'http://127.0.0.1:3999/llm', LLM_API_KEY: 'wp2-synthetic-llm-token', LLM_MODEL: 'mock-model',
  NO_PROXY: '127.0.0.1,localhost,::1',
};
function run(mountedPolicy) {
  const name = 'support-bot-wp2-' + randomUUID().slice(0, 8);
  const args = ['run', '-d', '--name', name, '--user', uid + ':0', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--memory', '1g', '--cpus', '1'];
  for (const [key, value] of Object.entries(env)) args.push('-e', `${key}=${value}`);
  if (mountedPolicy) args.push('--mount', `type=bind,src=${mountedPolicy},dst=/etc/support-bot/sanitization-policy.json,readonly`,
    '-e', 'DATA_POLICY_FILE=/etc/support-bot/sanitization-policy.json');
  args.push(image);
  docker(args); containers.push(name); return name;
}
// This code is passed on stdin, never copied into the production image.
const fixture = String.raw`
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { loadPolicy } from './dist/src/sanitization/policy.js';

assert.equal(process.getuid(), 1000770001);
assert.equal(Number(process.versions.node.split('.')[0]), 24);
assert.throws(() => accessSync('/opt/support-bot', constants.W_OK));
for (const path of ['.env', '.npmrc', '.git', 'src', 'test', 'dist/test', 'node_modules/typescript', 'node_modules/tsx', '/run/secrets/proxy_ca'])
  assert.equal(existsSync(path), false, path + ' must not be in the runtime filesystem');
const builtIn = JSON.parse(readFileSync('./config/sanitization-policy.json', 'utf8'));
assert.equal(builtIn.version, 1);
const policy = loadPolicy(process.env.DATA_POLICY_FILE);
const external = !!process.env.DATA_POLICY_FILE;
assert.equal(policy.freeText, external ? 'exclude' : 'classify');

const input = {transactionId:'tx-wp2',apiId:'api-wp2',from:'2026-11-01T09:00:00Z',to:'2026-11-01T10:00:00Z'};
const raw = 'AB-12#C';
const schema = {openapi:'3.0.3',paths:{'/payments':{post:{requestBody:{content:{'application/json':{schema:{type:'object',properties:{accountNumber:{type:'string',pattern:'^[A-Z]{2}-[0-9]{2}[A-Z]$'}}}}}}}}}};
let completions = 0;
const upstream = createServer(async (req, res) => {
  try {
    let text = '';
    for await (const chunk of req) text += chunk;
    res.setHeader('Content-Type','application/json');
    if (req.url.startsWith('/analytics/')) return res.end(JSON.stringify({total:1,events:[{id:'event-1',global_transaction_id:input.transactionId,datetime:'2026-11-01T09:30:00Z',status:400,method:'POST',operation_path:'/payments',request_content_type:'application/json',request_body:{accountNumber:raw},message:'pattern validation error'}]}));
    if (req.url.startsWith('/spec/')) return res.end(JSON.stringify(schema));
    assert.equal(req.url, '/llm');
    const body = JSON.parse(text);
    const context = JSON.parse(body.messages.find(m=>m.role==='user').content);
    assert.equal(text.includes(raw),false);
    assert.equal(text.includes(process.env.APIC_TOKEN),false);
    const finding = context.validationFindings.find(f=>f.constraint==='pattern');
    assert.equal(finding.result,'fail');
    assert.equal(finding.logId,'apic:1');
    assert.equal(finding.observed.shape,external?'UU-DD#U':undefined);
    completions++;
    return res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({
      summary:'Invalid account format',probableCause:'Original request violates the local pattern constraint',confidence:'high',
      evidence:[{logId:'apic:1',specPointer:finding.specPointer,explanation:'Local pattern validation failed'}],
      nextSteps:['Correct the request format'],missingInformation:[]
    })}}]}));
  } catch (error) { res.statusCode=500;res.end(JSON.stringify({error:'mock assertion failed'}));console.error(error); }
});
upstream.listen(3999,'127.0.0.1'); await once(upstream,'listening');
const headers={authorization:'Bearer '+process.env.SERVER_API_KEY,'content-type':'application/json'};
try {
  let health;
  for(let i=0;i<50;i++){
    try{health=await fetch('http://127.0.0.1:3000/healthz');if(health.ok)break;}catch{}
    await new Promise(r=>setTimeout(r,100));
  }
  assert.equal(health?.status,200);
  assert.equal((await fetch('http://127.0.0.1:3000/readyz')).status,200);
  const response=await fetch('http://127.0.0.1:3000/api/analyze',{method:'POST',headers,body:JSON.stringify(input)});
  assert.equal(response.status,200);
  const result=await response.json();
  assert.equal(result.transactionId,input.transactionId);
  assert.equal(completions,1);
  assert.equal(JSON.stringify(result).includes(raw),false);
  const removed=await fetch('http://127.0.0.1:3000/mcp',{method:'POST',headers,body:'{}'});
  assert.equal(removed.status,404);
  console.log((external?'Mounted':'Built-in')+' policy: loaded; REST + local validation + removed MCP endpoint + arbitrary UID/read-only filesystem: PASS');
} finally {upstream.closeAllConnections();await new Promise(r=>upstream.close(r));}
`;
try {
  const inspect = JSON.parse(docker(['image', 'inspect', image]))[0];
  assert.equal(inspect.Config.User, '1001:0');
  assert.deepEqual(inspect.Config.Cmd, ['node', '--use-env-proxy', '--env-file-if-exists=.env', 'dist/src/index.js']);
  const names = inspect.Config.Env.map(s => s.split('=')[0]);
  for (const name of [...Object.keys(env).filter(n => /KEY|TOKEN/.test(n)), 'HTTP_PROXY', 'HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS']) assert.ok(!names.includes(name), 'Runtime credentials/trust/proxy must not be baked into the image');
  for (const external of [false, true]) {
    let policyFile;
    if (external) {
      const policy = JSON.parse(readFileSync(new URL('../config/sanitization-policy.json', import.meta.url), 'utf8'));
      policy.freeText = 'exclude';
      policy.rules.find(r => r.path === '/logs/*/data/request_body/accountNumber').shape = {
        length: true, categories: true, positions: true, separators: ['-', '#'], numericFormat: true, correlate: false,
      };
      policyFile = join(temp, 'policy.json'); writeFileSync(policyFile, JSON.stringify(policy)); chmodSync(policyFile, 0o444);
    }
    const name = run(policyFile);
    console.log(docker(['exec', '-i', name, 'node', '--input-type=module'], fixture));
    docker(['stop', '--time', '15', name]);
    assert.equal(JSON.parse(docker(['inspect', name]))[0].State.ExitCode, 0, 'SIGTERM shutdown must exit cleanly');
    console.log('SIGTERM shutdown: PASS');
    docker(['rm', name]); containers.splice(containers.indexOf(name), 1);
  }
  const invalid = join(temp, 'invalid-policy.json'); writeFileSync(invalid, '{"version":999}'); chmodSync(invalid, 0o444);
  const name = run(invalid);
  assert.equal(docker(['wait', name]), '1');
  const logs = spawnSync('docker', ['logs', name], { encoding: 'utf8' });
  assert.equal(logs.status, 0);
  const startupFailure = (logs.stdout + logs.stderr).split('\n').filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return {}; } })
    .find(record => record.event === 'startup_failed');
  assert.equal(startupFailure?.errorCode, 'STARTUP_FAILED');
  console.log('Invalid mounted policy: startup rejected, no fallback: PASS');
  console.log('Runtime image metadata and absence of env/source/test/dev dependency/build-CA files: PASS');
} catch (error) {
  for (const name of containers) {
    const state = spawnSync('docker', ['inspect', '--format', '{{json .State}}', name], { encoding: 'utf8' });
    const logs = spawnSync('docker', ['logs', name], { encoding: 'utf8' });
    console.error(state.stdout, logs.stdout, logs.stderr);
  }
  throw error;
} finally {
  for (const name of containers) spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 15000 });
  rmSync(temp, { recursive: true, force: true });
}
