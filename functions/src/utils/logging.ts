export interface LogMetadata {
  readonly requestId?: string | null;
  readonly operation?: string;
  readonly uid?: string | null;
  readonly status?: string;
  readonly errorCode?: string;
  readonly durationMs?: number;
}

export function logCommandEvent(
  level: 'info' | 'warn' | 'error',
  message: string,
  metadata: LogMetadata = {}
): void {
  const safePayload = {
    severity: level.toUpperCase(),
    message,
    requestId: metadata.requestId ?? undefined,
    operation: metadata.operation ?? undefined,
    uid: metadata.uid ?? undefined,
    status: metadata.status ?? undefined,
    errorCode: metadata.errorCode ?? undefined,
    durationMs: metadata.durationMs ?? undefined,
    timestamp: new Date().toISOString(),
  };

  const output = JSON.stringify(safePayload);
  if (level === 'error') {
    console.error(output);
  } else if (level === 'warn') {
    console.warn(output);
  } else {
    console.info(output);
  }
}
