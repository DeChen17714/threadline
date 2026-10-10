import { Buffer } from 'node:buffer';

export const MODERATION_MODEL = 'omni-moderation-latest';
export const MODERATION_POLICY_VERSION = 'threadline-moderation-v1';

export const MODERATION_CATEGORIES = [
  'harassment',
  'harassment/threatening',
  'hate',
  'hate/threatening',
  'illicit',
  'illicit/violent',
  'self-harm',
  'self-harm/intent',
  'self-harm/instructions',
  'sexual',
  'sexual/minors',
  'violence',
  'violence/graphic',
] as const;

export type ModerationCategory = (typeof MODERATION_CATEGORIES)[number];
export type ModerationVerdict = 'allow' | 'block' | 'unavailable';

export interface ModerationResult {
  verdict: ModerationVerdict;
  policyVersion: string;
  reason: string | null;
  model?: string;
  categories?: Record<string, boolean>;
  scores?: Record<string, number>;
}

export interface ModerationPort {
  screen(text: string, signal?: AbortSignal): Promise<ModerationResult>;
}

export interface OpenAiModerationOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const MODERATION_ENDPOINT = 'https://api.openai.com/v1/moderations';
const MAX_INPUT_BYTES = 131072;
const MAX_RESPONSE_BYTES = 65536;
const DEFAULT_TIMEOUT_MS = 15000;

const RECOGNIZED_MODELS: Record<string, true> = {
  'omni-moderation-latest': true,
  'omni-moderation-2024-09-26': true,
};

const HARASSMENT_THRESHOLD = 0.15;
const ILLICIT_THRESHOLD = 0.2;
const VIOLENCE_THRESHOLD = 0.5;

function createUnavailableResult(reason: string): ModerationResult {
  const result: ModerationResult = {
    verdict: 'unavailable',
    policyVersion: MODERATION_POLICY_VERSION,
    reason,
  };
  return result;
}

async function readBoundedResponseBody(
  response: Response,
  maxBytes: number
): Promise<string> {
  const body = response.body;

  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.byteLength;
          if (totalBytes > maxBytes) {
            try {
              await reader.cancel();
            } catch {
              // ignore cancel failures
            }
            throw new Error(`Response body exceeded maximum allowed size of ${maxBytes} bytes`);
          }
          chunks.push(value);
        }
      }
    } finally {
      reader.releaseLock();
    }
    const combined = Buffer.concat(chunks, totalBytes);
    return combined.toString('utf8');
  }


  throw new Error('Unsupported response body');
}

