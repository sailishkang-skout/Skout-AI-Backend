import { isUsableTab, isUsableTabUrl } from "./tab-utils.js";
import { log, logError, timeStep } from "./debug.js";
import {
  DEFAULT_WEB_URL,
  getStoredSkoutUrls,
  normalizeSkoutBase,
  skoutSignInHint,
  skoutTabPatterns,
  urlMatchesSkoutWeb,
} from "./skout-urls.js";

/** Refresh this many ms before JWT exp (Clerk session tokens are ~60s). */
const REFRESH_BUFFER_MS = 15_000;

export function isTokenExpired(token, bufferMs = REFRESH_BUFFER_MS) {
  if (!token) return true;
  try {
    const payload = JSON.parse(
      atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))
    );
    if (!payload.exp) return false;
    return payload.exp * 1000 < Date.now() + bufferMs;
  } catch {
    return true;
  }
}

export function isAuthFresh(stored) {
  if (!stored?.authToken) return false;
  return !isTokenExpired(stored.authToken);
}

export async function getStoredAuth() {
  return chrome.storage.sync.get(["authToken", "authEmail", "authUpdatedAt"]);
}

export async function saveAuthToken(token, email) {
  const existing = await getStoredAuth();
  if (existing.authToken === token && (existing.authEmail || "") === (email || "")) {
    return;
  }

  try {
    await chrome.storage.sync.set({
      authToken: token,
      authEmail: email || "",
      authUpdatedAt: Date.now(),
    });
  } catch (error) {
    console.warn("[Skout Extension] could not persist auth token:", error);
  }
}

export async function clearAuthToken() {
  await chrome.storage.sync.remove(["authToken", "authEmail", "authUpdatedAt"]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTabLoad(tabId, timeoutMs = 15_000) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.status === "complete" && isUsableTabUrl(tab.url)) return;

  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs);
    function listener(updatedTabId, info, updatedTab) {
      if (updatedTabId !== tabId || info.status !== "complete") return;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timeout);
      resolve(undefined);
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function injectBridgeIfNeeded(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!isUsableTab(tab)) return false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["skout-web-bridge.js"],
    });
  } catch {
    // Content script may already be present.
  }
  return true;
}

/** Ask the Skout web app (via postMessage) to push a fresh Clerk token to the extension. */
async function requestAuthViaPostMessage(tabId) {
  const injectable = await injectBridgeIfNeeded(tabId);
  if (!injectable) return null;

  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      window.dispatchEvent(new CustomEvent("skout-extension-ping"));
      window.postMessage({ source: "skout-extension", type: "REQUEST_AUTH" }, "*");
    },
  });

  for (let i = 0; i < 15; i += 1) {
    await sleep(400);
    const auth = await getStoredAuth();
    if (auth.authToken) {
      log(`requestAuthViaPostMessage: token received on poll ${i + 1}`);
      return { token: auth.authToken, email: auth.authEmail || "" };
    }
  }
  log("requestAuthViaPostMessage: no fresh token after polls");
  return null;
}

async function readAuthFromTab(tabId) {
  const injectable = await injectBridgeIfNeeded(tabId);
  if (!injectable) return { status: "tab_error" };
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async () => {
      const bridge = window.__SKOUT_EXTENSION_BRIDGE__;
      if (!bridge?.ready || !bridge.signedIn) return { status: "not_signed_in" };
      const auth = await bridge.getAuth();
      if (!auth || auth.error) return { status: auth?.error || "no_token" };
      return { status: "ok", token: auth.token, email: auth.email };
    },
  });
  return injection?.result;
}

/** Max time to spend polling a single Skout tab for a Clerk token. */
const TAB_AUTH_TIMEOUT_MS = 12_000;

async function readAuthFromTabWithRetry(tabId, webUrl, attempts = 8) {
  const hint = skoutSignInHint(webUrl);
  const started = Date.now();
  for (let i = 0; i < attempts; i += 1) {
    if (Date.now() - started > TAB_AUTH_TIMEOUT_MS) {
      log(`readAuthFromTabWithRetry: tab ${tabId} timed out after ${TAB_AUTH_TIMEOUT_MS}ms`);
      break;
    }
    log(`readAuthFromTab tab=${tabId} attempt=${i + 1}/${attempts}`);
    const result = await readAuthFromTab(tabId);
    log(`readAuthFromTab tab=${tabId} status=${result?.status ?? "null"}`);
    if (result?.status === "ok" && result.token) {
      await saveAuthToken(result.token, result.email || "");
      return { token: result.token, email: result.email || "" };
    }
    if (result?.status === "tab_error") {
      throw new Error(`Skout tab failed to load — refresh your Skout tab and sign in (${hint}).`);
    }
    if (i === 1 || i === 4) {
      const viaMessage = await requestAuthViaPostMessage(tabId);
      if (viaMessage) return viaMessage;
    }
    if (result?.status === "not_signed_in" && i >= 4) break;
    await sleep(400);
  }

  return requestAuthViaPostMessage(tabId);
}

