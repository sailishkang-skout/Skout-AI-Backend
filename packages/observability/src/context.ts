import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestLogContext {
  requestId?: string;
  userId?: string;
  workspaceId?: string;
  method?: string;
  path?: string;
}

const requestStore = new AsyncLocalStorage<RequestLogContext>();

/** Bind context for the remainder of the current async execution (Fastify request). */
export function enterRequestContext(context: RequestLogContext): void {
  const parent = requestStore.getStore();
  requestStore.enterWith({ ...parent, ...context });
}

export function runWithRequestContext<T>(context: RequestLogContext, fn: () => T): T {
  const parent = requestStore.getStore();
  return requestStore.run({ ...parent, ...context }, fn);
}

export function getRequestContext(): RequestLogContext | undefined {
  return requestStore.getStore();
}

export function patchRequestContext(patch: Partial<RequestLogContext>): void {
  const current = requestStore.getStore();
  if (!current) return;
  Object.assign(current, patch);
}
