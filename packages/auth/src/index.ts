export {
  resolveOrProvisionUser,
  type ProvisionResult,
  type ResolveOrProvisionInput,
} from "./auth.service.js";
export type { AuthProvider, AuthVerifyContext, VerifiedIdentity } from "./auth-provider.js";
export { computeAuthorizedParties, normalizeOrigin, type AuthorizedPartiesConfig } from "./authorized-parties.js";
export { resolveAuth, type AcceptedIssuer, type ResolveAuthConfig } from "./resolve-auth.js";
export {
  TEST_CLERK_ISSUER,
  TEST_SKOUT_AUTH_ISSUER,
  buildFakeClerkJwt,
  buildTestAuth,
  buildTestAuthEnv,
  buildTestAuthToken,
  ensureTestAuthHarness,
  resetTestAuthHarness,
  type BuildTestAuthOptions,
  type BuildTestAuthResult,
  type TestAuthProviderKind,
} from "./build-test-auth.js";
export { buildClerkAppResolveAuthConfig, buildResolveAuthConfig } from "./clerk-auth-config.js";
export {
  AUTH_TOKEN_INVALID,
  AuthTokenExpiredError,
  AuthTokenInvalidError,
} from "./auth-token.js";
export {
  AuthErrorCode,
  AuthErrorMessage,
  isJwtExpiredMessage,
  resolveAuthErrorCode,
} from "./auth-error-codes.js";
export { authErrorResponse } from "./auth-error-response.js";
export {
  AUTH_MODE_DEPRECATION_WARNING,
  AUTH_MODE_VALUES,
  applyAuthModeEnv,
  authRuntimeFlags,
  assertAuthModeBootGuards,
  deriveLegacyAuthMode,
  isClerkSecretKeyInvalid,
  parseAcceptedIssuers,
  parseAuthModeEnv,
  resolveAuthMode,
  type AuthMode,
  type AuthModeAppRole,
  type AuthModeEnvInput,
  type ResolvedAuthMode,
} from "./auth-mode.js";
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
export {
  emitAuthVerifyMetric,
  emitAuthLoginMetric,
  emitAuthRefreshMetric,
  emitAuthRefreshReuseMetric,
  type AuthMetricResult,
} from "./auth-metrics.js";
