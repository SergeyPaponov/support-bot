import { randomUUID } from 'node:crypto';
import { writeSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { ZodError } from 'zod';
import { ServiceError } from './contracts.js';

const events = ['startup', 'ready', 'startup_failed', 'shutdown_started', 'shutdown_completed', 'shutdown_timeout',
  'analysis_completed', 'analysis_failed'] as const;
const codes = new Set(['STARTUP_FAILED', 'SHUTDOWN_TIMEOUT', 'INTERNAL_ERROR', 'INVALID_INPUT', 'INVALID_BODY',
  'UNAUTHORIZED', 'ORIGIN_FORBIDDEN', 'NOT_READY', 'DRAINING', 'BUSY', 'NO_LOGS',
  'CONTEXT_TOO_LARGE', 'INVALID_LLM_EVIDENCE', 'INVALID_LLM_RESPONSE', 'INVALID_SPEC', 'LOG_LIMIT_EXCEEDED',
  'APIC_EVENT_SCOPE_MISMATCH', 'APIC_INCOMPLETE_RESULTS', 'APIC_RESULTS_CHANGED', 'SPLUNK_SEARCH_ERROR',
  'UPSTREAM_EMPTY', 'UPSTREAM_HTTP_ERROR', 'UPSTREAM_INVALID_RESPONSE', 'UPSTREAM_TOO_LARGE', 'UPSTREAM_UNAVAILABLE']);
type Event = typeof events[number];
type Interface = 'process' | 'REST';
type Outcome = 'started' | 'success' | 'failure' | 'timeout';

function allowedCode(code: unknown): string {
  return typeof code === 'string' && codes.has(code) ? code : 'INTERNAL_ERROR';
}
export function safeErrorCode(error: unknown): string {
  if (error instanceof ZodError) return 'INVALID_INPUT';
  return error instanceof ServiceError ? allowedCode(error.code) : 'INTERNAL_ERROR';
}

export type Logger = ReturnType<typeof createLogger>;

/** No free-form fields, error messages, URLs, headers or payloads are accepted.
 * Synchronous small writes preserve the final shutdown record before process.exit.
 */
export function createLogger(options: {
  stdout?: (line: string) => void; stderr?: (line: string) => void;
  now?: () => number; timestamp?: () => Date;
} = {}) {
  const now = options.now ?? (() => performance.now());
  const stdout = options.stdout ?? ((line: string) => { writeSync(1, line); });
  const stderr = options.stderr ?? ((line: string) => { writeSync(2, line); });
  return {
    operation(channel: Interface) {
      const requestId = randomUUID();
      const started = now();
      return {
        log(event: Event, outcome: Outcome, errorCode: unknown = null) {
          // Runtime allowlists also protect callers outside TypeScript. Never stringify inputs.
          const safeEvent = events.includes(event) ? event : 'analysis_failed';
          const safeOutcome = ['started', 'success', 'failure', 'timeout'].includes(outcome) ? outcome : 'failure';
          const level = safeOutcome === 'failure' || safeOutcome === 'timeout' ? 'error' : 'info';
          const record = {
            timestamp: (options.timestamp?.() ?? new Date()).toISOString(), level, event: safeEvent, requestId,
            interface: channel === 'REST' ? channel : 'process',
            durationMs: Math.max(0, Math.round(now() - started)), outcome: safeOutcome,
            errorCode: errorCode === null && level === 'info' ? null : allowedCode(errorCode),
          };
          try { (level === 'error' ? stderr : stdout)(JSON.stringify(record) + '\n'); }
          catch { /* A broken log sink must not change analysis or shutdown behavior. */ }
        },
      };
    },
  };
}
