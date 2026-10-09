import { HttpsError, type FunctionsErrorCode } from 'firebase-functions/v2/https';
import type { AppErrorCode, AppErrorDetails } from '../types.js';

const ERROR_CODE_MAP: Record<AppErrorCode, FunctionsErrorCode> = {
  validation: 'invalid-argument',
  unauthenticated: 'unauthenticated',
  forbidden: 'permission-denied',
  missing: 'not-found',
  conflict: 'already-exists',
  'room-busy': 'resource-exhausted',
  throttled: 'resource-exhausted',
  'budget-exhausted': 'resource-exhausted',
  'provider-unavailable': 'unavailable',
  timeout: 'deadline-exceeded',
  offline: 'unavailable',
};

export function createSafeAppError(
  code: AppErrorCode,
  message: string,
  requestId: string | null = null,
  operationId: string | null = null,
  retryAt: number | null = null
): HttpsError {
  const details: AppErrorDetails = {
    code,
    message,
    requestId,
    operationId,
    retryAt,
  };
  const functionsCode = ERROR_CODE_MAP[code] ?? 'internal';
  return new HttpsError(functionsCode, message, details);
}
