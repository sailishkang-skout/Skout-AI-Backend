import { isUsableTab, isUsableTabUrl } from "./tab-utils.js";

const SKOUT_TAB_PATTERNS = [
  "http://localhost:3000/*",
  "http://127.0.0.1:3000/*",
];

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

  for (let i = 0; i < 25; i += 1) {
    await sleep(400);
    const auth = await getStoredAuth();
    if (auth.authToken && isAuthFresh(auth)) {
      return { token: auth.authToken, email: auth.authEmail || "" };
    }
  }
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

async function readAuthFromTabWithRetry(tabId, attempts = 15) {
  for (let i = 0; i < attempts; i += 1) {
    const result = await readAuthFromTab(tabId);
    if (result?.status === "ok" && result.token) {
      await saveAuthToken(result.token, result.email || "");
      return { token: result.token, email: result.email || "" };
    }
    if (result?.status === "tab_error") {
      throw new Error("Skout tab failed to load — refresh localhost:3000 and sign in.");
    }
    if (i === 2 || i === 8) {
      const viaMessage = await requestAuthViaPostMessage(tabId);
      if (viaMessage) return viaMessage;
    }
    if (result?.status === "not_signed_in" && i >= 6) break;
    await sleep(500);
  }

  return requestAuthViaPostMessage(tabId);
}

async function findSkoutTabs() {
  const byPattern = await chrome.tabs.query({ url: SKOUT_TAB_PATTERNS });
  const usable = byPattern.filter(isUsableTab);
  if (usable.length > 0) return usable;

  const all = await chrome.tabs.query({});
  return all.filter(
    (tab) =>
      isUsableTab(tab) &&
      (tab.url?.includes("localhost:3000") || tab.url?.includes("127.0.0.1:3000"))
  );
}

/** Pull a fresh Clerk JWT from an open, signed-in Skout tab. */
export async function refreshAuthFromSkoutTabs() {
  const tabs = await findSkoutTabs();
  for (const tab of tabs) {
    if (!tab.id) continue;
    const auth = await readAuthFromTabWithRetry(tab.id);
    if (auth) return auth;
  }
  return null;
}

export async function ensureFreshAuth() {
  const { useStubAuth } = await chrome.storage.sync.get(["useStubAuth"]);
  if (useStubAuth) return null;

  const stored = await getStoredAuth();
  if (isAuthFresh(stored)) {
    return { token: stored.authToken, email: stored.authEmail || "" };
  }

  const refreshed = await refreshAuthFromSkoutTabs();
  if (refreshed) return refreshed;

  const after = await getStoredAuth();
  if (isAuthFresh(after)) {
    return { token: after.authToken, email: after.authEmail || "" };
  }

  throw new Error("Not signed in — open Skout at localhost:3000, then click Connect.");
}

async function waitForStoredAuth(attempts = 30) {
  for (let i = 0; i < attempts; i += 1) {
    const auth = await getStoredAuth();
    if (auth.authToken && !isTokenExpired(auth.authToken)) {
      return { token: auth.authToken, email: auth.authEmail || "" };
    }
    await refreshAuthFromSkoutTabs();
    await sleep(500);
  }
  throw new Error(
    "Sign in to Skout in the tab that opened (same browser), then try again."
  );
}

/**
 * Ensure a valid session — uses open tabs first, opens Skout in the background if needed.
 */
export async function ensureSession(webUrl = "http://localhost:3000", { focus = false } = {}) {
  const { useStubAuth } = await chrome.storage.sync.get(["useStubAuth"]);
  if (useStubAuth) return { token: "stub", email: "" };

  const existing = await getStoredAuth();
  if (isAuthFresh(existing)) {
    return { token: existing.authToken, email: existing.authEmail || "" };
  }

  const refreshed = await refreshAuthFromSkoutTabs();
  if (refreshed) return refreshed;

  const base = webUrl.replace(/\/$/, "");
  const tabs = await findSkoutTabs();

  let tab =
    tabs.find((t) => t.url?.startsWith(base)) ??
    tabs.find((t) => t.url?.includes("localhost:3000") || t.url?.includes("127.0.0.1:3000"));

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
    throw new Error(
      "Skout didn't load — open http://localhost:3000 in a tab, sign in, then click Connect."
    );
  }

  const direct = await readAuthFromTabWithRetry(tab.id, 20);
  if (direct) return direct;

  return waitForStoredAuth(focus ? 30 : 20);
}

/** Use an open Skout tab or open the app — sync happens automatically when signed in. */
export async function syncAuthFromSkoutTab(webUrl = "http://localhost:3000") {
  return ensureSession(webUrl, { focus: true });
}

/** If Skout is already open and signed in, pick up the session without user action. */
export async function trySyncFromOpenSkoutTabs() {
  try {
    return await ensureSession(undefined, { focus: false });
  } catch {
    return null;
  }
}
