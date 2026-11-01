const sensitiveKey = /authorization|cookie|password|passwd|secret|token|api[-_]?key|email|phone|credit.?card/i;
export function redactText(value: string, secrets: string[]): string {
  let text = value;
  for (const secret of secrets.filter(Boolean).sort((a,b) => b.length - a.length)) text = text.split(secret).join('[REDACTED]');
  return text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+\/._=:-]+/gi, '$1 [REDACTED]')
    .replace(/((?:password|secret|token|api[-_]?key|authorization|cookie)\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,63}/gi, '[REDACTED_EMAIL]');
}
export function redact(value: unknown, secrets: string[]): unknown {
  if (typeof value === 'string') return redactText(value, secrets);
  if (Array.isArray(value)) return value.map(v => redact(v, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, sensitiveKey.test(k) ? '[REDACTED]' : redact(v, secrets)]));
  return value;
}
