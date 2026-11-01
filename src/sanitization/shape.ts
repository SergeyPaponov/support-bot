import { createHmac, randomBytes } from 'node:crypto';
import { minimalShape, type ShapeOptions } from './policy.js';

export function valueType(value: unknown): string {
  return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
}
export function describeShape(value: unknown, options: ShapeOptions = minimalShape): Record<string, unknown> {
  const result: Record<string, unknown> = { protected: true, type: valueType(value) };
  if (typeof value !== 'string' && typeof value !== 'number') return result;
  const text = String(value);
  const chars = Array.from(text);
  if (chars.length < 4 || new Set(chars).size < 3) {
    if (options.length || options.categories || options.positions || options.numericFormat) result.detailSuppressed = 'low_entropy';
    return result;
  }
  if (options.length) result.length = chars.length;
  const category = (char: string) => /\p{Lu}/u.test(char) ? 'U' : /\p{Ll}/u.test(char) ? 'L' : /\p{N}/u.test(char) ? 'D' : /\s/u.test(char) ? 'W' : /\p{L}/u.test(char) ? 'A' : 'S';
  if (options.categories) result.categories = [...new Set(chars.map(category))].sort();
  if (options.positions) result.shape = chars.map(c => options.separators.includes(c) ? c : category(c)).join('');
  if (options.numericFormat) result.numericFormat = {
    numericString: /^[+-]?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(text),
    leadingZero: /^[+-]?0[0-9]/.test(text), sign: /^[+-]/.test(text), decimal: text.includes('.'), exponent: /[eE]/.test(text),
  };
  return result;
}

/** Lives only for a single analysis. Opaque correlation keys use a fresh HMAC salt. */
export class ProtectionScope {
  private originals = new Set<string>();
  private refs = new Map<string, string>();
  private salt = randomBytes(32);
  remember(value: unknown) {
    if (typeof value === 'string' || typeof value === 'number') {
      const text = String(value);
      if (text) this.originals.add(text);
    }
  }
  reference(value: unknown): string {
    const digest = createHmac('sha256', this.salt).update(JSON.stringify(value) ?? 'undefined').digest('hex');
    if (!this.refs.has(digest)) this.refs.set(digest, `value-${randomBytes(8).toString('hex')}`);
    return this.refs.get(digest)!;
  }
  scrub(text: string): string {
    for (const value of [...this.originals].sort((a,b) => b.length - a.length)) text = text.split(value).join('[PROTECTED]');
    return text;
  }
  clear() { this.originals.clear(); this.refs.clear(); this.salt.fill(0); }
}
