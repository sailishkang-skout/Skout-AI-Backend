import pino, { type Logger as PinoLogger, type LoggerOptions } from "pino";
import { getRequestContext } from "./context.js";
import { LOG_REDACT_PATHS } from "./redact.js";

export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";

export interface LoggerConfig {
  service: string;
  level?: LogLevel;
  environment?: string;
  version?: string;
}

export interface LogFields {
  [key: string]: unknown;
}

export interface SkoutLogger {
  readonly module: string;
  trace(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, error?: unknown, fields?: LogFields): void;
  fatal(message: string, error?: unknown, fields?: LogFields): void;
  child(bindings: LogFields): SkoutLogger;
}

let rootPino: PinoLogger | null = null;
let rootConfig: LoggerConfig | null = null;

function serializeError(error: unknown): LogFields | undefined {
  if (error === undefined || error === null) return undefined;
  if (error instanceof Error) {
    return {
      err: {
        type: error.name,
        message: error.message,
        stack: error.stack,
        ...(error.cause ? { cause: serializeError(error.cause) } : {}),
      },
    };
  }
  return { err: { message: String(error) } };
}

function mergeContext(fields?: LogFields): LogFields {
  const ctx = getRequestContext();
  if (!ctx) return fields ?? {};
  return {
    ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
    ...(ctx.userId ? { userId: ctx.userId } : {}),
    ...(ctx.workspaceId ? { workspaceId: ctx.workspaceId } : {}),
    ...(ctx.method ? { httpMethod: ctx.method } : {}),
    ...(ctx.path ? { httpPath: ctx.path } : {}),
    ...fields,
  };
}

class PinoSkoutLogger implements SkoutLogger {
  constructor(
    readonly module: string,
    private readonly pino: PinoLogger
  ) {}

  trace(message: string, fields?: LogFields): void {
    this.pino.trace(mergeContext({ module: this.module, ...fields }), message);
  }

  debug(message: string, fields?: LogFields): void {
    this.pino.debug(mergeContext({ module: this.module, ...fields }), message);
  }

  info(message: string, fields?: LogFields): void {
    this.pino.info(mergeContext({ module: this.module, ...fields }), message);
  }

  warn(message: string, fields?: LogFields): void {
    this.pino.warn(mergeContext({ module: this.module, ...fields }), message);
  }

  error(message: string, error?: unknown, fields?: LogFields): void {
    this.pino.error(
      mergeContext({ module: this.module, ...serializeError(error), ...fields }),
      message
    );
  }

  fatal(message: string, error?: unknown, fields?: LogFields): void {
    this.pino.fatal(
      mergeContext({ module: this.module, ...serializeError(error), ...fields }),
      message
    );
  }

  child(bindings: LogFields): SkoutLogger {
    return new PinoSkoutLogger(this.module, this.pino.child(bindings));
  }
}

export function buildPinoOptions(config: LoggerConfig): LoggerOptions {
  return {
    level: config.level ?? "info",
    base: {
      service: config.service,
      env: config.environment ?? process.env.NODE_ENV ?? "development",
      ...(config.version ? { version: config.version } : {}),
    },
    redact: {
      paths: [...LOG_REDACT_PATHS],
      censor: "[REDACTED]",
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
}

/** Initialize the root Pino instance (call once at process startup). */
export function initRootLogger(config: LoggerConfig): PinoLogger {
  rootConfig = config;
  rootPino = pino(buildPinoOptions(config));
  return rootPino;
}

export function getRootPino(): PinoLogger {
  if (!rootPino) {
    rootPino = initRootLogger({
      service: process.env.SERVICE_NAME ?? "skout",
      level: (process.env.LOG_LEVEL as LogLevel | undefined) ?? "info",
      environment: process.env.NODE_ENV,
      version: process.env.SERVICE_VERSION,
    });
  }
  return rootPino;
}

/**
 * Create a module-scoped logger. Import anywhere:
 *   const log = createLogger("crm.service");
 *   log.info("HubSpot import started", { workspaceId, listId });
 */
export function createLogger(module: string, bindings?: LogFields): SkoutLogger {
  const base = getRootPino();
  const child = bindings ? base.child(bindings) : base;
  return new PinoSkoutLogger(module, child);
}

export function getLoggerConfig(): LoggerConfig | null {
  return rootConfig;
}