export function createOpenAiModerationPort(
  apiKey: string,
  options?: OpenAiModerationOptions
): ModerationPort {
  const fetchFn = options?.fetch ?? globalThis.fetch;
  const configuredTimeout = options?.timeoutMs;
  const timeoutMs =
    typeof configuredTimeout === 'number' && Number.isFinite(configuredTimeout) && configuredTimeout >= 0
      ? configuredTimeout
      : DEFAULT_TIMEOUT_MS;

  return {
    async screen(text: string, signal?: AbortSignal): Promise<ModerationResult> {
      // Missing, blank, or invalid credential fails closed without dispatch
      const trimmedKey = typeof apiKey === 'string' ? apiKey.trim() : '';
      if (!trimmedKey || /\s/.test(trimmedKey)) {
        return createUnavailableResult('Missing or invalid API key');
      }

      // Check caller abort before processing
      if (signal?.aborted) {
        return createUnavailableResult('Request aborted');
      }

      // Bound nonblank text to 131072 UTF-8 bytes
      if (typeof text !== 'string') {
        return createUnavailableResult('Input text must be a string');
      }
      if (!text.trim()) {
        return createUnavailableResult('Input text cannot be blank');
      }
      const textBytes = Buffer.byteLength(text, 'utf8');
      if (textBytes > MAX_INPUT_BYTES) {
        return createUnavailableResult('Input text exceeds byte limit');
      }

      // Set up combined abort controller for timeout and caller signal
      const controller = new AbortController();
      let timedOut = false;

      const timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error('Moderation request timed out'));
      }, timeoutMs);

      let onCallerAbort: (() => void) | undefined;
      if (signal) {
        onCallerAbort = () => {
          controller.abort(signal.reason);
        };
        signal.addEventListener('abort', onCallerAbort, { once: true });
      }

      try {
        let response: Response;
        try {
          response = await fetchFn(MODERATION_ENDPOINT, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${trimmedKey}`,
            },
            body: JSON.stringify({
              model: MODERATION_MODEL,
              input: text,
            }),
            signal: controller.signal,
            redirect: 'error',
          });
        } catch (fetchErr: unknown) {
          if (signal?.aborted) {
            return createUnavailableResult('Request aborted');
          }
          if (timedOut) {
            return createUnavailableResult('Request timeout');
          }
          if (fetchErr instanceof Error && fetchErr.name === 'AbortError') {
            return createUnavailableResult('Request aborted');
          }
          return createUnavailableResult('Network or service request failed');
        }

        if (response.status !== 200) {
          if (response.body && typeof response.body.cancel === 'function') {
            try {
              await response.body.cancel();
            } catch {
              // ignore cancel failures
            }
          }
          if (response.status === 401 || response.status === 403) {
            return createUnavailableResult('Authentication failure');
          }
          if (response.status === 429) {
            return createUnavailableResult('Rate limit exceeded');
          }
          if (response.status >= 500 && response.status < 600) {
            return createUnavailableResult('Service unavailable');
          }
          return createUnavailableResult(`HTTP error ${response.status}`);
        }

        let responseText: string;
        try {
          responseText = await readBoundedResponseBody(response, MAX_RESPONSE_BYTES);
        } catch (readErr: unknown) {
          if (signal?.aborted) {
            return createUnavailableResult('Request aborted');
          }
          if (timedOut) {
            return createUnavailableResult('Request timeout');
          }
          if (readErr instanceof Error && readErr.message.includes('exceeded maximum allowed size')) {
            return createUnavailableResult('Response exceeded byte limit');
          }
          return createUnavailableResult('Failed to read response body');
        }

        let payload: unknown;
        try {
          payload = JSON.parse(responseText);
        } catch {
          return createUnavailableResult('Malformed JSON response');
        }

        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          return createUnavailableResult('Invalid response format');
        }

        const resObj = payload as Record<string, unknown>;

        if (typeof resObj.model !== 'string' || !Object.hasOwn(RECOGNIZED_MODELS, resObj.model)) {
          return createUnavailableResult('Unrecognized moderation model');
        }

        if (!Array.isArray(resObj.results) || resObj.results.length !== 1) {
          return createUnavailableResult('Invalid results count');
        }

        const firstResult = resObj.results[0];
        if (!firstResult || typeof firstResult !== 'object' || Array.isArray(firstResult)) {
          return createUnavailableResult('Invalid result object');
        }

        const resultRecord = firstResult as Record<string, unknown>;

        if (typeof resultRecord.flagged !== 'boolean') {
          return createUnavailableResult('Missing or invalid flagged property');
        }

        if (!resultRecord.categories || typeof resultRecord.categories !== 'object' || Array.isArray(resultRecord.categories)) {
          return createUnavailableResult('Invalid categories object');
        }

        const categoriesRecord = resultRecord.categories as Record<string, unknown>;
        const catKeys = Object.keys(categoriesRecord);
        if (catKeys.length !== MODERATION_CATEGORIES.length) {
          return createUnavailableResult('Unexpected category count');
        }

        for (const cat of MODERATION_CATEGORIES) {
          if (typeof categoriesRecord[cat] !== 'boolean') {
            return createUnavailableResult(`Invalid category flag for ${cat}`);
          }
        }

        const rawScoresRecord = resultRecord.category_scores as Record<string, unknown> | undefined;

        if (!rawScoresRecord || typeof rawScoresRecord !== 'object' || Array.isArray(rawScoresRecord)) {
          return createUnavailableResult('Invalid scores object');
        }

        const scoreKeys = Object.keys(rawScoresRecord);
        if (scoreKeys.length !== MODERATION_CATEGORIES.length) {
          return createUnavailableResult('Unexpected scores count');
        }

        for (const cat of MODERATION_CATEGORIES) {
          const scoreVal = rawScoresRecord[cat];
          if (typeof scoreVal !== 'number' || !Number.isFinite(scoreVal) || scoreVal < 0 || scoreVal > 1) {
            return createUnavailableResult(`Invalid score value for ${cat}`);
          }
        }

        const categories = categoriesRecord as Record<string, boolean>;
        const scores = rawScoresRecord as Record<string, number>;
        const blocked = MODERATION_CATEGORIES.some(cat => {
          if (cat === 'harassment') return scores[cat] >= HARASSMENT_THRESHOLD;
          if (cat === 'illicit') return scores[cat] >= ILLICIT_THRESHOLD;
          if (cat === 'violence') return scores[cat] >= VIOLENCE_THRESHOLD;
          return categories[cat];
        });
        const verdict: ModerationVerdict = blocked ? 'block' : 'allow';
        const reason = blocked ? 'policy-blocked' : null;

        return {
          verdict,
          policyVersion: MODERATION_POLICY_VERSION,
          reason,
          model: resObj.model,
          categories,
          scores,
        };
      } finally {
        clearTimeout(timeoutId);
        if (signal && onCallerAbort) {
          signal.removeEventListener('abort', onCallerAbort);
        }
      }
    },
  };
}
