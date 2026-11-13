import { afterEach, describe, expect, it } from "vitest";
import {
  CAPTURE_DRAFT_KEY,
  __test,
  captureQueueReport,
  handleCaptureMessage,
  timing,
} from "../capture-background.js";
import { loadCapturePage } from "./helpers/capture-dom.js";

timing.delay = () => Promise.resolve();

const companyUrl = "https://www.linkedin.com/company/example/";
const searchUrl = "https://www.linkedin.com/search/results/people/?currentCompany=%5B%22123%22%5D";
const stateKey = "company-people-capture:example";
const sidePanel = {};
const previousChrome = globalThis.chrome;
afterEach(() => {
  globalThis.chrome = previousChrome;
});

/** A company with `totalPages` result pages of `perPage` people, and a fake Skout API. */
function company(totalPages, perPage) {
  const storage = {};
  const tabs = new Map();
  const api = [];
  let nextTab = 100;
  const pageUrl = (page) => `${searchUrl}&page=${page}`;
  globalThis.chrome = {
    runtime: { id: "test-extension" },
    tabs: {
      async get(id) {
        if (id === 7) return { id, url: companyUrl, status: "complete" };
        throw new Error("Tab closed");
      },
      async create({ url }) {
        const id = nextTab++;
        tabs.set(id, { page: Number(new URL(url).searchParams.get("page") || 1) });
        return { id };
      },
      async remove(id) { tabs.delete(id); },
      async sendMessage(id, request) {
        const tab = tabs.get(id);
        if (!tab) throw new Error("Tab closed");
        if (request.type === "COMPANY_PEOPLE_READER_READY") return { ok: true, url: pageUrl(tab.page), page: tab.page };
        if (request.type === "COLLECT_COMPANY_PEOPLE_PAGE") {
          return {
            ok: true, url: pageUrl(tab.page), page: tab.page, hasNext: tab.page < totalPages,
            peopleProfiles: Array.from({ length: perPage }, (_, index) => ({
              publicId: `p-${tab.page}-${index}`,
              sourceUrl: `https://www.linkedin.com/in/p-${tab.page}-${index}/`,
              fullName: `Person ${tab.page}-${index}`,
            })),
          };
        }
        if (request.type === "ADVANCE_COMPANY_PEOPLE_PAGE") { tab.page++; return { ok: true }; }
        throw new Error(`Unexpected message ${request.type}`);
      },
    },
    storage: {
      local: {
        async get(keys) {
          if (keys === null) return { ...storage };
          return Object.fromEntries([].concat(keys).map((key) => [key, storage[key]]));
        },
        async set(values) { Object.assign(storage, values); },
        async remove(keys) { for (const key of [].concat(keys)) delete storage[key]; },
      },
    },
  };
  __test.deps.skoutFetch = async (path, options = {}) => {
    api.push({ path, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined });
    if (path.includes("/ingest/company")) {
      const body = JSON.parse(options.body);
      return { run: { id: "run", status: "completed", terminal: true }, received: body.peopleProfiles?.length || 0, created: body.peopleProfiles?.length || 0, merged: 0, rejected: 0 };
    }
    if (path.endsWith("/capture/queue") && !options.method) return { items: [] };
    if (path.includes("/capture/queue/")) return { item: {} };
    return { enabled: true, caps: { dailyLeadLimit: 1000 }, usage: { remainingToday: 1000 } };
  };
  const read = () => handleCaptureMessage(
    { type: "READ_COMPANY_PEOPLE_SEARCH", companyId: "example", url: searchUrl, expectedAssociatedMembers: totalPages * perPage },
    { tab: { id: 7 }, frameId: 0, url: companyUrl },
  );
  /** Stores the reviewed batch the way the side panel does, then saves it. */
  const save = async (result) => {
    storage[CAPTURE_DRAFT_KEY] = {
      kind: "company",
      data: { publicId: "example", name: "Example Co", sourceUrl: companyUrl, peopleProfiles: result.peopleProfiles },
      capturedAt: "2026-11-13T10:00:00.000Z",
      meta: { companyId: "example", checkpointToken: result.checkpointToken, progress: result.progress },
    };
    return handleCaptureMessage({ type: "capture-send" }, sidePanel);
  };
  return { storage, api, read, save };
}

