import { saveAuthToken, getStoredAuth, ensureSession, proactiveAuthRefresh, ensureFreshAuth } from "./auth.js";
import { readLinkedInProfile, injectLinkedInBridge } from "./linkedin-profile.js";
import {
  activateProspect,
  addProspectToList,
  activateProspects,
  addProspectBatchToList,
  getListMemberIds,
  enrichProspect,
  getEnrichJob,
  scoreProspect,
  resolveProspectId,
  listSequences,
  enrollInSequence,
} from "./api.js";
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
const BULK_HANDLER_TIMEOUT_MS = 120_000;
const BULK_CHUNK_SIZE = 25;

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
// LinkedIn sequence sends are server-side (Unipile) — no extension outreach poller.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTH_REFRESH_ALARM) {
    void proactiveAuthRefresh().catch(() => undefined);
  }
});

chrome.runtime.onInstalled.addListener((details) => {
  // Only seed defaults on first install — don't wipe dev URLs on extension reload.
  if (details.reason === "install") {
    void chrome.storage.sync.set({
      apiUrl: DEFAULT_API_URL,
      webUrl: DEFAULT_WEB_URL,
      stubEmail: "extension@example.com",
      onboardingComplete: false,
    });
  }
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

async function resolveProfile(message, senderTabId) {
  const tabId = message.tabId ?? senderTabId;

  if (tabId) {
    try {
      const fromTab = await readLinkedInProfile(tabId);
      return message.profile ? { ...message.profile, ...fromTab } : fromTab;
    } catch (error) {
      if (message.profile?.fullName) {
        log("profile from page (tab read failed)", message.profile.fullName);
        return message.profile;
      }
      if (message.profile?.linkedinUrl) {
        const fullName = nameFromLinkedInUrl(message.profile.linkedinUrl);
        if (fullName) return { ...message.profile, fullName };
      }
      throw error;
    }
  }

  if (message.profile?.fullName) {
    log("profile from page", message.profile.fullName);
    return message.profile;
  }

  if (message.profile?.linkedinUrl) {
    const fullName = nameFromLinkedInUrl(message.profile.linkedinUrl);
    if (fullName) return { ...message.profile, fullName };
  }

  return readLinkedInProfile();
}

/** Refresh Clerk JWT before API calls; opens Skout if needed. */
async function ensureAuthForApi() {
  const config = await chrome.storage.sync.get(["useStubAuth", "webUrl"]);
  if (config.useStubAuth) return;
  try {
    await ensureFreshAuth();
  } catch {
    await ensureSession(config.webUrl || DEFAULT_WEB_URL, { focus: false });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "ping") {
    sendResponse({ ok: true, version: "0.7.0" });
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
            await ensureAuthForApi();
            const profile = await timeStep("resolveProfile", () => resolveProfile(message, sender.tab?.id));
            fullName = profile.fullName;
            log("profile resolved", {
              fullName: profile.fullName,
              title: profile.title,
              companyName: profile.companyName,
              linkedinUrl: profile.linkedinUrl,
            });
            await ensureAuthForApi();
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
      const ENRICH_TIMEOUT_MS = 45_000;
      const t0 = Date.now();
      log("enrich-profile START");
      try {
        let fullName = "";
        const result = await withTimeout(
          (async () => {
            await ensureAuthForApi();
            const profile = await timeStep("resolveProfile", () =>
              resolveProfile(message, sender.tab?.id)
            );
            fullName = profile.fullName;
            const prospectId = await timeStep("activateProspect", () => activateProspect(profile));
            await ensureAuthForApi();

            const fields =
              Array.isArray(message.fields) && message.fields.length
                ? message.fields
                : ["company", "email", "validation"];

            const enrichResult = await timeStep("enrichProspect", () =>
              enrichProspect(prospectId, profile, fields)
            );

            return { ...enrichResult, fullName };
          })(),
          ENRICH_TIMEOUT_MS,
          "Enrich timed out — check your Skout session and try again."
        );

        log(`enrich-profile STARTED (${Date.now() - t0}ms) jobId=${result?.jobId}`);
        const emailResult = result?.results?.find((r) => r.field === "email" && r.isPrimary);
        sendResponse({
          ok: true,
          fullName,
          jobId: result?.jobId ?? null,
          status: result?.status ?? "completed",
          results: result?.results ?? [],
          email: emailResult?.value ?? null,
          emailStatus: result?.results?.find((r) => r.field === "email_status")?.value ?? null,
        });
      } catch (error) {
        logError(`enrich-profile FAILED (${Date.now() - t0}ms):`, error);
        const msg = error instanceof Error ? error.message : "Enrich failed";
        const isCreditsError =
          msg.includes("credits") || msg.includes("Credits") || msg.includes("402");
        sendResponse({
          ok: false,
          error: friendlyTabError(msg),
          isCreditsError,
        });
      }
    })();
    return true;
  }

  if (message.type === "poll-enrich-job") {
    void (async () => {
      try {
        await ensureAuthForApi();
        const job = await getEnrichJob(message.jobId);
        sendResponse({
          ok: true,
          status: job?.status ?? "pending",
          results: job?.results ?? [],
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Poll failed";
        sendResponse({ ok: false, error: friendlyTabError(msg) });
      }
    })();
    return true;
  }

  if (message.type === "bulk-add-to-list") {
    void (async () => {
      const t0 = Date.now();
      const profiles = Array.isArray(message.profiles) ? message.profiles : [];
      log("bulk-add-to-list START", { listId: message.listId, count: profiles.length });
      try {
        const summary = await withTimeout(
          (async () => {
            await ensureAuthForApi();
            const listId = message.listId;
            if (!listId) throw new Error("Pick a list first.");
            if (!profiles.length) throw new Error("No profiles selected.");

            const existingIds = await timeStep("getListMemberIds", () => getListMemberIds(listId));
            const results = [];
            let added = 0;
            let skipped = 0;
            let failed = 0;

            for (let i = 0; i < profiles.length; i += BULK_CHUNK_SIZE) {
              const chunk = profiles.slice(i, i + BULK_CHUNK_SIZE);
              const toProcess = [];
              for (const profile of chunk) {
                const prospectId = await resolveProspectId({
                  ...profile,
                  companyName: profile.companyName || "linkedin",
                });
                if (existingIds.has(prospectId)) {
                  skipped += 1;
                  results.push({ linkedinUrl: profile.linkedinUrl, status: "skipped", reason: "already_in_list" });
                  continue;
                }
                toProcess.push(profile);
              }
              if (!toProcess.length) continue;

              try {
                await timeStep("activateProspects", () => activateProspects(toProcess));
                await timeStep("addProspectBatchToList", () => addProspectBatchToList(listId, toProcess));
                for (const profile of toProcess) {
                  const prospectId = await resolveProspectId({
                    ...profile,
                    companyName: profile.companyName || "linkedin",
                  });
                  existingIds.add(prospectId);
                  added += 1;
                  results.push({ linkedinUrl: profile.linkedinUrl, status: "added" });
                }
              } catch (error) {
                failed += toProcess.length;
                const msg = error instanceof Error ? error.message : "Batch failed";
                for (const profile of toProcess) {
                  results.push({ linkedinUrl: profile.linkedinUrl, status: "failed", error: msg });
                }
              }
            }

            await saveLastListId(listId);
            return { added, skipped, failed, results };
          })(),
          BULK_HANDLER_TIMEOUT_MS,
          "Bulk add timed out — try fewer profiles or check your Skout session."
        );
        log(`bulk-add-to-list DONE (${Date.now() - t0}ms)`, summary);
        sendResponse({ ok: true, ...summary });
      } catch (error) {
        logError(`bulk-add-to-list FAILED (${Date.now() - t0}ms):`, error);
        sendResponse({
          ok: false,
          error: friendlyTabError(error instanceof Error ? error.message : "Bulk add failed"),
        });
      }
    })();
    return true;
  }

  if (message.type === "score-profile") {
    void (async () => {
      const t0 = Date.now();
      log("score-profile START");
      try {
        let fullName = "";
        const result = await withTimeout(
          (async () => {
            await ensureAuthForApi();
            const profile = await timeStep("resolveProfile", () => resolveProfile(message, sender.tab?.id));
            fullName = profile.fullName;
            const prospectId = await timeStep("activateProspect", () => activateProspect(profile));
            await ensureAuthForApi();
            return timeStep("scoreProspect", () => scoreProspect(prospectId, profile));
          })(),
          HANDLER_TIMEOUT_MS,
          "Score timed out — open Skout, sign in, and connect your account."
        );
        log(`score-profile DONE (${Date.now() - t0}ms)`);
        const ic = result?.intentClassification;
        const intentPart = ic
          ? ` · Intent: ${ic.intent}${ic.requiresHitl ? " ⚠ review" : ""}`
          : "";
        sendResponse({
          ok: true,
          fullName,
          icpScore: result?.icpScore ?? null,
          icpBand: result?.icpBand ?? null,
          outreachReadiness: result?.outreachReadiness ?? null,
          intent: ic?.intent ?? null,
          intentScore: ic?.intentScore ?? null,
          requiresHitl: ic?.requiresHitl ?? false,
          message: `ICP score: ${result?.icpScore ?? "—"} (${result?.icpBand ?? "n/a"})${intentPart}`,
        });
      } catch (error) {
        logError(`score-profile FAILED (${Date.now() - t0}ms):`, error);
        sendResponse({
          ok: false,
          error: friendlyTabError(error instanceof Error ? error.message : "Score failed"),
        });
      }
    })();
    return true;
  }

  if (message.type === "get-sequences") {
    void (async () => {
      try {
        await ensureAuthForApi();
        const sequences = await listSequences();
        sendResponse({ ok: true, sequences });
      } catch (error) {
        sendResponse({
          ok: false,
          sequences: [],
          error: error instanceof Error ? error.message : "Failed to load sequences",
        });
      }
    })();
    return true;
  }

  if (message.type === "enroll-sequence") {
    void (async () => {
      const t0 = Date.now();
      log("enroll-sequence START", { sequenceId: message.sequenceId });
      try {
        const result = await withTimeout(
          (async () => {
            await ensureAuthForApi();
            const profile = await timeStep("resolveProfile", () =>
              resolveProfile(message, sender.tab?.id)
            );
            const prospectId = await timeStep("activateProspect", () => activateProspect(profile));
            await ensureAuthForApi();
            await timeStep("enrollInSequence", () =>
              enrollInSequence(message.sequenceId, [prospectId])
            );
            return { fullName: profile.fullName, prospectId };
          })(),
          HANDLER_TIMEOUT_MS,
          "Enroll timed out — open Skout, sign in, and connect your account."
        );
        log(`enroll-sequence DONE (${Date.now() - t0}ms)`);
        sendResponse({ ok: true, fullName: result.fullName, prospectId: result.prospectId });
      } catch (error) {
        logError(`enroll-sequence FAILED (${Date.now() - t0}ms):`, error);
        sendResponse({
          ok: false,
          error: friendlyTabError(
            error instanceof Error ? error.message : "Enroll failed"
          ),
        });
      }
    })();
    return true;
  }

  if (message.type === "bulk-enroll-sequence") {
    void (async () => {
      const t0 = Date.now();
      const profiles = Array.isArray(message.profiles) ? message.profiles : [];
      log("bulk-enroll-sequence START", { sequenceId: message.sequenceId, count: profiles.length });
      try {
        const summary = await withTimeout(
          (async () => {
            await ensureAuthForApi();
            const sequenceId = message.sequenceId;
            if (!sequenceId) throw new Error("Pick a sequence first.");
            if (!profiles.length) throw new Error("No profiles selected.");
            const prospectIds = await timeStep("activateProspects", () =>
              activateProspects(profiles)
            );
            await timeStep("enrollInSequence", () => enrollInSequence(sequenceId, prospectIds));
            return { enrolled: prospectIds.length };
          })(),
          BULK_HANDLER_TIMEOUT_MS,
          "Bulk enroll timed out — try fewer profiles or check your Skout session."
        );
        log(`bulk-enroll-sequence DONE (${Date.now() - t0}ms)`, summary);
        sendResponse({ ok: true, ...summary });
      } catch (error) {
        logError(`bulk-enroll-sequence FAILED (${Date.now() - t0}ms):`, error);
        sendResponse({
          ok: false,
          error: friendlyTabError(
            error instanceof Error ? error.message : "Bulk enroll failed"
          ),
        });
      }
    })();
    return true;
  }

  return false;
});

async function isAllowedExternalSender(sender) {
  const url = sender?.url || "";
  if (!url) return false;
  try {
    const origin = new URL(url).origin;
    const { webUrl } = await getStoredSkoutUrls();
    const allowed = new Set(["http://localhost:3000", "http://127.0.0.1:3000"]);
    try {
      if (webUrl) allowed.add(new URL(webUrl).origin);
    } catch {
      // ignore malformed stored webUrl
    }
    if (allowed.has(origin)) return true;
    // First-time connect before settings are saved — allow Skout API Gateway only.
    return /\.execute-api\.us-east-1\.amazonaws\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  void (async () => {
    if (!(await isAllowedExternalSender(sender))) {
      sendResponse({ ok: false, error: "origin_not_allowed" });
      return;
    }

    if (message.type === "ping") {
      sendResponse({ ok: true, version: "0.8.0" });
      return;
    }

    if (message.type === "save-auth" && message.token) {
      try {
        await saveAuthToken(message.token, message.email || "");
        void prefetchLists();
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
      return;
    }

    sendResponse({ ok: false, error: "unknown_message" });
  })();
  return true;
});
