import { log, logError, sleep } from "./debug.js";
import {
  friendlyTabError,
  isFrameErrorMessage,
  isLinkedInProfileUrl,
  isUsableTab,
  isUsableTabUrl,
  nameFromLinkedInUrl,
} from "./tab-utils.js";

const LINKEDIN_PATTERNS = ["https://www.linkedin.com/*", "https://linkedin.com/*"];

export async function injectLinkedInBridge(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!isUsableTab(tab)) {
    throw new Error(friendlyTabError("Frame with ID 0 is showing error page"));
  }

  log("re-inject linkedin bridge", tabId);
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["linkedin-scrape.js", "linkedin-bridge.js"],
    injectImmediately: true,
  });
}

function sendReadProfile(tabId) {
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      reject(new Error("LinkedIn profile read timed out — refresh the page (Cmd+Shift+R) and try again."));
    }, 12_000);
    chrome.tabs.sendMessage(tabId, { type: "read-profile" }, (response) => {
      globalThis.clearTimeout(timer);
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(response);
    });
  });
}

function needsReinject(msg) {
  const m = msg.toLowerCase();
  return (
    m.includes("receiving end does not exist") ||
    m.includes("extension context invalidated") ||
    m.includes("message port closed")
  );
}

function withDisplayName(profile, tabUrl) {
  if (profile?.fullName) return profile;
  const linkedinUrl = profile?.linkedinUrl || tabUrl || "";
  const fullName = nameFromLinkedInUrl(linkedinUrl);
  if (!fullName) return profile;
  return { ...profile, fullName, linkedinUrl: linkedinUrl.split("?")[0].split("#")[0] };
}

async function readProfileFromTab(tabId, tabUrl) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!isUsableTab(tab)) {
    throw new Error(friendlyTabError("Frame with ID 0 is showing error page"));
  }

  let lastError = null;

  for (let attempt = 0; attempt < 15; attempt += 1) {
    try {
      const profile = await sendReadProfile(tabId);
      if (profile?.fullName || profile?.error === "not_a_profile") {
        return withDisplayName(profile, tabUrl || tab.url);
      }
      await sleep(600);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      logError("read-profile failed", attempt, lastError.message);

      if (isFrameErrorMessage(lastError.message)) {
        throw new Error(friendlyTabError(lastError.message));
      }

      if (needsReinject(lastError.message)) {
        try {
          await injectLinkedInBridge(tabId);
        } catch (e) {
          logError("inject failed", e);
        }
      }
      await sleep(600);
    }
  }

  const last = withDisplayName(await sendReadProfile(tabId).catch(() => null), tabUrl || tab.url);
  if (last) return last;

  throw new Error(
    needsReinject(lastError?.message || "")
      ? friendlyTabError(lastError?.message)
      : "Could not read profile. Open a loaded LinkedIn /in/username page."
  );
}

export async function findLinkedInTab(preferredTabId) {
  if (preferredTabId) {
    const tab = await chrome.tabs.get(preferredTabId).catch(() => null);
    if (isUsableTab(tab) && isLinkedInProfileUrl(tab.url)) return tab;
  }

  const tabs = (await chrome.tabs.query({ url: LINKEDIN_PATTERNS })).filter(isUsableTab);
  const profile = tabs.find((t) => isLinkedInProfileUrl(t.url));
  if (profile?.id) return profile;

  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (isUsableTab(active) && isLinkedInProfileUrl(active.url)) return active;

  if (tabs[0]?.id) return tabs[0];
  throw new Error("Open a loaded LinkedIn profile (/in/username) tab first.");
}

export async function readLinkedInProfile(preferredTabId) {
  const tab = await findLinkedInTab(preferredTabId);
  if (!tab.id) throw new Error("LinkedIn tab has no id.");
  if (!isUsableTabUrl(tab.url)) {
    throw new Error(friendlyTabError("Frame with ID 0 is showing error page"));
  }

  log("read profile tab", tab.id, tab.url);
  const profile = await readProfileFromTab(tab.id, tab.url);

  if (!profile || profile.error === "not_a_profile") {
    throw new Error("Not a profile page — open /in/username on LinkedIn.");
  }

  const resolved = withDisplayName(profile, tab.url);
  if (!resolved.fullName) {
    throw new Error("Could not read name — wait for the profile to finish loading, then try again.");
  }
  return resolved;
}
