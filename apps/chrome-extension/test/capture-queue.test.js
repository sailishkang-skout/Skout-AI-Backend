import { afterEach, describe, expect, it } from "vitest";
import {
  CAPTURE_DRAFT_KEY,
  RUN_QUEUE_KEY,
  __test,
  captureQueueReport,
  handleCaptureMessage,
  timing,
} from "../capture-background.js";
import { loadCapturePage } from "./helpers/capture-dom.js";
import { companyProgressText, runItemText } from "../capture-panel.js";

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
    const result = await handleCaptureMessage({ type: "capture-continue", companyId: "example", tabId: 7 }, sidePanel);
    expect(result).toEqual({ ok: true, kind: "company", tabId: 7 });
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
    const result = await handleCaptureMessage({ type: "capture-continue", companyId: "example", tabId: 7 }, sidePanel);
    expect(result).toEqual({ ok: false, error: "Daily capture limit of 1000 leads reached. Try again tomorrow." });
  });

  it("never lets a LinkedIn tab drive the queue", () => {
    const linkedinTab = { tab: { id: 7 }, frameId: 0, url: companyUrl };
    expect(handleCaptureMessage({ type: "capture-continue", companyId: "example" }, linkedinTab)).toBeUndefined();
    expect(handleCaptureMessage({ type: "capture-queue-start", companies: [] }, linkedinTab)).toBeUndefined();
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

describe("company list for the queue", () => {
  it("lists workspace companies with this browser's saved position", async () => {
    const { storage } = company(1, 1);
    storage["company-people-capture:acme"] = { draft: { pagesRead: 2, profiles: [] } };
    storage["company-people-capture:beta"] = { committed: { complete: true, pagesRead: 3, seenIds: [] } };
    let asked;
    __test.deps.skoutFetch = async (path) => {
      asked = path;
      return { companies: [{ companyPublicId: "acme", name: "Acme", peopleFound: 240 }, { companyPublicId: "beta", name: "Beta", peopleFound: 40, complete: true }, { companyPublicId: "gamma", name: "Gamma", peopleFound: 0 }] };
    };
    const result = await handleCaptureMessage({ type: "capture-companies", q: " ac " }, sidePanel);
    expect(asked).toBe("/api/v1/enrichment/capture/companies?q=ac");
    expect(result.companies.map((entry) => [entry.companyPublicId, entry.local])).toEqual([["acme", "paused"], ["beta", "complete"], ["gamma", undefined]]);
  });

  it("reports a clear error when the list cannot be loaded", async () => {
    company(1, 1);
    __test.deps.skoutFetch = async () => { throw new Error("Request failed (404)"); };
    expect(await handleCaptureMessage({ type: "capture-companies" }, sidePanel)).toEqual({ ok: false, error: "Request failed (404)" });
  });

  it("describes each company's progress", () => {
    expect(companyProgressText({ peopleFound: 0 })).toBe("No people captured yet");
    expect(companyProgressText({ peopleFound: 240, expectedPeople: 1141, complete: false })).toBe("240 of about 1,141 people saved · more remain");
    expect(companyProgressText({ peopleFound: 96, complete: true })).toBe("All people captured (96)");
    expect(companyProgressText({ peopleFound: 5, local: "paused" })).toMatch(/paused/);
    expect(runItemText({ status: "done", saved: 12, moreRemain: true })).toBe("Saved 12 people · more remain, pick it again to continue");
    expect(runItemText({ status: "failed", error: "Page did not load" })).toBe("Could not read: Page did not load");
  });
});

describe("company queue run", () => {
  const ids = ["alpha", "beta", "gamma"];
  const picked = (list = ids) => list.map((companyPublicId) => ({ companyPublicId, name: companyPublicId.toUpperCase() }));
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const statuses = async () => Object.fromEntries((await __test.getRunQueue()).items.map((item) => [item.companyPublicId, item.status]));

  function browser({ startReply = { ok: true, kind: "company" }, status } = {}) {
    const store = {};
    const created = [];
    const opened = [];
    let url = "";
    globalThis.chrome = {
      runtime: { id: "test-extension" },
      tabs: {
        async create({ url: next }) { created.push(next); url = next; return { id: 50 }; },
        async get(id) { if (id !== 50) throw new Error("Tab closed"); return { id, url, status: "complete" }; },
        async update(_id, props) { url = props.url; },
        async remove() {},
        async sendMessage(_id, message) {
          if (message.type === "SKOUT_CAPTURE_START") { opened.push(url); return startReply; }
          return { ok: true };
        },
      },
      storage: { local: {
        async get(keys) { return keys === null ? { ...store } : Object.fromEntries([].concat(keys).map((key) => [key, store[key]])); },
        async set(values) { Object.assign(store, values); },
        async remove(keys) { for (const key of [].concat(keys)) delete store[key]; },
      } },
    };
    __test.deps.skoutFetch = async (path, options = {}) => {
      if (path.includes("/ingest/company")) {
        const body = JSON.parse(options.body);
        return { run: { id: "run", status: "completed", terminal: true }, received: body.peopleProfiles?.length || 0, created: 7, merged: 3, rejected: 0 };
      }
      if (path.includes("/capture/queue/")) return { item: {} };
      return status || { enabled: true, caps: { dailyLeadLimit: 1000 }, usage: { remainingToday: 1000 } };
    };
    const reviewFrom = (id) => handleCaptureMessage({ type: "SKOUT_CAPTURE_REVIEW", kind: "company", sourceUrl: `https://www.linkedin.com/company/${id}/`, data: { publicId: id, name: id.toUpperCase(), sourceUrl: `https://www.linkedin.com/company/${id}/`, peopleProfiles: [] } }, { tab: { id: 50 } });
    return { store, created, opened, reviewFrom };
  }

  it("reads one company at a time and moves on only after each batch is saved, discarded or fails", async () => {
    const { reviewFrom, created, opened } = browser();
    expect((await handleCaptureMessage({ type: "capture-queue-start", companies: picked() }, sidePanel)).ok).toBe(true);
    await tick();
    expect(await statuses()).toEqual({ alpha: "running", beta: "pending", gamma: "pending" });

    // alpha: reviewed, then saved -> done, beta starts.
    await reviewFrom("alpha");
    expect(await statuses()).toMatchObject({ alpha: "review", beta: "pending" });
    const saved = await handleCaptureMessage({ type: "capture-send" }, sidePanel);
    expect(saved.ok).toBe(true);
    await tick(); await tick();
    expect(await statuses()).toEqual({ alpha: "done", beta: "running", gamma: "pending" });
    expect((await __test.getRunQueue()).items[0]).toMatchObject({ saved: 10 });

    // beta: LinkedIn page fails -> failed with the reason, gamma starts.
    await handleCaptureMessage({ type: "SKOUT_CAPTURE_PROGRESS", kind: "company", active: false, isError: true, text: "Company content did not load." }, { tab: { id: 50 } });
    await tick(); await tick();
    expect(await statuses()).toEqual({ alpha: "done", beta: "failed", gamma: "running" });
    expect((await __test.getRunQueue()).items[1].error).toBe("Company content did not load.");

    // gamma: reviewed then discarded -> skipped, queue finished.
    await reviewFrom("gamma");
    await handleCaptureMessage({ type: "capture-discard" }, sidePanel);
    await tick(); await tick();
    const queue = await __test.getRunQueue();
    expect(queue.items.map((item) => item.status)).toEqual(["done", "failed", "skipped"]);
    expect(queue).toMatchObject({ active: false, note: "Every selected company has been read." });
    // One LinkedIn tab is reused for every company.
    expect(created).toEqual(["https://www.linkedin.com/company/alpha/"]);
    expect(opened).toEqual(ids.map((id) => `https://www.linkedin.com/company/${id}/`));
  });

  it("does not open the next company while a batch is waiting for review", async () => {
    const { reviewFrom } = browser();
    await handleCaptureMessage({ type: "capture-queue-start", companies: picked(["alpha", "beta"]) }, sidePanel);
    await tick();
    await reviewFrom("alpha");
    await __test.advanceRunQueue();
    expect(await statuses()).toEqual({ alpha: "review", beta: "pending" });
  });

  it("pauses and resumes from the same company", async () => {
    const { opened } = browser();
    await handleCaptureMessage({ type: "capture-queue-start", companies: picked(["alpha", "beta"]) }, sidePanel);
    await tick();
    await handleCaptureMessage({ type: "capture-queue-stop" }, sidePanel);
    expect(await statuses()).toEqual({ alpha: "pending", beta: "pending" });
    expect((await __test.getRunQueue()).active).toBe(false);
    expect((await handleCaptureMessage({ type: "capture-queue-resume" }, sidePanel)).ok).toBe(true);
    await tick();
    expect(await statuses()).toMatchObject({ alpha: "running" });
    expect(opened).toEqual(["https://www.linkedin.com/company/alpha/", "https://www.linkedin.com/company/alpha/"]);
  });

  it("stops with the reason, keeping every company waiting, when the daily limit is reached", async () => {
    browser({ status: { enabled: true, caps: { dailyLeadLimit: 1000 }, usage: { remainingToday: 0 } } });
    await handleCaptureMessage({ type: "capture-queue-start", companies: picked(["alpha", "beta"]) }, sidePanel);
    await tick();
    const queue = await __test.getRunQueue();
    expect(queue).toMatchObject({ active: false });
    expect(queue.note).toMatch(/daily capture limit/i);
    expect(queue.items.map((item) => item.status)).toEqual(["pending", "pending"]);
  });

  it("stops while capture is switched off for the workspace", async () => {
    browser({ status: { enabled: false, disabledReason: "Paused by admin" } });
    await handleCaptureMessage({ type: "capture-queue-start", companies: picked(["alpha"]) }, sidePanel);
    await tick();
    expect((await __test.getRunQueue()).note).toMatch(/Paused by admin/);
  });

  it("marks a company that cannot start as failed and carries on", async () => {
    browser({ startReply: { ok: false, error: "Open a LinkedIn company page." } });
    await handleCaptureMessage({ type: "capture-queue-start", companies: picked(["alpha", "beta"]) }, sidePanel);
    await tick(); await tick(); await tick();
    const queue = await __test.getRunQueue();
    expect(queue.items.map((item) => [item.status, item.error])).toEqual([["failed", "Open a LinkedIn company page."], ["failed", "Open a LinkedIn company page."]]);
    expect(queue.active).toBe(false);
  });

  it("validates the selection and refuses a second queue", async () => {
    browser();
    expect(await handleCaptureMessage({ type: "capture-queue-start", companies: [] }, sidePanel)).toEqual({ ok: false, error: "Select at least one company." });
    expect((await handleCaptureMessage({ type: "capture-queue-start", companies: [{ companyPublicId: "../x" }, { companyPublicId: "a b" }] }, sidePanel)).ok).toBe(false);
    expect((await handleCaptureMessage({ type: "capture-queue-start", companies: picked(["alpha", "alpha"]) }, sidePanel)).count).toBe(1);
    expect((await handleCaptureMessage({ type: "capture-queue-start", companies: picked(["beta"]) }, sidePanel)).error).toMatch(/already running/);
    expect((await handleCaptureMessage({ type: "capture-queue-clear" }, sidePanel)).error).toMatch(/Pause/);
  });

  it("clears a finished queue", async () => {
    const { store } = browser();
    await handleCaptureMessage({ type: "capture-queue-start", companies: picked(["alpha"]) }, sidePanel);
    await tick();
    await handleCaptureMessage({ type: "capture-queue-stop" }, sidePanel);
    expect((await handleCaptureMessage({ type: "capture-queue-clear" }, sidePanel)).ok).toBe(true);
    expect(store[RUN_QUEUE_KEY]).toBeUndefined();
  });

  describe("keep reading until the company is finished", () => {
    const stateKey = (id) => `company-people-capture:${id}`;
    /** Seeds the reader's saved draft so a save commits a checkpoint for it. */
    const seed = (store, id, { complete }) => {
      store[stateKey(id)] = {
        searchKey: "k", searchUrl: "https://www.linkedin.com/search/results/people/?currentCompany=%5B%221%22%5D",
        draft: { token: "t", profiles: [{ publicId: "p1" }], pagesRead: 10, resumeUrl: "https://www.linkedin.com/search/results/people/?currentCompany=%5B%221%22%5D&page=11", complete, expectedAssociatedMembers: undefined },
      };
    };
    const reviewAndSave = async (env, id, { complete, created = 250 }) => {
      seed(env.store, id, { complete });
      await handleCaptureMessage({ type: "SKOUT_CAPTURE_REVIEW", kind: "company", sourceUrl: `https://www.linkedin.com/company/${id}/`, data: { publicId: id, name: id.toUpperCase(), _captureCheckpointToken: "t", peopleProfiles: [] } }, { tab: { id: 50 } });
      const draft = env.store[CAPTURE_DRAFT_KEY];
      draft.meta.checkpointToken = "t";
      return handleCaptureMessage({ type: "capture-send", autoContinue: true }, sidePanel);
    };

    it("reads batch after batch of one company, in order, until it is finished", async () => {
      const env = browser();
      await handleCaptureMessage({ type: "capture-queue-start", companies: picked(["alpha", "beta"]), untilComplete: true }, sidePanel);
      await tick();
      expect((await reviewAndSave(env, "alpha", { complete: false })).ok).toBe(true);
      await tick(); await tick();
      // alpha goes back to waiting and is read again before beta starts.
      expect(await statuses()).toEqual({ alpha: "running", beta: "pending" });
      expect((await __test.getRunQueue()).items[0]).toMatchObject({ batches: 1, saved: 10 });
      await reviewAndSave(env, "alpha", { complete: true });
      await tick(); await tick();
      expect(await statuses()).toEqual({ alpha: "done", beta: "running" });
      expect((await __test.getRunQueue()).items[0]).toMatchObject({ batches: 2, saved: 20, moreRemain: false });
    });

    it("moves on after one batch when 'keep reading' is off", async () => {
      const env = browser();
      await handleCaptureMessage({ type: "capture-queue-start", companies: picked(["alpha", "beta"]) }, sidePanel);
      await tick();
      await reviewAndSave(env, "alpha", { complete: false });
      await tick(); await tick();
      expect(await statuses()).toEqual({ alpha: "done", beta: "running" });
      expect((await __test.getRunQueue()).items[0].moreRemain).toBe(true);
    });

    it("continues a company captured with Capture this company, with no queue running", async () => {
      const env = browser();
      const saved = await reviewAndSave(env, "alpha", { complete: false });
      expect(saved.ok).toBe(true);
      expect(saved.autoContinued).toBe(true);
      await tick(); await tick();
      const queue = await __test.getRunQueue();
      expect(queue).toMatchObject({ active: true, tabId: 50 });
      expect(queue.items[0]).toMatchObject({ companyPublicId: "alpha", name: "ALPHA", untilComplete: true, status: "running", batches: 1 });
    });

    it("does not continue a finished company or when the option is off", async () => {
      const env = browser();
      expect((await reviewAndSave(env, "alpha", { complete: true })).autoContinued).toBe(false);
      expect(await __test.getRunQueue()).toBeNull();
      seed(env.store, "beta", { complete: false });
      await handleCaptureMessage({ type: "SKOUT_CAPTURE_REVIEW", kind: "company", sourceUrl: "https://www.linkedin.com/company/beta/", data: { publicId: "beta", name: "Beta", peopleProfiles: [] } }, { tab: { id: 50 } });
      env.store[CAPTURE_DRAFT_KEY].meta.checkpointToken = "t";
      expect((await handleCaptureMessage({ type: "capture-send" }, sidePanel)).autoContinued).toBe(false);
      expect(await __test.getRunQueue()).toBeNull();
    });

    it("stops a company whose batch saved no new people", async () => {
      const env = browser();
      await handleCaptureMessage({ type: "capture-queue-start", companies: picked(["alpha", "beta"]), untilComplete: true }, sidePanel);
      await tick();
      seed(env.store, "alpha", { complete: false });
      await handleCaptureMessage({ type: "SKOUT_CAPTURE_REVIEW", kind: "company", sourceUrl: "https://www.linkedin.com/company/alpha/", data: { publicId: "alpha", name: "Alpha", peopleProfiles: [] } }, { tab: { id: 50 } });
      env.store[CAPTURE_DRAFT_KEY].meta.checkpointToken = "t";
      const fetch = __test.deps.skoutFetch;
      __test.deps.skoutFetch = async (path, options) => (path.includes("/ingest/company") ? { run: { status: "completed", terminal: true }, created: 0, merged: 0 } : fetch(path, options));
      await handleCaptureMessage({ type: "capture-send" }, sidePanel);
      await tick(); await tick();
      expect(await statuses()).toEqual({ alpha: "done", beta: "running" });
    });
  });
});
