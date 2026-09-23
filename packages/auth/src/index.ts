export {
  resolveOrProvisionUser,
  type ProvisionResult,
  type ResolveOrProvisionInput,
} from "./auth.service.js";
export type { AuthProvider, AuthVerifyContext, VerifiedIdentity } from "./auth-provider.js";
export { computeAuthorizedParties, normalizeOrigin, type AuthorizedPartiesConfig } from "./authorized-parties.js";
export { resolveAuth, type ResolveAuthConfig } from "./resolve-auth.js";
export { buildClerkAppResolveAuthConfig, buildResolveAuthConfig } from "./clerk-auth-config.js";
export { AUTH_TOKEN_INVALID, AuthTokenInvalidError } from "./auth-token.js";
export { HttpError } from "./http.js";
export {
  assertPermission,
  getMemberPermissions,
  enforcePermission,
  assertRbacBackfillReady,
  type EnforcePermissionOptions,
} from "./require-permission.js";
export {
  recordPrivilegedAction,
  assertStepUp,
  issueStepUpToken,
  type PrivilegedActionInput,
} from "./step-up.js";
export {
  loadPlatformContext,
  type PlatformContext,
  type PlatformConsentSnapshot,
} from "./platform-context.js";
