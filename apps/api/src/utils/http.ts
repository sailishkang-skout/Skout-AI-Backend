export function errorResponse(message: string, statusCode = 400, details?: unknown) {
  return {
    ok: false,
    error: message,
    statusCode,
    details: details ?? null,
  };
}

export function successResponse(data: unknown) {
  return {
    ok: true,
    data,
  };
}

export class HttpError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public details?: unknown
  ) {
    super(message);
    this.name = "HttpError";
  }
}
