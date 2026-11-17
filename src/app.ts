import express, { type Request, type Response, type NextFunction } from 'express';
import { timingSafeEqual, createHash } from 'node:crypto';
import { ZodError } from 'zod';
import type { Config } from './config.js';
import { Analyzer } from './analyzer.js';
import { analysisInput, ServiceError } from './contracts.js';
import { Lifecycle } from './lifecycle.js';
import { createLogger, safeErrorCode, type Logger } from './logger.js';

function publicError(error: unknown) {
  if (error instanceof ZodError) return { status: 400, error: { code: 'INVALID_INPUT', message: 'Invalid request fields', details: error.issues.map(i => ({ path: i.path.join('.'), message: i.message })) } };
  if (error instanceof ServiceError) return { status: error.status, error: { code: error.code, message: error.message } };
  return { status: 500, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } };
}
export function createApp(config: Config, analyzer: Pick<Analyzer, 'analyze'> = new Analyzer(config), options: {
  lifecycle?: Lifecycle; logger?: Logger;
} = {}) {
  const lifecycle = options.lifecycle ?? new Lifecycle();
  const logger = options.logger ?? createLogger();
  // Standalone embeddings retain their existing behavior after synchronous initialization.
  // The production entrypoint injects a state and marks it ready only after listening.
  if (!options.lifecycle) lifecycle.markReady();
  const app = express();
  app.disable('x-powered-by');
  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  app.get('/readyz', (_req, res) => res.status(lifecycle.ready ? 200 : 503).json({ status: lifecycle.ready ? 'ready' : 'not_ready' }));
  function attempt() {
    const log = logger.operation('REST');
    let completed = false;
    return {
      finish(code: string | null = null) {
        if (completed) return;
        completed = true;
        log.log(code ? 'analysis_failed' : 'analysis_completed', code ? 'failure' : 'success', code);
      },
    };
  }
  const requestAttempts = new WeakMap<Request, ReturnType<typeof attempt>>();
  app.use((req, res, next) => {
    if (req.method === 'POST' && /^\/api\/analyze\/?$/i.test(req.path)) {
      const record = attempt(); requestAttempts.set(req, record);
      // Also cover auth/body rejection before the analysis handler is entered.
      res.once('finish', () => {
        record.finish(res.statusCode < 400 ? null :
          ({ 401: 'UNAUTHORIZED', 403: 'ORIGIN_FORBIDDEN', 400: 'INVALID_INPUT', 413: 'INVALID_BODY' } as Record<number, string>)[res.statusCode] ?? 'INTERNAL_ERROR');
      });
    }
    next();
  });
  async function analyze(raw: unknown, record: ReturnType<typeof attempt>) {
    let release: (() => void) | undefined;
    try {
      release = lifecycle.acquire();
      const result = await analyzer.analyze(analysisInput.parse(raw));
      record.finish(); return result;
    } catch (error) {
      record.finish(safeErrorCode(error)); throw error;
    } finally { release?.(); }
  }
  app.use((req, res, next) => {
    // No browser origins are enabled. API clients use bearer authentication.
    if (req.headers.origin) { res.status(403).json({ error: { code: 'ORIGIN_FORBIDDEN', message: 'Browser origins are not enabled' } }); return; }
    const actual = createHash('sha256').update(req.headers.authorization ?? '').digest();
    const expected = createHash('sha256').update(`Bearer ${config.SERVER_API_KEY}`).digest();
    if (!timingSafeEqual(actual, expected)) { res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Bearer authentication required' } }); return; }
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  app.post('/api/analyze', async (req, res) => {
    try { res.json(await analyze(req.body, requestAttempts.get(req) ?? attempt())); }
    catch (error) { const result = publicError(error); res.status(result.status).json({ error: result.error }); }
  });
  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    const status = (error as { status?: number })?.status;
    requestAttempts.get(req)?.finish('INVALID_BODY');
    res.status(status === 413 ? 413 : 400).json({ error: { code: 'INVALID_BODY', message: 'Invalid or oversized JSON body' } });
  });
  return app;
}
