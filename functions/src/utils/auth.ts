import type { CallableRequest } from 'firebase-functions/v2/https';
import { createSafeAppError } from './errors.js';

function loopbackHost(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(`http://${value}`);
    return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && url.port !== '' && url.pathname === '/' && !url.username && !url.password;
  } catch { return false; }
}

export function isIsolatedEmulator(): boolean {
  return process.env.FUNCTIONS_EMULATOR === 'true'
    && process.env.GCLOUD_PROJECT === 'demo-threadline'
    && loopbackHost(process.env.FIREBASE_EMULATOR_HUB)
    && loopbackHost(process.env.FIRESTORE_EMULATOR_HOST)
    && loopbackHost(process.env.FIREBASE_AUTH_EMULATOR_HOST);
}

export function allowedOrigins(): string[] {
  if (isIsolatedEmulator()) return ['http://127.0.0.1:5174', 'http://localhost:5174'];
  return (process.env.ALLOWED_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter((origin) => {
    try { const url = new URL(origin); return url.protocol === 'https:' && url.origin === origin; }
    catch { return false; }
  });
}

export function validateEnvironmentAndOrigin(
  request: CallableRequest<unknown>,
  requestId: string | null
): void {
  const isLocal = isIsolatedEmulator();

  const rawOrigin = request.rawRequest.headers.origin;
  const origin = typeof rawOrigin === 'string' ? rawOrigin : undefined;

  if ((!isLocal && !origin) || (origin && !allowedOrigins().includes(origin))) {
    throw createSafeAppError('forbidden', 'Disallowed origin', requestId);
  }
  if (!isLocal && !request.app) {
    throw createSafeAppError('unauthenticated', 'App Check verification failed', requestId);
  }
}

export function requireAuthenticatedUser(
  request: CallableRequest<unknown>,
  requestId: string | null
): { uid: string; label: string } {
  if (!request.auth || !request.auth.uid) {
    throw createSafeAppError('unauthenticated', 'Authentication required', requestId);
  }
  const uid = request.auth.uid;
  const token = request.auth.token;
  const label =
    (typeof token.name === 'string' && token.name.trim()) ||
    (typeof token.email === 'string' && token.email.split('@')[0]) ||
    'Member';
  return { uid, label: label.slice(0, 80) };
}
