import { saveAuthToken, getStoredAuth, ensureSession, proactiveAuthRefresh } from "./auth.js";
import { readLinkedInProfile, injectLinkedInBridge } from "./linkedin-profile.js";
import { activateProspect, addProspectToList, enrichProspect } from "./api.js";
import { friendlyTabError, isUsableTab, isUsableTabUrl, nameFromLinkedInUrl } from "./tab-utils.js";
import { getLists, prefetchLists, saveLastListId, getLastListId } from "./lists-cache.js";
import { log, logError, timeStep, withTimeout } from "./debug.js";
import {
  DEFAULT_API_URL,
  DEFAULT_WEB_URL,
  getStoredSkoutUrls,
  skoutTabPatterns,
  urlMatchesSkoutWeb,
} from "./skout-urls.js";

const LINKEDIN_PATTERNS = ["https://www.linkedin.com/*", "https://linkedin.com/*"];
const HANDLER_TIMEOUT_MS = 30_000;

function isLinkedInUrl(url) {
  return Boolean(url?.includes("linkedin.com"));
}

async function isSkoutUrl(url) {
  const { webUrl } = await getStoredSkoutUrls();
  return urlMatchesSkoutWeb(url, webUrl);
}

async function injectSkoutBridge(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!isUsableTab(tab)) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["skout-web-bridge.js"],
    });
  } catch {
    // Manifest content script handles new navigations.
  }
}

/** After extension reload, re-inject scripts into open tabs so messaging works immediately. */
async function refreshOpenTabs() {
  const { webUrl } = await getStoredSkoutUrls();
  const skoutPatterns = skoutTabPatterns(webUrl);
  const [linkedInTabs, skoutTabs] = await Promise.all([
    chrome.tabs.query({ url: LINKEDIN_PATTERNS }),
    chrome.tabs.query({ url: skoutPatterns }),
  ]);

  await Promise.all([
    ...linkedInTabs
      .filter(isUsableTab)
      .map((tab) =>
        tab.id ? injectLinkedInBridge(tab.id).catch((e) => logError("linkedin refresh", e)) : null
      ),
    ...skoutTabs
      .filter(isUsableTab)
      .map((tab) =>
        tab.id ? injectSkoutBridge(tab.id).catch((e) => logError("skout refresh", e)) : null
      ),
  ]);
}

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);

const AUTH_REFRESH_ALARM = "skout-auth-refresh";

chrome.alarms.create(AUTH_REFRESH_ALARM, { periodInMinutes: 0.75 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTH_REFRESH_ALARM) {
    void proactiveAuthRefresh().catch(() => undefined);
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.set({
    apiUrl: DEFAULT_API_URL,
    webUrl: DEFAULT_WEB_URL,
    stubEmail: "extension@example.com",
    onboardingComplete: false,
  });
  void refreshOpenTabs();
  void prefetchLists();
});

chrome.runtime.onStartup.addListener(() => {
  void refreshOpenTabs();
  void prefetchLists();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.url || !isUsableTabUrl(tab.url)) return;
  void (async () => {
    if (await isSkoutUrl(tab.url)) {
      void injectSkoutBridge(tabId);
      void prefetchLists();
    }
    if (isLinkedInUrl(tab.url)) {
      void injectLinkedInBridge(tabId).catch(() => undefined);
    }
  })();
});

