import { createApp } from './app.js';
import { readConfig } from './config.js';

try {
  const config = readConfig();
  const server = createApp(config).listen(config.PORT, config.HOST, () => {
    console.log(`support-bot listening on ${config.HOST}:${config.PORT}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Startup failed');
  process.exitCode = 1;
}
