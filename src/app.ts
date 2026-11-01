import express, { type Request, type Response, type NextFunction } from 'express';
import { timingSafeEqual, createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ZodError, z } from 'zod';
import type { Config } from './config.js';
import { Analyzer } from './analyzer.js';
import { analysisInput, ServiceError } from './contracts.js';

function publicError(error: unknown) {
  if (error instanceof ZodError) return { status: 400, error: { code: 'INVALID_INPUT', message: 'Invalid request fields', details: error.issues.map(i => ({ path: i.path.join('.'), message: i.message })) } };
  if (error instanceof ServiceError) return { status: error.status, error: { code: error.code, message: error.message } };
  return { status: 500, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } };
}
export function createApp(config: Config, analyzer = new Analyzer(config)) {
  const app = express();
  app.disable('x-powered-by');
  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
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
    try { res.json(await analyzer.analyze(analysisInput.parse(req.body))); }
    catch (error) { const result = publicError(error); res.status(result.status).json({ error: result.error }); }
  });
  app.post('/mcp', async (req, res) => {
    // A fresh server/transport per request supports stateless Streamable HTTP.
    const server = new McpServer({ name: 'support-bot', version: '0.1.0' });
    server.registerTool('analyze_transaction', {
      description: 'Analyze Splunk logs and native API Connect Analytics events against an API Connect specification to diagnose an API transaction failure.',
      inputSchema: { transactionId: z.string(), apiId: z.string(), from: z.string(), to: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, async input => {
      try {
        const result = await analyzer.analyze(analysisInput.parse(input));
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(publicError(error).error) }] };
      }
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
    catch (error) { if (!res.headersSent) { const result = publicError(error); res.status(result.status).json({ error: result.error }); } }
  });
  app.all('/mcp', (_req, res) => res.status(405).set('Allow', 'POST').json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST for stateless MCP' } }));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (error as { status?: number })?.status;
    res.status(status === 413 ? 413 : 400).json({ error: { code: 'INVALID_BODY', message: 'Invalid or oversized JSON body' } });
  });
  return app;
}
