/**
 * AUTH-BE-18 — Open-redirect mitigation helper.
 * Validates and sanitizes a redirect target URL/path to prevent open-redirect vulnerabilities.
 * Allows safe relative paths (e.g., "/dashboard", "/settings?tab=security").
 * Rejects:
 * - Protocol-relative URLs ("//evil.com", "///evil.com")
 * - Backslash-prefixed paths ("\evil.com", "/\evil.com")
 * - Pseudo-protocols ("javascript:", "data:", "vbscript:")
 * - Absolute URLs with untrusted origins
 *
 * If allowedOrigins are provided, absolute URLs matching one of the allowed origins are permitted.
 * If invalid or untrusted, returns the fallback (default: "/dashboard").
 */
export function sanitizeRedirectPath(
  target: unknown,
  fallback = "/dashboard",
  allowedOrigins: string[] = []
): string {
  if (typeof target !== "string" || !target.trim()) {
    return fallback;
  }
  const trimmed = target.trim();

  // Disallow javascript:, data:, vbscript: pseudo-protocols
  if (/^(javascript|data|vbscript):/i.test(trimmed)) {
    return fallback;
  }

  // Disallow backslash bypasses (e.g. \evil.com, /\evil.com, //\evil.com)
  if (trimmed.includes("\\")) {
    return fallback;
  }

  // Disallow protocol-relative URLs (e.g. //evil.com)
  if (trimmed.startsWith("//")) {
    return fallback;
  }

  // Safe relative path starting with a single '/'
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
    return trimmed;
  }

  // If it's an absolute URL, check against allowedOrigins
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return fallback;
    }
    if (allowedOrigins.includes(parsed.origin)) {
      return parsed.pathname + parsed.search + parsed.hash;
    }
  } catch {
    // Malformed URL
    return fallback;
  }

  return fallback;
}

export function isSafeRedirectPath(
  target: unknown,
  allowedOrigins: string[] = []
): boolean {
  if (typeof target !== "string" || !target.trim()) {
    return false;
  }
  const sanitized = sanitizeRedirectPath(target, "__UNSAFE_REDIRECT__", allowedOrigins);
  return sanitized !== "__UNSAFE_REDIRECT__";
}

