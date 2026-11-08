import type { Server } from 'node:http';
import type { EventEmitter } from 'node:events';
import type { Lifecycle } from './lifecycle.js';
import type { Logger } from './logger.js';

export function installShutdown(options: {
  server: Pick<Server, 'close' | 'closeAllConnections'>;
  lifecycle: Lifecycle; logger: Logger; timeoutMs: number;
  signals?: EventEmitter; exit?: (code: number) => void;
  schedule?: (callback: () => void, delay: number) => () => void;
}) {
  const { server, lifecycle, logger, timeoutMs } = options;
  const signals = options.signals ?? process;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const schedule = options.schedule ?? ((callback, delay) => {
    const timer = setTimeout(callback, delay); return () => clearTimeout(timer);
  });
  let started = false;
  let finished = false;
  let cancel = () => {};
  function shutdown() {
    if (started) return;
    started = true;
    lifecycle.drain();
    const log = logger.operation('process');
    log.log('shutdown_started', 'started');
    let closed = false;
    let idle = false;
    function complete() {
      if (finished || !closed || !idle) return;
      finished = true; cancel(); lifecycle.stop();
      log.log('shutdown_completed', 'success'); exit(0);
    }
    cancel = schedule(() => {
      if (finished) return;
      finished = true; lifecycle.stop();
      log.log('shutdown_timeout', 'timeout', 'SHUTDOWN_TIMEOUT');
      // Never destroy active connections before the full application budget expires.
      server.closeAllConnections(); exit(1);
    }, timeoutMs);
    server.close(() => { closed = true; complete(); });
    // HTTP close alone is insufficient when a client disconnected mid-analysis.
    void lifecycle.whenIdle().then(() => { idle = true; complete(); });
  }
  signals.on('SIGINT', shutdown);
  signals.on('SIGTERM', shutdown);
  return {
    shutdown,
    dispose() { cancel(); signals.off('SIGINT', shutdown); signals.off('SIGTERM', shutdown); },
  };
}
