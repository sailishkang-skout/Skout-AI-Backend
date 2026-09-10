import { createLogger, captureException } from "@skout/observability";

/** Shared structured logger helpers for CRM domain services. */
export function serviceLog(module: string) {
  return createLogger(`crm.${module}`);
}

export function logAndCapture(
  log: ReturnType<typeof createLogger>,
  err: unknown,
  message: string,
  fields?: Record<string, unknown>
): void {
  log.error(message, err, fields);
  captureException(err, { module: message, ...fields });
}
