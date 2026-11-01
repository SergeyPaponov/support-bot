import { ServiceError } from './contracts.js';

export type Fetch = typeof fetch;
export async function requestText(fetcher: Fetch, name: string, url: string, init: RequestInit, timeout: number): Promise<string> {
  try {
    const response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeout) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ServiceError('UPSTREAM_HTTP_ERROR', `${name} returned HTTP ${response.status}`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ServiceError('UPSTREAM_EMPTY', `${name} returned an empty response`);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1024 * 1024) throw new ServiceError('UPSTREAM_TOO_LARGE', `${name} response exceeds 1 MiB`);
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    return Buffer.concat(chunks).toString('utf8');
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError('UPSTREAM_UNAVAILABLE', `${name} request failed or timed out`);
  }
}
export function parseJson(text: string, name: string): unknown {
  try { return JSON.parse(text); }
  catch { throw new ServiceError('UPSTREAM_INVALID_RESPONSE', `${name} returned invalid JSON`); }
}
