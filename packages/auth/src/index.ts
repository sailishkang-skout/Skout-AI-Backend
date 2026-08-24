export { resolveOrProvisionUser, type ProvisionResult } from "./auth.service.js";
export { HttpError } from "./http.js";
export {
  assertPermission,
  getMemberPermissions,
  enforcePermission,
  type EnforcePermissionOptions,
} from "./require-permission.js";
export {
  recordPrivilegedAction,
  assertStepUp,
  issueStepUpToken,
  type PrivilegedActionInput,
} from "./step-up.js";
