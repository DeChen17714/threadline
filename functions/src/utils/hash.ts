import { createHash } from 'node:crypto';

export function computePayloadHash(data: unknown): string {
  if (data === null || typeof data !== 'object') {
    return createHash('sha256').update(JSON.stringify(data)).digest('hex');
  }
  const keys = Object.keys(data as object).sort();
  const canonicalEntries = keys.map((key) => [key, (data as Record<string, unknown>)[key]]);
  const canonicalObj = Object.fromEntries(canonicalEntries);
  return createHash('sha256').update(JSON.stringify(canonicalObj)).digest('hex');
}
