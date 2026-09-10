import { listListsCached } from "./api.js";
import { ensureFreshAuth } from "./auth.js";
import { safeLocalSet } from "./storage-throttle.js";

const LAST_LIST_KEY = "lastListId";
const PREFETCH_COOLDOWN_MS = 90_000;
let lastPrefetchAt = 0;
let prefetchInFlight = null;

export async function getLists({ force = false } = {}) {
  try {
    await ensureFreshAuth();
  } catch {
    if (!force) {
      const cached = await chrome.storage.local.get(["listsCache", "listsCacheAt"]);
      if (cached.listsCache) return cached.listsCache;
    }
    throw new Error("Sign in to Skout first.");
  }
  return listListsCached({ force });
}

export function prefetchLists() {
  const now = Date.now();
  if (now - lastPrefetchAt < PREFETCH_COOLDOWN_MS) return Promise.resolve();
  if (prefetchInFlight) return prefetchInFlight;

  prefetchInFlight = (async () => {
    try {
      await getLists({ force: false });
      lastPrefetchAt = Date.now();
    } catch {
      // Signed out or API down.
    } finally {
      prefetchInFlight = null;
    }
  })();

  return prefetchInFlight;
}

export async function getLastListId() {
  const { lastListId } = await chrome.storage.local.get(LAST_LIST_KEY);
  return lastListId || "";
}

export async function saveLastListId(listId) {
  if (!listId) return;
  const current = await getLastListId();
  if (current === listId) return;
  await safeLocalSet({ [LAST_LIST_KEY]: listId }, 5_000);
}
