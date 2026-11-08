import { createServer } from 'node:http';
import { createApp } from './app.js';
import { readConfig } from './config.js';
import { Lifecycle } from './lifecycle.js';
import { createLogger } from './logger.js';
import { installShutdown } from './shutdown.js';

/** Shared production bootstrap; returned server lets local harnesses observe listen readiness. */
export function startRuntime() {
  const logger = createLogger();
  const startup = logger.operation('process');
  startup.log('startup', 'started');
  try {
    const config = readConfig();
    const lifecycle = new Lifecycle();
    const app = createApp(config, undefined, { lifecycle, logger });
    const server = createServer(app);
    const shutdown = installShutdown({ server, lifecycle, logger, timeoutMs: config.SHUTDOWN_TIMEOUT_MS });
    server.once('error', () => {
      lifecycle.drain(); shutdown.dispose();
      startup.log('startup_failed', 'failure', 'STARTUP_FAILED');
      process.exitCode = 1;
    });
    server.listen(config.PORT, config.HOST, () => {
      if (lifecycle.markReady()) startup.log('ready', 'success');
    });
    return server;
  } catch {
    startup.log('startup_failed', 'failure', 'STARTUP_FAILED');
    process.exitCode = 1;
    return undefined;
  }
}
