/** Skout web + API URL helpers — localhost defaults, deployed origins from storage. */

export const DEFAULT_WEB_URL = "http://localhost:3000";
export const DEFAULT_API_URL = "http://localhost:3001";

const LOCAL_WEB_ORIGINS = new Set(["http://localhost:3000", "http://127.0.0.1:3000"]);

export function parseSkoutOrigin(url) {
  try {
    return new URL(String(url || "").trim()).origin;
  } catch {
    return "";
  }
}

export function normalizeSkoutBase(url, fallback = DEFAULT_WEB_URL) {
  const origin = parseSkoutOrigin(url);
  return origin || parseSkoutOrigin(fallback) || DEFAULT_WEB_URL;
}

export function isLocalWebUrl(webUrl) {
  const origin = parseSkoutOrigin(webUrl || DEFAULT_WEB_URL);
  return LOCAL_WEB_ORIGINS.has(origin);
}

/** Chrome tabs.query patterns for the configured Skout web app. */
export function skoutTabPatterns(webUrl = DEFAULT_WEB_URL) {
  const origin = parseSkoutOrigin(webUrl);
  const patterns = new Set(["http://localhost:3000/*", "http://127.0.0.1:3000/*"]);
  if (origin) patterns.add(`${origin}/*`);
  return [...patterns];
}

export function urlMatchesSkoutWeb(url, webUrl = DEFAULT_WEB_URL) {
  if (!url) return false;
  try {
    const tabOrigin = new URL(url).origin;
    if (LOCAL_WEB_ORIGINS.has(tabOrigin)) return true;
    const configured = parseSkoutOrigin(webUrl);
    return Boolean(configured && tabOrigin === configured);
  } catch {
    return false;
  }
}

/** Host permissions to request for non-local deployed URLs. */
export function hostPermissionOrigins(webUrl, apiUrl) {
  const origins = new Set();
  for (const raw of [webUrl, apiUrl]) {
    const origin = parseSkoutOrigin(raw);
    if (!origin || LOCAL_WEB_ORIGINS.has(origin)) continue;
    origins.add(`${origin}/*`);
  }
  return [...origins];
}

export function skoutSignInHint(webUrl = DEFAULT_WEB_URL) {
  const base = normalizeSkoutBase(webUrl);
  return `open Skout at ${base}, sign in, then click Connect`;
}

export async function ensureSkoutHostPermissions(webUrl, apiUrl) {
  const origins = hostPermissionOrigins(webUrl, apiUrl);
  if (origins.length === 0) return true;

  const has = await chrome.permissions.contains({ origins });
  if (has) return true;

  return chrome.permissions.request({ origins });
}

export async function getStoredSkoutUrls() {
  const stored = await chrome.storage.sync.get(["webUrl", "apiUrl"]);
  return {
    webUrl: stored.webUrl || DEFAULT_WEB_URL,
    apiUrl: stored.apiUrl || DEFAULT_API_URL,
  };
}
