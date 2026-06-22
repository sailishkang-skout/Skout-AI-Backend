/** Helpers to avoid scripting chrome-error:// and other non-injectable tabs. */

export function isUsableTabUrl(url) {
  if (!url || typeof url !== "string") return false;
  if (url.startsWith("chrome-error:")) return false;
  if (url.startsWith("chrome://")) return false;
  if (url.startsWith("about:")) return false;
  if (url.startsWith("edge://")) return false;
  return url.startsWith("http://") || url.startsWith("https://");
}

export function isUsableTab(tab) {
  return Boolean(tab?.id && isUsableTabUrl(tab.url));
}

export function isLinkedInProfileUrl(url) {
  return /linkedin\.com\/(?:in|pub)\//i.test(url || "");
}

export function isFrameErrorMessage(message) {
  const m = String(message || "").toLowerCase();
  return (
    (m.includes("frame") && m.includes("error page")) ||
    m.includes("showing error page") ||
    m.includes("cannot access a chrome://") ||
    m.includes("cannot access contents of url")
  );
}

export function nameFromLinkedInUrl(url) {
  const match = String(url || "").match(/linkedin\.com\/(?:in|pub)\/([^/?#]+)/i);
  if (!match) return "";
  const slug = decodeURIComponent(match[1]).replace(/\/$/, "");
  const words = slug
    .replace(/-[a-f0-9]{6,}$/i, "")
    .replace(/-\d+$/, "")
    .split("-")
    .filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) {
    const word = words[0];
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

export function friendlyTabError(message) {
  if (isFrameErrorMessage(message)) {
    return "LinkedIn didn't load — switch to the profile tab and refresh it (Cmd+Shift+R).";
  }
  const m = String(message || "").toLowerCase();
  if (
    m.includes("receiving end does not exist") ||
    m.includes("extension context invalidated") ||
    m.includes("message port closed")
  ) {
    return "Extension updated — reload the extension, then refresh LinkedIn (Cmd+Shift+R).";
  }
  if (m.includes("missing bearer") || m.includes("session expired") || m.includes("401")) {
    return "Not signed in — open Skout, sign in, then click Connect.";
  }
  return typeof message === "string" && message ? message : "Something went wrong.";
}

export async function findLinkedInProfileTabId() {
  const patterns = ["https://www.linkedin.com/*", "https://linkedin.com/*"];
  const all = await chrome.tabs.query({ url: patterns });
  const usable = all.filter(isUsableTab);
  const profile = usable.find((t) => isLinkedInProfileUrl(t.url));
  if (profile?.id) return profile.id;

  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (isUsableTab(active) && isLinkedInProfileUrl(active.url)) return active.id;

  if (all.length > 0 && usable.length === 0) {
    throw new Error("LinkedIn tab has an error — refresh the profile page (Cmd+Shift+R).");
  }

  throw new Error("Open a loaded LinkedIn profile (/in/username) in another tab first.");
}