async function findSkoutTabs(webUrl = DEFAULT_WEB_URL) {
  const patterns = skoutTabPatterns(webUrl);
  const byPattern = await chrome.tabs.query({ url: patterns });
  const usable = byPattern.filter(isUsableTab);
  if (usable.length > 0) return usable;

  const all = await chrome.tabs.query({});
  return all.filter((tab) => isUsableTab(tab) && urlMatchesSkoutWeb(tab.url, webUrl));
}

/** Pull a fresh Clerk JWT from an open, signed-in Skout tab. */
export async function refreshAuthFromSkoutTabs() {
  const { webUrl } = await getStoredSkoutUrls();
  const tabs = await findSkoutTabs(webUrl);
  log(`refreshAuthFromSkoutTabs: ${tabs.length} Skout tab(s)`, tabs.map((t) => t.id));
  for (const tab of tabs) {
    if (!tab.id) continue;
    const auth = await timeStep(`refreshAuth tab=${tab.id}`, () =>
      readAuthFromTabWithRetry(tab.id, webUrl)
    );
    if (auth) return auth;
  }
  log("refreshAuthFromSkoutTabs: no token from any tab");
  return null;
}

export async function ensureFreshAuth() {
  const { useStubAuth } = await chrome.storage.sync.get(["useStubAuth"]);
  if (useStubAuth) return null;

  const { webUrl } = await getStoredSkoutUrls();
  const stored = await getStoredAuth();

  if (stored.authToken && isAuthFresh(stored)) {
    log("ensureFreshAuth: using fresh stored token", {
      email: stored.authEmail || "(none)",
    });
    return { token: stored.authToken, email: stored.authEmail || "" };
  }

  log("ensureFreshAuth: refreshing token", {
    hadToken: Boolean(stored.authToken),
    fresh: stored.authToken ? isAuthFresh(stored) : false,
  });
  const refreshed = await refreshAuthFromSkoutTabs();
  if (refreshed) return refreshed;

  const after = await getStoredAuth();
  if (after.authToken && isAuthFresh(after)) {
    return { token: after.authToken, email: after.authEmail || "" };
  }

  if (stored.authToken || after.authToken) {
    throw new Error(`Session expired — ${skoutSignInHint(webUrl)}.`);
  }

  throw new Error(`Not signed in — ${skoutSignInHint(webUrl)}.`);
}

async function waitForStoredAuth(webUrl, attempts = 30) {
  for (let i = 0; i < attempts; i += 1) {
    const auth = await getStoredAuth();
    if (auth.authToken && !isTokenExpired(auth.authToken)) {
      return { token: auth.authToken, email: auth.authEmail || "" };
    }
    await refreshAuthFromSkoutTabs();
    await sleep(500);
  }
  throw new Error(`Sign in to Skout in the tab that opened, then try again (${skoutSignInHint(webUrl)}).`);
}

/**
 * Ensure a valid session — uses open tabs first, opens Skout in the background if needed.
 */
export async function ensureSession(webUrl = DEFAULT_WEB_URL, { focus = false } = {}) {
  const { useStubAuth } = await chrome.storage.sync.get(["useStubAuth"]);
  if (useStubAuth) return { token: "stub", email: "" };

  const base = normalizeSkoutBase(webUrl);
  const existing = await getStoredAuth();
  if (isAuthFresh(existing)) {
    return { token: existing.authToken, email: existing.authEmail || "" };
  }

  const refreshed = await refreshAuthFromSkoutTabs();
  if (refreshed) return refreshed;

  const tabs = await findSkoutTabs(base);

  let tab =
    tabs.find((t) => t.url?.startsWith(base)) ??
    tabs.find((t) => urlMatchesSkoutWeb(t.url, base));

  if (!tab?.id) {
    tab = await chrome.tabs.create({ url: `${base}/dashboard`, active: focus });
    await waitForTabLoad(tab.id, 20_000);
    await sleep(focus ? 1500 : 3000);
    tab = await chrome.tabs.get(tab.id).catch(() => tab);
  } else if (focus) {
    await chrome.tabs.update(tab.id, { active: true });
    await sleep(800);
  }

  if (!tab?.id || !isUsableTabUrl(tab.url)) {
    throw new Error(`Skout didn't load — ${skoutSignInHint(base)}.`);
  }

  const direct = await readAuthFromTabWithRetry(tab.id, base, 20);
  if (direct) return direct;

  return waitForStoredAuth(base, focus ? 30 : 20);
}

/** Use an open Skout tab or open the app — sync happens automatically when signed in. */
export async function syncAuthFromSkoutTab(webUrl = DEFAULT_WEB_URL) {
  return ensureSession(webUrl, { focus: true });
}

/** If Skout is already open and signed in, pick up the session without user action. */
export async function trySyncFromOpenSkoutTabs() {
  try {
    const { webUrl } = await getStoredSkoutUrls();
    return await ensureSession(webUrl, { focus: false });
  } catch {
    return null;
  }
}

/** Background alarm: refresh JWT before expiry when a Skout tab is open. */
export async function proactiveAuthRefresh() {
  const stored = await getStoredAuth();
  if (!stored.authToken || isAuthFresh(stored)) return stored;

  try {
    return await refreshAuthFromSkoutTabs();
  } catch {
    return null;
  }
}
