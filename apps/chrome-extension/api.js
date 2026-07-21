import { ensureFreshAuth, refreshAuthFromSkoutTabs } from "./auth.js";
import { safeLocalSet } from "./storage-throttle.js";
import { log, logError, timeStep } from "./debug.js";
import {
  DEFAULT_API_URL,
  DEFAULT_WEB_URL,
  normalizeSkoutBase,
  skoutSignInHint,
} from "./skout-urls.js";

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

function trimOrUndefined(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function validPhotoUrl(value) {
  const trimmed = trimOrUndefined(value);
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

function buildProspectFields(profile) {
  const companyDomain = normalizeDomain(slugCompanyDomain(profile.companyName || "linkedin"));
  const fields = {
    fullName: trimOrUndefined(profile.fullName),
    title: trimOrUndefined(profile.title),
    companyName: trimOrUndefined(profile.companyName),
    linkedinUrl: trimOrUndefined(profile.linkedinUrl),
    companyDomain,
    headline: trimOrUndefined(profile.headline),
    location: trimOrUndefined(profile.location),
    city: trimOrUndefined(profile.city),
    state: trimOrUndefined(profile.state),
    country: trimOrUndefined(profile.country),
    about: trimOrUndefined(profile.about),
    connections: trimOrUndefined(profile.connections),
    followers: trimOrUndefined(profile.followers),
    photoUrl: validPhotoUrl(profile.photoUrl),
  };
  // Drop undefined keys so we never send empty fields.
  for (const key of Object.keys(fields)) {
    if (fields[key] === undefined) delete fields[key];
  }
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

function formatApiError(status, body, webUrl) {
  const hint = skoutSignInHint(webUrl);
  if (status === 401) {
    const detail = typeof body?.error === "string" ? body.error.toLowerCase() : "";
    if (detail.includes("expired")) {
      return `Session expired — keep Skout open (${normalizeSkoutBase(webUrl)}), then click Refresh lists.`;
    }
    return `Session expired — ${hint}.`;
  }
  if (status === 402) {
    return "Insufficient credits for this action.";
  }
  if (typeof body?.error === "string") {
    if (body.error === "ICP_NOT_CONFIGURED") {
      return "ICP not configured — open Skout and set your ICP under Settings.";
    }
    return body.error;
  }
  return `Request failed (${status})`;
}

/** Hard caps so a stalled network call or auth refresh can never hang the UI forever. */
const REQUEST_TIMEOUT_MS = 20_000;
const AUTH_REFRESH_TIMEOUT_MS = 20_000;

function isAbortError(error) {
  return error?.name === "AbortError";
}

/** Reject with a clear message if `promise` doesn't settle within `ms`. */
function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function request(path, options = {}, bearerOverride) {
  const { apiUrl, authToken, stubEmail, useStubAuth } = await getConfig();
  const headers = new Headers(options.headers || {});
  headers.set("Content-Type", "application/json");

  if (useStubAuth) {
    headers.set("x-stub-user-email", stubEmail);
  } else {
    const token = bearerOverride || authToken;
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    } else {
      headers.set("x-stub-user-email", stubEmail);
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    return await fetch(`${apiUrl}${path}`, {
      ...options,
      headers,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function skoutFetch(path, options = {}) {
  const config = await getConfig();
  const method = options.method || "GET";
  log(`skoutFetch ${method} ${path}`, { apiUrl: config.apiUrl, useStubAuth: config.useStubAuth });

  let bearerToken = null;
  if (!config.useStubAuth) {
    const auth = await timeStep("ensureFreshAuth", () =>
      withTimeout(
        ensureFreshAuth(),
        AUTH_REFRESH_TIMEOUT_MS,
        `Session refresh timed out — open Skout (${normalizeSkoutBase(config.webUrl)}), sign in, then click Connect Skout account.`
      )
    );
    bearerToken = auth?.token ?? null;
  }

  const reachError = (error) =>
    isAbortError(error)
      ? new Error(`The API at ${config.apiUrl} didn't respond in time. Check it's running, then try again.`)
      : new Error(`Cannot reach API at ${config.apiUrl}. Check the API URL in extension settings.`);

  let res;
  try {
    res = await timeStep(`fetch ${method} ${path}`, () => request(path, options, bearerToken));
  } catch (error) {
    throw reachError(error);
  }

  log(`fetch response ${res.status} for ${method} ${path}`);

  if (res.status === 401 && !config.useStubAuth) {
    log("401 — attempting token refresh from Skout tab");
    const refreshed = await withTimeout(
      refreshAuthFromSkoutTabs(),
      AUTH_REFRESH_TIMEOUT_MS,
      `Session refresh timed out — open Skout (${normalizeSkoutBase(config.webUrl)}) and click Connect Skout account.`
    ).catch((err) => {
      logError("token refresh failed:", err instanceof Error ? err.message : err);
      return null;
    });
    if (!refreshed?.token) {
      throw new Error(`Session expired — open Skout (${normalizeSkoutBase(config.webUrl)}), sign in, then click Connect Skout account.`);
    }
    bearerToken = refreshed.token;
    try {
      res = await timeStep(`fetch retry ${method} ${path}`, () => request(path, options, bearerToken));
      log(`retry response ${res.status} for ${method} ${path}`);
    } catch (error) {
      throw reachError(error);
    }
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    logError(`API error ${res.status} for ${method} ${path}:`, body);
    throw new Error(formatApiError(res.status, body, config.webUrl));
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

export async function activateProspects(profiles) {
  if (!profiles?.length) return [];
  const prospects = profiles.map((profile) => buildProspectFields(profile));
  await skoutFetch("/api/v1/prospects/activate", {
    method: "POST",
    body: JSON.stringify({ prospects }),
  });
  return Promise.all(
    profiles.map((profile) =>
      resolveProspectId({ ...profile, companyName: profile.companyName || "linkedin" })
    )
  );
}

export async function getListMemberIds(listId) {
  const members = await skoutFetch(`/api/v1/lists/${listId}/members`);
  if (!Array.isArray(members)) return new Set();
  return new Set(members.map((m) => m.prospectId));
}

export async function addProspectBatchToList(listId, profiles) {
  const prospects = await Promise.all(
    profiles.map(async (profile) => {
      const fields = buildProspectFields(profile);
      const prospectId = await resolveProspectId(profile);
      const entry = { prospectId, ...fields };
      if (!entry.linkedinUrl) delete entry.linkedinUrl;
      return entry;
    })
  );
  return skoutFetch(`/api/v1/lists/${listId}/members`, {
    method: "POST",
    body: JSON.stringify({ prospects }),
  });
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
  const response = await skoutFetch(`/api/v1/prospects/${prospectId}/enrich`, {
    method: "POST",
    body: JSON.stringify({
      prospect: { prospectId, ...fields },
      fields: ["company", "email", "validation"],
    }),
  });
  const emailResult = response.results?.find((r) => r.field === "email" && r.isPrimary);
  return {
    ...response,
    email: emailResult?.value ?? null,
    emailStatus: response.results?.find((r) => r.field === "email_status")?.value ?? null,
  };
}

export async function scoreProspect(prospectId, profile) {
  const fields = buildProspectFields(profile);
  return skoutFetch("/api/v1/enrichment/score", {
    method: "POST",
    body: JSON.stringify({
      prospect: {
        prospectId,
        fullName: fields.fullName,
        title: fields.title,
        industry: fields.industry,
        country: fields.country,
        companyDomain: fields.companyDomain,
        employeeCount: profile.employeeCount,
        signals: profile.signals,
      },
    }),
  });
}

export async function listSequences() {
  const body = await skoutFetch("/api/v1/sequences?status=active");
  return body.data || [];
}

export async function enrollInSequence(sequenceId, prospectIds) {
  return skoutFetch(`/api/v1/sequences/${sequenceId}/enroll`, {
    method: "POST",
    body: JSON.stringify({ prospectIds: Array.isArray(prospectIds) ? prospectIds : [prospectIds] }),
  });
}

export async function listPendingLinkedinJobs(limit = 5) {
  return skoutFetch(`/api/v1/linkedin/outreach/pending?limit=${limit}`);
}

export async function claimLinkedinJob(jobId) {
  return skoutFetch(`/api/v1/linkedin/outreach/${jobId}/claim`, { method: "POST", body: "{}" });
}

export async function completeLinkedinJob(jobId) {
  return skoutFetch(`/api/v1/linkedin/outreach/${jobId}/complete`, { method: "POST", body: "{}" });
}

export async function failLinkedinJob(jobId, reason) {
  return skoutFetch(`/api/v1/linkedin/outreach/${jobId}/fail`, {
    method: "POST",
    body: JSON.stringify({ reason: reason || "linkedin_send_failed" }),
  });
}