async function resolveProfile(message) {
  if (message.profile?.fullName) {
    log("profile from page", message.profile.fullName);
    return message.profile;
  }

  if (message.profile?.linkedinUrl) {
    try {
      const fromTab = await readLinkedInProfile(message.tabId);
      return { ...message.profile, ...fromTab };
    } catch {
      const fullName = nameFromLinkedInUrl(message.profile.linkedinUrl);
      if (fullName) return { ...message.profile, fullName };
    }
  }

  return readLinkedInProfile(message.tabId);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "ping") {
    sendResponse({ ok: true, version: "0.6.2" });
    return true;
  }

  if (message.type === "get-auth-status") {
    getStoredAuth().then((auth) =>
      sendResponse({ ok: true, hasToken: Boolean(auth.authToken), email: auth.authEmail || "" })
    );
    return true;
  }

  if (message.type === "save-auth" && message.token) {
    saveAuthToken(message.token, message.email || "")
      .then(() => {
        void prefetchLists();
        sendResponse({ ok: true });
      })
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message.type === "save-last-list" && message.listId) {
    void saveLastListId(message.listId);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "connect-skout") {
    void (async () => {
      try {
        const config = await chrome.storage.sync.get(["webUrl", "useStubAuth"]);
        if (config.useStubAuth) {
          sendResponse({ ok: true, email: "stub" });
          return;
        }
        const auth = await ensureSession(config.webUrl || "http://localhost:3000", {
          focus: Boolean(message.focus),
        });
        sendResponse({ ok: true, email: auth.email || "" });
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Connect failed",
        });
      }
    })();
    return true;
  }

  if (message.type === "get-lists") {
    void (async () => {
      try {
        const [lists, lastListId] = await Promise.all([getLists(), getLastListId()]);
        sendResponse({ ok: true, lists, lastListId });
      } catch (error) {
        sendResponse({
          ok: false,
          lists: [],
          error: error instanceof Error ? error.message : "Failed to load lists",
        });
      }
    })();
    return true;
  }

  if (message.type === "add-to-list") {
    void (async () => {
      const t0 = Date.now();
      log("add-to-list START", {
        listId: message.listId,
        hasProfile: Boolean(message.profile?.fullName),
        profileName: message.profile?.fullName,
      });
      try {
        let fullName = message.profile?.fullName || "";
        await withTimeout(
          (async () => {
            const profile = await timeStep("resolveProfile", () => resolveProfile(message));
            fullName = profile.fullName;
            log("profile resolved", {
              fullName: profile.fullName,
              title: profile.title,
              companyName: profile.companyName,
              linkedinUrl: profile.linkedinUrl,
            });
            await timeStep("activateProspect", () => activateProspect(profile));
            await timeStep("addProspectToList", () => addProspectToList(message.listId, profile));
            await saveLastListId(message.listId);
          })(),
          HANDLER_TIMEOUT_MS,
          "Add to list timed out — open Skout (localhost:3000), sign in, click Connect Skout account, then reload this page."
        );
        log(`add-to-list DONE (${Date.now() - t0}ms)`);
        sendResponse({ ok: true, fullName });
      } catch (error) {
        logError(`add-to-list FAILED (${Date.now() - t0}ms):`, error);
        sendResponse({
          ok: false,
          error: friendlyTabError(error instanceof Error ? error.message : "Add to list failed"),
        });
      }
    })();
    return true;
  }

  if (message.type === "enrich-profile") {
    void (async () => {
      const t0 = Date.now();
      log("enrich-profile START");
      try {
        let fullName = "";
        await withTimeout(
          (async () => {
            const profile = await timeStep("resolveProfile", () => resolveProfile(message));
            fullName = profile.fullName;
            const prospectId = await timeStep("activateProspect", () => activateProspect(profile));
            await timeStep("enrichProspect", () => enrichProspect(prospectId, profile));
          })(),
          HANDLER_TIMEOUT_MS,
          "Enrich timed out — open Skout (localhost:3000), sign in, click Connect Skout account, then reload this page."
        );
        log(`enrich-profile DONE (${Date.now() - t0}ms)`);
        sendResponse({ ok: true, fullName });
      } catch (error) {
        logError(`enrich-profile FAILED (${Date.now() - t0}ms):`, error);
        sendResponse({
          ok: false,
          error: friendlyTabError(error instanceof Error ? error.message : "Enrich failed"),
        });
      }
    })();
    return true;
  }

  return false;
});

chrome.runtime.onMessageExternal.addListener((message, _sender, sendResponse) => {
  if (message.type === "ping") {
    sendResponse({ ok: true, version: "0.6.2" });
    return true;
  }

  if (message.type === "save-auth" && message.token) {
    saveAuthToken(message.token, message.email || "")
      .then(() => {
        void prefetchLists();
        sendResponse({ ok: true });
      })
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  return false;
});
