export type AppErrorCode =
  | 'validation'
  | 'unauthenticated'
  | 'forbidden'
  | 'missing'
  | 'conflict'
  | 'room-busy'
  | 'throttled'
  | 'budget-exhausted'
  | 'provider-unavailable'
  | 'timeout'
  | 'offline'
  | 'screening-blocked'
  | 'screening-unavailable';

export interface AppErrorDetails {
  readonly code: AppErrorCode;
  readonly message: string;
  readonly requestId: string | null;
  readonly retryAt: number | null;
  readonly operationId: string | null;
}
