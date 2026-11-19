import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { Lifecycle } from '../src/lifecycle.js';
import { installShutdown } from '../src/shutdown.js';
import { config, input, httpInput, headers, diagnosis, sensitive, captureLogs } from './operational-fixtures.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function shutdownFixture(initializing = false) {
  const lifecycle = new Lifecycle();
  if (!initializing) lifecycle.markReady();
  const logs = captureLogs(); const signals = new EventEmitter();
  const exits: number[] = []; let closes = 0, destroys = 0, schedules = 0, cancelled = false, delay = 0;
  let closed: () => void = () => {};
  let deadline: () => void = () => {};
  const controller = installShutdown({ lifecycle, logger: logs.logger, timeoutMs: 90000, signals, exit: code => exits.push(code),
    server: {
      close(callback) { closes++; closed = () => callback?.(); return this as Server; },
      closeAllConnections() { destroys++; },
    },
    schedule(callback, ms) { schedules++; deadline = callback; delay = ms; return () => { cancelled = true; }; },
  });
  return { lifecycle, logs, signals, exits, controller, closed: () => closed(), deadline: () => deadline(),
    state: () => ({ closes, destroys, schedules, cancelled, delay }) };
}

test('SIGTERM drains synchronously; repeated signals do not restart the budget; disconnected in-flight work completes', async () => {
  const f = shutdownFixture(); const release = f.lifecycle.acquire();
  try {
    f.signals.emit('SIGTERM'); f.signals.emit('SIGTERM'); f.signals.emit('SIGINT');
    assert.equal(f.lifecycle.ready, false);
    assert.throws(() => f.lifecycle.acquire(), { code: 'DRAINING' });
    assert.deepEqual(f.state(), { closes: 1, destroys: 0, schedules: 1, cancelled: false, delay: 90000 });
    f.closed(); await Promise.resolve();
    assert.deepEqual(f.exits, [], 'closing HTTP must not discard disconnected active analysis');
    release(); release(); await Promise.resolve();
    assert.deepEqual(f.exits, [0]); assert.equal(f.state().cancelled, true);
    f.deadline(); f.signals.emit('SIGINT');
    assert.equal(f.state().destroys, 0); assert.deepEqual(f.exits, [0]);
    assert.deepEqual(f.logs.records().map(r => r.event), ['shutdown_started', 'shutdown_completed']);
    assert.equal(f.logs.records()[0].requestId, f.logs.records()[1].requestId);
  } finally { f.controller.dispose(); }
});

test('shutdown waits for HTTP response completion even after analysis is idle', async () => {
  const f = shutdownFixture();
  try {
    f.signals.emit('SIGINT'); await Promise.resolve();
    assert.deepEqual(f.exits, []);
    f.closed(); assert.deepEqual(f.exits, [0]);
  } finally { f.controller.dispose(); }
});

test('deadline alone forces closeAllConnections and failure exit exactly once', async () => {
  const f = shutdownFixture(); const release = f.lifecycle.acquire();
  try {
    f.signals.emit('SIGTERM'); await Promise.resolve();
    assert.equal(f.state().destroys, 0); assert.deepEqual(f.exits, []);
    f.deadline(); f.deadline(); f.signals.emit('SIGTERM');
    assert.equal(f.state().destroys, 1); assert.deepEqual(f.exits, [1]);
    release(); f.closed(); await Promise.resolve();
    assert.deepEqual(f.exits, [1]);
    assert.deepEqual(f.logs.records().map(r => r.event), ['shutdown_started', 'shutdown_timeout']);
    assert.equal(f.logs.err.length, 1);
    assert.equal(f.logs.records().at(-1).errorCode, 'SHUTDOWN_TIMEOUT');
  } finally { f.controller.dispose(); }
});

test('SIGTERM during initialization cannot transition back to ready', async () => {
  const f = shutdownFixture(true);
  try {
    f.signals.emit('SIGTERM');
    assert.equal(f.lifecycle.markReady(), false); assert.equal(f.lifecycle.ready, false);
    f.closed(); await Promise.resolve();
    assert.deepEqual(f.exits, [0]); assert.equal(f.state().destroys, 0);
  } finally { f.controller.dispose(); }
});

