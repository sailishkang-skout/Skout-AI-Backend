const PLACEHOLDER_VALUES = new Set([
  "",
  "replace-me",
  "replace-me-node",
  "replace-me-python",
  "replace-me-frontend",
  "undefined",
  "null",
  "none",
]);

/** True when a secret/key looks configured (not empty / placeholder). */
export function isConfiguredSecret(value?: string | null): boolean {
  if (value == null) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (PLACEHOLDER_VALUES.has(trimmed.toLowerCase())) return false;
  if (trimmed.startsWith("your_") || trimmed.includes("...") || trimmed.includes("paste_")) {
    return false;
  }
  return true;
}
