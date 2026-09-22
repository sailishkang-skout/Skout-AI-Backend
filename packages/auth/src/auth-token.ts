import { HttpError } from "./http.js";

export const AUTH_TOKEN_INVALID = "AUTH_TOKEN_INVALID";

export class AuthTokenInvalidError extends HttpError {
  constructor(message: string = AUTH_TOKEN_INVALID) {
    super(message, 401);
  }
}
