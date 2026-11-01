import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const shape = z.object({
  length: z.boolean().default(false), categories: z.boolean().default(false),
  positions: z.boolean().default(false), separators: z.array(z.string().length(1)).max(16).default([]),
  numericFormat: z.boolean().default(false), correlate: z.boolean().default(false),
}).strict();
const pathSchema = z.string().max(512).refine(s => s.startsWith('/') && !/~(?![01])/.test(s), 'Expected a JSON Pointer path, with optional * or ** segments');
export const policySchema = z.object({
  version: z.literal(1), defaultAction: z.literal('exclude'),
  limits: z.object({
    maxFieldChars: z.number().int().min(16).max(16384), maxDepth: z.number().int().min(2).max(24),
    maxNodes: z.number().int().min(100).max(20000), maxFindings: z.number().int().min(1).max(500),
    maxPatternChars: z.number().int().min(1).max(1024), regexTimeoutMs: z.number().int().min(10).max(500),
  }).strict(),
  freeText: z.enum(['classify', 'exclude']),
  rules: z.array(z.object({
    path: pathSchema, action: z.enum(['allow', 'redact', 'exclude', 'shape_and_validate', 'sanitize_nested']),
    shape: shape.optional(), values: z.array(z.union([z.string().max(128), z.number(), z.boolean()])).max(100).optional(),
  }).strict()).max(256),
}).strict().superRefine((p, ctx) => {
  const paths = new Set<string>();
  for (const r of p.rules) {
    const key = r.path.toLowerCase();
    if (paths.has(key)) ctx.addIssue({ code: 'custom', message: 'Duplicate rule path' });
    paths.add(key);
    if (r.shape && r.action !== 'shape_and_validate') ctx.addIssue({ code: 'custom', message: 'shape requires shape_and_validate' });
    if (r.shape?.separators.some(c => /[\p{L}\p{N}\s]/u.test(c))) ctx.addIssue({ code: 'custom', message: 'Separators must be punctuation or symbols' });
  }
});
export type Policy = z.infer<typeof policySchema>;
export type ShapeOptions = z.infer<typeof shape>;
export const minimalShape: ShapeOptions = shape.parse({});
export const pointerPart = (s: string) => s.replaceAll('~', '~0').replaceAll('/', '~1');
export const childPath = (path: string, key: string) => `${path}/${pointerPart(key)}`;
export const mandatoryKey = (key: string) => /authorization|cookie|password|passwd|secret|token|apikey|privatekey|credential|^(pin|cvv|cvc)$/i.test(key.replace(/[^a-z0-9]/gi, ''));
export const protectedKey = (key: string) => mandatoryKey(key) || /account|iban|customer|email|phone|card|address|identifier|id$|number$|name|birth|ssn|passport|^pan$|^dob$/i.test(key);
export const freeTextKey = (key: string) => /^(message|msg|error_message|error_description|description|stack|_raw)$/i.test(key);

function matches(pattern: string[], path: string[], i = 0, j = 0, memo = new Map<string, boolean>()): boolean {
  const key = `${i}:${j}`;
  if (memo.has(key)) return memo.get(key)!;
  if (i === pattern.length) return j === path.length;
  const result = pattern[i] === '**' ? matches(pattern, path, i + 1, j, memo) || (j < path.length && matches(pattern, path, i, j + 1, memo)) : j < path.length && (pattern[i] === '*' || pattern[i] === path[j]) && matches(pattern, path, i + 1, j + 1, memo);
  memo.set(key, result); return result;
}
export function ruleFor(policy: Policy, path: string) {
  const parts = path.toLowerCase().split('/').slice(1);
  // More literal segments, then fewer **/* segments, then longer path; first declared breaks ties.
  return policy.rules.map((rule, index) => {
    const segments = rule.path.toLowerCase().split('/').slice(1);
    const literals = segments.filter(s => s !== '*' && s !== '**').length;
    return { rule, index, segments, literals, stars: segments.filter(s => s === '**').length * 2 + segments.filter(s => s === '*').length };
  }).filter(r => matches(r.segments, parts)).sort((a,b) => b.literals - a.literals || a.stars - b.stars || b.segments.length - a.segments.length || a.index - b.index)[0]?.rule;
}
export function loadPolicy(filename?: string): Policy {
  // Both source (tsx) and compiled modules resolve the repository-level default.
  const built = fileURLToPath(new URL(import.meta.url)).includes('/dist/');
  const defaultFile = new URL(built ? '../../../config/sanitization-policy.json' : '../../config/sanitization-policy.json', import.meta.url);
  try {
    const text = readFileSync(filename ?? defaultFile, 'utf8');
    if (Buffer.byteLength(text) > 128000) throw new Error();
    return policySchema.parse(JSON.parse(text));
  } catch { throw new Error('Invalid or unreadable sanitization policy'); }
}
