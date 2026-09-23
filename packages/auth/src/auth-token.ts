import { HttpError } from "./http.js";

export const AUTH_TOKEN_INVALID = "AUTH_TOKEN_INVALID";

export class AuthTokenInvalidError extends HttpError {
  constructor(message: string = AUTH_TOKEN_INVALID) {
    super(message, 401);
  }
}

/** Clerk (or other provider) rejected the token because it is past TTL — message text preserved. */
export class AuthTokenExpiredError extends AuthTokenInvalidError {
  constructor(message: string) {
    super(message);
  }
}