describe("company capture queue", () => {
  it("captures a 1,000-person company in batches under the 250 limit and always offers to continue", async () => {
    const { read, save, api, storage } = company(34, 30); // 1,020 people, 30 per results page
    const seen = new Set();
    const saves = [];
    for (let batch = 0; batch < 10; batch++) {
      const result = await read();
      expect(result.ok).toBe(true);
      expect(result.peopleProfiles.length).toBeLessThanOrEqual(250);
      result.peopleProfiles.forEach((profile) => seen.add(profile.publicId));
      const saved = await save(result);
      expect(saved.ok).toBe(true);
      saves.push(saved.checkpoint);
      if (saved.checkpoint.complete) break;
      // The side panel shows "Continue capturing queue" for exactly this state.
      expect(saved.checkpoint).toMatchObject({ complete: false, companyId: "example", queued: true });
    }
    expect(seen.size).toBe(1020);
    expect(saves.at(-1)).toMatchObject({ complete: true, distinctCandidates: 1020 });
    expect(saves.length).toBeGreaterThan(4);
    const reports = api.filter((call) => call.method === "PUT");
    expect(reports).toHaveLength(saves.length);
    expect(reports[0]).toMatchObject({ path: "/api/v1/enrichment/capture/queue/example", body: { companyName: "Example Co", complete: false, peopleFound: 240, expectedPeople: 1020 } });
    expect(reports.at(-1).body).toMatchObject({ complete: true, peopleFound: 1020 });
    expect(storage[stateKey].committed.complete).toBe(true);
  });

  it("keeps the queue position when a batch is not saved", async () => {
    const { read, storage } = company(20, 30);
    const first = await read();
    const again = await read();
    expect(again.peopleProfiles.map((profile) => profile.publicId)).toEqual(first.peopleProfiles.map((profile) => profile.publicId));
    expect(storage[stateKey].committed).toBeUndefined();
  });

  it("still saves the batch when the Skout queue cannot be updated", async () => {
    const env = company(20, 30);
    const fetch = __test.deps.skoutFetch;
    __test.deps.skoutFetch = async (path, options = {}) => {
      if (path.includes("/capture/queue/")) throw new Error("offline");
      return fetch(path, options);
    };
    const saved = await env.save(await env.read());
    expect(saved.ok).toBe(true);
    expect(saved.checkpoint).toMatchObject({ complete: false, queued: false });
  });

  it("lists this browser's unfinished companies with the workspace queue", async () => {
    const { storage } = company(1, 1);
    storage[stateKey] = { committed: { complete: false, pagesRead: 8, seenIds: ["a", "b"] } };
    storage["company-people-capture:done"] = { committed: { complete: true, pagesRead: 3, seenIds: ["c"] } };
    __test.deps.skoutFetch = async () => ({
      items: [
        { companyPublicId: "example", companyName: "Example Co", peopleFound: 240, expectedPeople: 900, complete: false },
        { companyPublicId: "acme", companyName: "Acme", peopleFound: 250, pagesRead: 9, complete: false },
        { companyPublicId: "old", complete: true },
      ],
    });
    const result = await handleCaptureMessage({ type: "capture-queue" }, sidePanel);
    expect(result.ok).toBe(true);
    const byId = Object.fromEntries(result.items.map((item) => [item.companyPublicId, item]));
    expect(Object.keys(byId).sort()).toEqual(["acme", "example"]);
    expect(byId.example).toMatchObject({ companyName: "Example Co", peopleFound: 240, expectedPeople: 900, pagesRead: 8, local: true });
  });

  it("shows the local queue when the workspace queue cannot be loaded", async () => {
    const { storage } = company(1, 1);
    storage[stateKey] = { draft: { pagesRead: 4, profiles: [] } };
    __test.deps.skoutFetch = async () => { throw new Error("offline"); };
    const result = await handleCaptureMessage({ type: "capture-queue" }, sidePanel);
    expect(result.items).toEqual([expect.objectContaining({ companyPublicId: "example", pausedBatch: true })]);
    expect(result.serverError).toBe("offline");
  });

  it("removes a company from both queues, even when Skout no longer lists it", async () => {
    const { storage, api } = company(1, 1);
    storage[stateKey] = { committed: { complete: false, pagesRead: 8 } };
    __test.deps.skoutFetch = async (path, options) => {
      api.push({ path, method: options?.method });
      throw Object.assign(new Error("Not found"), { status: 404 });
    };
    expect(await handleCaptureMessage({ type: "capture-queue-remove", companyId: "example" }, sidePanel)).toEqual({ ok: true });
    expect(storage[stateKey]).toBeUndefined();
    expect(api).toEqual([{ path: "/api/v1/enrichment/capture/queue/example", method: "DELETE" }]);
    expect((await handleCaptureMessage({ type: "capture-queue-remove", companyId: "../x" }, sidePanel)).ok).toBe(false);
  });

  it("continues a queued company: opens its page and starts a people-only resume", async () => {
    const sent = [];
    let url = "https://www.linkedin.com/feed/";
    globalThis.chrome = {
      runtime: { id: "test-extension" },
      tabs: {
        async get(id) { return { id, url, status: "complete" }; },
        async update(_id, props) { url = props.url; },
        async sendMessage(_id, message) { sent.push(message); return { ok: true, kind: "company" }; },
      },
      storage: { local: { async get() { return {}; }, async set() {}, async remove() {} } },
    };
    __test.deps.skoutFetch = async () => ({ enabled: true, usage: { remainingToday: 500 }, caps: { dailyLeadLimit: 1000 } });
    const result = await handleCaptureMessage({ type: "capture-queue-continue", companyId: "example", tabId: 7 }, sidePanel);
    expect(result).toEqual({ ok: true, kind: "company" });
    expect(url).toBe(companyUrl);
    expect(sent.at(-1)).toEqual({ type: "SKOUT_CAPTURE_START", kind: "company", options: { includeCompany: false, includePeople: true, resume: true } });
  });

  it("explains why it cannot continue once the daily limit is reached", async () => {
    globalThis.chrome = {
      runtime: { id: "test-extension" },
      tabs: { async get(id) { return { id, url: companyUrl, status: "complete" }; } },
      storage: { local: { async get() { return {}; }, async set() {}, async remove() {} } },
    };
    __test.deps.skoutFetch = async () => ({ enabled: true, usage: { remainingToday: 0 }, caps: { dailyLeadLimit: 1000 } });
    const result = await handleCaptureMessage({ type: "capture-queue-continue", companyId: "example", tabId: 7 }, sidePanel);
    expect(result).toEqual({ ok: false, error: "Daily capture limit of 1000 leads reached. Try again tomorrow." });
  });

  it("never lets a LinkedIn tab drive the queue", () => {
    const linkedinTab = { tab: { id: 7 }, frameId: 0, url: companyUrl };
    expect(handleCaptureMessage({ type: "capture-queue-continue", companyId: "example" }, linkedinTab)).toBeUndefined();
    expect(handleCaptureMessage({ type: "capture-queue-remove", companyId: "example" }, linkedinTab)).toBeUndefined();
  });

  it("reports only bounded counts to Skout", () => {
    expect(captureQueueReport("  Example Co  ", { pagesRead: 8, distinctCandidates: 240, complete: false, expectedAssociatedMembers: 960, stopReason: "more pages available" }))
      .toEqual({ companyName: "Example Co", pagesRead: 8, peopleFound: 240, complete: false, expectedPeople: 960, stopReason: "more pages available" });
    expect(captureQueueReport(undefined, { pagesRead: "x", complete: true })).toEqual({ pagesRead: 0, peopleFound: 0, complete: true });
  });
});

describe("company batch limit", () => {
  const load = () => loadCapturePage({
    url: companyUrl,
    html: "<main></main>",
    files: ["capture/extract-common.js", "capture/company-sections.js", "capture/page-extract.js", "capture/company-capture.js"],
  });
  const people = (prefix, count) => Array.from({ length: count }, (_, index) => ({ publicId: `${prefix}-${index}` }));

  it("keeps resumable search people first and defers extra People-page cards", () => {
    const { limitBatch } = load().SkoutCompanyCapture;
    const directory = people("dir", 30);
    const search = people("search", 240);
    const { profiles, deferred } = limitBatch([...directory, ...search], new Set(search.map((p) => p.publicId)));
    expect(profiles).toHaveLength(250);
    expect(deferred).toBe(20);
    expect(profiles.filter((p) => p.publicId.startsWith("search"))).toHaveLength(240);
  });

  it("leaves a batch within the limit untouched", () => {
    const { limitBatch } = load().SkoutCompanyCapture;
    const batch = people("x", 12);
    expect(limitBatch(batch, new Set())).toEqual({ profiles: batch, deferred: 0 });
  });
});
