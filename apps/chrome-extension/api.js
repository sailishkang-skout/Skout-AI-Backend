import { ensureFreshAuth, refreshAuthFromSkoutTabs } from "./auth.js";
import { safeLocalSet } from "./storage-throttle.js";

const DEFAULT_API_URL = "http://localhost:3001";
const DEFAULT_WEB_URL = "http://localhost:3000";

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function normalizeDomain(domain) {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\/$/, "");
}

export function slugCompanyDomain(companyName) {
  const slug = companyName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug ? `${slug}.linkedin` : "linkedin-capture.local";
}

/** Internal capture domains — not real company websites. */
export function isCaptureDomain(domain) {
  const d = normalizeDomain(domain || "");
  return d.endsWith(".linkedin") || d === "linkedin-capture.local";
}

function buildProspectFields(profile) {
  const companyDomain = normalizeDomain(slugCompanyDomain(profile.companyName || "linkedin"));
  const fields = {
    fullName: profile.fullName?.trim() || undefined,
    title: profile.title?.trim() || undefined,
    companyName: profile.companyName?.trim() || undefined,
    linkedinUrl: profile.linkedinUrl?.trim() || undefined,
    companyDomain,
  };
  return fields;
}

export async function resolveProspectId(profile) {
  const companyDomain = normalizeDomain(slugCompanyDomain(profile.companyName || "linkedin"));
  return sha256(normalizeDomain(`${companyDomain}:${profile.fullName ?? ""}`));
}

export async function getConfig() {
  const stored = await chrome.storage.sync.get([
    "apiUrl",
    "webUrl",
    "authToken",
    "authEmail",
    "stubEmail",
    "useStubAuth",
  ]);
  return {
    apiUrl: stored.apiUrl || DEFAULT_API_URL,
    webUrl: stored.webUrl || DEFAULT_WEB_URL,
    authToken: stored.authToken || "",
    authEmail: stored.authEmail || "",
    stubEmail: stored.stubEmail || "extension@example.com",
    useStubAuth: Boolean(stored.useStubAuth),
  };
}

function formatApiError(status, body) {
  if (status === 401) {
    const detail = typeof body?.error === "string" ? body.error.toLowerCase() : "";
    if (detail.includes("expired")) {
      return "Session expired — keep Skout open at localhost:3000, then click Refresh lists.";
    }
    return "Session expired — open Skout at localhost:3000, then click Refresh lists.";
  }
  if (status === 402) {
    return "Insufficient credits for this action.";
  }
  if (typeof body?.error === "string") return body.error;
  return `Request failed (${status})`;
}

async function request(path, options = {}) {
  const { apiUrl, authToken, stubEmail, useStubAuth } = await getConfig();
  const headers = new Headers(options.headers || {});
  headers.set("Content-Type", "application/json");

  if (authToken && !useStubAuth) {
    headers.set("Authorization", `Bearer ${authToken}`);
  } else {
    headers.set("x-stub-user-email", stubEmail);
  }

  return fetch(`${apiUrl}${path}`, {
    ...options,
    headers,
  });
}

export async function skoutFetch(path, options = {}) {
  const config = await getConfig();

  if (!config.useStubAuth) {
    await ensureFreshAuth();
  }

  let res;
  try {
    res = await request(path, options);
  } catch {
    throw new Error(`Cannot reach API at ${config.apiUrl}. Is the backend running on port 3001?`);
  }

  if (res.status === 401 && !config.useStubAuth) {
    await refreshAuthFromSkoutTabs();
    try {
      res = await request(path, options);
    } catch {
      throw new Error(`Cannot reach API at ${config.apiUrl}. Is the backend running on port 3001?`);
    }
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(formatApiError(res.status, body));
  }

  if (res.status === 204) return null;
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return res.json();
  }
  return res.text();
}

export async function listLists() {
  const body = await skoutFetch("/api/v1/lists");
  return body.data || [];
}

/** Fetch lists and update local cache. */
export async function listListsCached({ force = false } = {}) {
  const CACHE_KEY = "listsCache";
  const CACHE_AT = "listsCacheAt";
  const TTL = 120_000;

  if (!force) {
    const cached = await chrome.storage.local.get([CACHE_KEY, CACHE_AT]);
    if (cached[CACHE_KEY] && cached[CACHE_AT] && Date.now() - cached[CACHE_AT] < TTL) {
      return cached[CACHE_KEY];
    }
  }

  const lists = await listLists();
  const cached = await chrome.storage.local.get([CACHE_KEY]);
  const prev = JSON.stringify(cached[CACHE_KEY] || []);
  const next = JSON.stringify(lists);
  if (prev !== next || force) {
    await safeLocalSet({ [CACHE_KEY]: lists, [CACHE_AT]: Date.now() }, force ? 0 : 30_000);
  }
  return lists;
}

export async function activateProspect(profile) {
  const fields = buildProspectFields(profile);
  await skoutFetch("/api/v1/prospects/activate", {
    method: "POST",
    body: JSON.stringify({ prospects: [fields] }),
  });
  return resolveProspectId({ ...profile, companyName: profile.companyName || "linkedin" });
}

export async function addProspectsToList(listId, prospectIds) {
  return skoutFetch(`/api/v1/lists/${listId}/members`, {
    method: "POST",
    body: JSON.stringify({ prospectIds }),
  });
}

export async function addProspectToList(listId, profile) {
  const fields = buildProspectFields(profile);
  const prospectId = await resolveProspectId(profile);
  const prospect = { prospectId, ...fields };
  if (!prospect.linkedinUrl) delete prospect.linkedinUrl;
  return skoutFetch(`/api/v1/lists/${listId}/members`, {
    method: "POST",
    body: JSON.stringify({ prospects: [prospect] }),
  });
}

export async function enrichProspect(prospectId, profile) {
  const fields = buildProspectFields(profile);
  return skoutFetch(`/api/v1/prospects/${prospectId}/enrich`, {
    method: "POST",
    body: JSON.stringify({
      prospect: { prospectId, ...fields },
      fields: ["email"],
    }),
  });
}
