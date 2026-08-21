/** Avoid chrome.storage MAX_WRITE_OPERATIONS_PER_MINUTE quota errors. */

const localCooldowns = new Map();
const syncCooldowns = new Map();

export async function safeLocalSet(values, minIntervalMs = 15_000) {
  const key = Object.keys(values).sort().join(",");
  const now = Date.now();
  if (minIntervalMs > 0 && now - (localCooldowns.get(key) || 0) < minIntervalMs) return false;

  try {
    await chrome.storage.local.set(values);
    localCooldowns.set(key, now);
    return true;
  } catch (error) {
    console.warn("[Skout Extension] local storage write skipped:", error);
    return false;
  }
}

export async function safeSyncSet(values, minIntervalMs = 10_000) {
  const key = Object.keys(values).sort().join(",");
  const now = Date.now();
  if (now - (syncCooldowns.get(key) || 0) < minIntervalMs) return false;

  try {
    await chrome.storage.sync.set(values);
    syncCooldowns.set(key, now);
    return true;
  } catch (error) {
    console.warn("[Skout Extension] sync storage write skipped:", error);
    return false;
  }
}