test('production runtime: REST in-flight analysis completes after real SIGTERM without sensitive logs', { timeout: 15000 }, async t => {
  const llmStarted = deferred(); const releaseLlm = deferred();
  const upstream = createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume synthetic request only */ }
    if (req.url?.startsWith('/analytics/')) { res.end(JSON.stringify({ total: 1, events: [{ id: 'event-1', event: {
      global_transaction_id: input.transactionId, datetime: new URL(req.url, 'http://localhost').searchParams.get('end'), status: 400,
      api_ref: 'payments:1.0', org_name: 'org', catalog_name: 'catalog',
    } }] })); return; }
    if (req.url?.startsWith('/spec/')) { res.end(JSON.stringify({ openapi: '3.0.3', info: { version: '1.0', 'x-ibm-name': 'payments' }, paths: {} })); return; }
    if (req.url === '/llm') {
      llmStarted.resolve(); await releaseLlm.promise;
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(diagnosis) } }] })); return;
    }
    res.statusCode = 404; res.end();
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const addr = upstream.address(); assert.ok(addr && typeof addr !== 'string');
  const origin = `http://127.0.0.1:${addr.port}`;
  const env = { ...process.env, ...Object.fromEntries(Object.entries(config).map(([k, v]) => [k, String(v)])),
    HOST: '127.0.0.1', PORT: '0', SHUTDOWN_TIMEOUT_MS: '10000', NO_PROXY: '127.0.0.1,localhost,::1',
    APIC_PLATFORM_URL: origin, APIC_SPEC_URL_TEMPLATE: origin + '/spec/{apiId}', LLM_URL: origin + '/llm' };
  // Do not let unrelated host settings introduce external files or real data.
  delete (env as NodeJS.ProcessEnv).DATA_POLICY_FILE;
  const child = spawn(process.execPath, ['--import', 'tsx', 'test/runtime-child.ts'], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  assert.ok(child.stdout && child.stderr);
  let stdout = '', stderr = ''; const shutdownStarted = deferred();
  child.stdout.on('data', chunk => {
    stdout += chunk;
    if (stdout.split('\n').some(line => { try { return JSON.parse(line).event === 'shutdown_started'; } catch { return false; } })) shutdownStarted.resolve();
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = once(child, 'exit');
  const close = once(child, 'close');
  t.after(async () => {
    releaseLlm.resolve();
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; }
    upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
  });
  const [message] = await once(child, 'message');
  const base = `http://127.0.0.1:${message.port}`;
  assert.equal((await fetch(base + '/readyz')).status, 200);
  const response = fetch(base + '/api/analyze', {
    method: 'POST', headers, body: JSON.stringify(httpInput),
  });
  await llmStarted.promise;
  child.kill('SIGTERM'); await shutdownStarted.promise;
  assert.equal(child.exitCode, null, 'must remain alive while mock LLM is blocked');
  child.kill('SIGTERM'); // Real repeated signal, while the request is held by the barrier.
  releaseLlm.resolve();
  const result = await response; assert.equal(result.status, 200);
  const json = await result.json();
  assert.equal(json.transactionId, input.transactionId);
  assert.deepEqual(await exit, [0, null]);
  // close waits for stdout/stderr pipes too, unlike exit.
  await close;
  const records = stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(records.map(r => r.event), ['startup', 'ready', 'shutdown_started', 'analysis_completed', 'shutdown_completed']);
  assert.equal(records[3].interface, 'REST'); assert.equal(stderr, '');
  for (const value of sensitive) assert.ok(!(stdout + stderr).includes(value));
});

for (const failure of ['config', 'policy']) test(`production ${failure} startup failure emits safe JSON instead of values or messages`, { timeout: 10000 }, async () => {
  const env = { ...process.env, ...Object.fromEntries(Object.entries(config).map(([k, v]) => [k, String(v)])),
    PORT: failure === 'config' ? sensitive.join(' ') : '0', DATA_POLICY_FILE: '/nonexistent/' + sensitive[6] };
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const result = await once(child, 'close'); assert.deepEqual(result, [1, null]);
  assert.equal(JSON.parse(stdout).event, 'startup');
  assert.equal(JSON.parse(stderr).event, 'startup_failed'); assert.equal(JSON.parse(stderr).errorCode, 'STARTUP_FAILED');
  for (const value of sensitive) assert.ok(!(stdout + stderr).includes(value));
});
