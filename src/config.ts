import { z } from 'zod';

const endpoint = z.string().url().superRefine((value, ctx) => {
  const url = new URL(value.replaceAll('{apiId}', 'api'));
  if (url.username || url.password || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))))
    ctx.addIssue({ code: 'custom', message: 'Use HTTPS without URL credentials, or HTTP on loopback for local tests' });
});
const configSchema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  SERVER_API_KEY: z.string().min(24),
  APIC_PLATFORM_URL: endpoint.refine(value => {
    const url = new URL(value);
    return url.pathname === '/' && !url.search;
  }, 'Use the Platform API origin without /api or query parameters'),
  APIC_ANALYTICS_SERVICE: z.string().regex(/^[A-Za-z0-9_-]+$/),
  APIC_ORG: z.string().regex(/^[A-Za-z0-9_-]+$/),
  APIC_CATALOG: z.string().regex(/^[A-Za-z0-9_-]+$/),
  APIC_TRANSACTION_FIELD: z.enum(['global_transaction_id', 'transaction_id']).default('global_transaction_id'),
  APIC_SPEC_URL_TEMPLATE: endpoint.refine(value => value.includes('{apiId}'), 'Include {apiId} in the spec URL'),
  APIC_TOKEN: z.string().min(1),
  LLM_URL: endpoint,
  LLM_API_KEY: z.string().min(1),
  LLM_MODEL: z.string().min(1),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(100).max(120000).default(20000),
  MAX_CONCURRENT_ANALYSES: z.coerce.number().int().min(1).max(50).default(4),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1).max(2147483647).default(90000),
  DATA_POLICY_FILE: z.string().min(1).optional(),
});
export type Config = z.infer<typeof configSchema>;
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) throw new Error('Invalid configuration: ' + result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
  return result.data;
}
