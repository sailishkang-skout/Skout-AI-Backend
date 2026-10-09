/**
 * COPS-01 — verb × resource permission keys (Bible p.84, epic COPS-01 RBAC).
 *
 * Maps onto the existing permission-key model in packages/auth (`assertPermission`). A key is
 * `<resource>:<verb>`, e.g. `commercial:approve`. The role-to-permission grants themselves live in
 * the existing `role_permissions` table; this module only defines the key space and the default
 * data-scope rules the epic calls out.
 */

export const COPS_VERBS = ["read", "write", "send", "approve", "refund", "adjust", "export", "admin"] as const;
export type CopsVerb = (typeof COPS_VERBS)[number];

export const COPS_RESOURCES = [
  "crm",
  "commercial",
  "legal",
  "billing",
  "credits",
  "onboarding",
  "tickets",
  "analytics",
  "admin",
] as const;
export type CopsResource = (typeof COPS_RESOURCES)[number];

export function copsPermissionKey(resource: CopsResource, verb: CopsVerb): string {
  return `${resource}:${verb}`;
}

/**
 * Engineering must not read commercial or legal content by default (epic COPS-01 BE, Bible p.84).
 * Returns true when a role set grants access to that resource. Only explicit grants pass, so the
 * default is deny.
 */
export function engineeringCanRead(resource: CopsResource, grantedKeys: readonly string[]): boolean {
  return grantedKeys.includes(copsPermissionKey(resource, "read"));
}
