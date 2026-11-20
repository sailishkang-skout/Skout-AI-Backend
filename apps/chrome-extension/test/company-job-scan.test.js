import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  JOB_SCAN_PENDING_KEY,
  JOB_SCAN_RESULT_KEY,
  __test,
  collectJobScan,
  handleCaptureMessage,
  jobViewUrl,
  jobsSearchUrl,
  jobsTabUrl,
  sanitizeJobScan,
  timing,
} from "../capture-background.js";

timing.delay = () => Promise.resolve();
const previousChrome = globalThis.chrome;
afterEach(() => { globalThis.chrome = previousChrome; });

const id_ = (n) => String(4010000 + Number(n));
const card = (n, extra = {}) => ({ jobId: id_(n), jobUrl: `https://www.linkedin.com/jobs/view/${id_(n)}/`, title: `Role ${n}`, location: "Austin, TX", source: "company-jobs-tab", ...extra });
const ok = (jobs, extra = {}) => ({ ok: true, state: "ok", jobs, complete: true, notes: [], ...extra });
const EMPTY = { ok: true, state: "empty", jobs: [], complete: true, notes: [] };

/** A scripted LinkedIn: every opened URL is answered by `route(url, message)`. */
function linkedin(route, { known = [] } = {}) {
  const store = {};
  const opened = [];
  const tabs = new Map();
  let nextTab = 100;
  globalThis.chrome = {
    runtime: { id: "t" },
    tabs: {
      async create({ url }) { const id = nextTab++; tabs.set(id, url); opened.push(url); return { id }; },
      async remove(id) { tabs.delete(id); },
      async sendMessage(id, message) {
        const url = tabs.get(id);
        if (!url) throw new Error("Tab closed");
        if (message.type === "JOBS_READER_READY") return { ok: true, url };
        return route(url, message);
      },
    },
    storage: { local: {
      async get(keys) { return keys === null ? { ...store } : Object.fromEntries([].concat(keys).map((key) => [key, store[key]])); },
      async set(values) { Object.assign(store, values); },
      async remove(keys) { for (const key of [].concat(keys)) delete store[key]; },
    } },
  };
  const api = [];
  __test.deps.skoutFetch = async (path, options = {}) => {
    api.push({ path, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined });
    if (path.endsWith("/jobs/known")) return { jobs: known };
    if (path.includes("/capture/status")) return { enabled: true };
    return { enabled: true };
  };
  return { store, opened, api };
}
const scan = (extra = {}) => collectJobScan({ owner: 7, companyId: "acme", publicName: "Acme", ...extra });
const tabUrl = "https://www.linkedin.com/company/acme/jobs/";
const search = (start = 0) => `https://www.linkedin.com/jobs/search/?f_C=1441&sortBy=DD&start=${start}`;
const detail = (id) => ({ ok: true, state: "ok", detail: { description: `Description of role ${id} with enough detail to be real.`, requirements: `Requirements of ${id}`, department: "Engineering" } });

describe("scan URLs only ever name this company", () => {
  it("builds the three addresses and refuses anything else", () => {
    expect(jobsTabUrl("acme")).toBe(tabUrl);
    expect(jobsTabUrl("../evil")).toBeUndefined();
    expect(jobsSearchUrl("1441", 25)).toBe(search(25));
    expect(jobsSearchUrl("14 41")).toBeUndefined();
    expect(jobsSearchUrl("1441", -1)).toBeUndefined();
    expect(jobsSearchUrl("1441", 5000)).toBeUndefined();
    expect(jobViewUrl("4010001")).toBe("https://www.linkedin.com/jobs/view/4010001/");
    expect(jobViewUrl("abc")).toBeUndefined();
  });
});

describe("double scan", () => {
  beforeEach(() => __test.resetStatusCache());

  it("runs the Jobs tab, then an independent job search, and merges what the first missed", async () => {
    const env = linkedin((url, message) => {
      if (message.type === "COLLECT_JOB_DETAIL") return detail(url.match(/view\/(\d+)/)[1]);
      if (url === tabUrl) return ok([card(1), card(2)], { memberId: "1441" });
      if (url === search(0)) return ok([card(1, { source: "job-search" }), card(2, { source: "job-search" }), card(3, { source: "job-search", workplaceType: "remote" })], { hasNext: false });
      throw new Error(`unexpected ${url}`);
    });
    const result = await scan();
    expect(result.status).toBe("completed");
    expect(result.passes).toEqual([
      { pass: 1, method: "company-jobs-tab", found: 2, complete: true },
      { pass: 2, method: "job-search", found: 3, complete: true },
    ]);
    expect(result.jobs.map((job) => job.jobId).sort()).toEqual(["4010001", "4010002", "4010003"]);
    expect(result.notes.join(" ")).toMatch(/found 1 role the first scan missed/);
    expect(env.opened.slice(0, 2)).toEqual([tabUrl, search(0)]);
    // Details were read for each role, and merged onto the card.
    expect(result.jobs.every((job) => job.description && job.department === "Engineering")).toBe(true);
    expect(result.jobs.find((job) => job.jobId === "4010003")).toMatchObject({ workplaceType: "remote" });
  });

  it("does not stop at the first page of results: it follows every page until the last", async () => {
    const pages = { 0: [card(1), card(2)], 25: [card(3), card(4)], 50: [card(5)] };
    const env = linkedin((url, message) => {
      if (message.type === "COLLECT_JOB_DETAIL") return detail("x");
      if (url === tabUrl) return ok([card(1)], { memberId: "1441" });
      const start = Number(new URL(url).searchParams.get("start"));
      return ok(pages[start], { hasNext: start < 50 });
    });
    const result = await scan();
    expect(result.jobs).toHaveLength(5);
    expect(env.opened.filter((url) => url.includes("jobs/search"))).toEqual([search(0), search(25), search(50)]);
    expect(result.passes[1]).toMatchObject({ pass: 2, found: 5, complete: true });
  });

  it("says when the verification pass was cut off by the page limit", async () => {
    linkedin((url, message) => {
      if (message.type === "COLLECT_JOB_DETAIL") return detail("x");
      if (url === tabUrl) return ok([card(1)], { memberId: "1441" });
      const start = Number(new URL(url).searchParams.get("start"));
      return ok([card(100 + start)], { hasNext: true });
    });
    const result = await scan();
    expect(result.passes[1]).toMatchObject({ pass: 2, complete: false });
    expect(result.notes.join(" ")).toMatch(/Verification stopped after 8 result pages/);
  });

  it("reads the Jobs tab again, deeper, when LinkedIn's company id cannot be found", async () => {
    let tabReads = 0;
    const env = linkedin((url, message) => {
      if (message.type === "COLLECT_JOB_DETAIL") return detail("x");
      tabReads++;
      return ok(tabReads === 1 ? [card(1)] : [card(1), card(2)]);
    });
    const result = await scan();
    expect(env.opened.slice(0, 2)).toEqual([tabUrl, tabUrl]);
    expect(result.passes[1]).toMatchObject({ pass: 2, method: "company-jobs-tab-deep", found: 2 });
    expect(result.jobs).toHaveLength(2);
    expect(result.notes.join(" ")).toMatch(/company id was not found/);
  });

  it("confirms zero jobs only when both passes loaded and agree", async () => {
    linkedin((url) => (url === tabUrl ? { ...EMPTY, memberId: "1441" } : EMPTY));
    const result = await scan();
    expect(result).toMatchObject({ status: "completed", jobs: [] });
    expect(result.passes.map((pass) => pass.complete)).toEqual([true, true]);
  });

  it("never reports 'no jobs' for pages that did not load", async () => {
    linkedin(() => ({ ok: true, state: "not_loaded", jobs: [], complete: false, notes: ["The jobs did not finish loading."] }));
    const result = await scan();
    expect(result.status).toBe("not_loaded");
    expect(result.jobs).toEqual([]);
    expect(result.passes.every((pass) => pass.complete === false)).toBe(true);
  });

  it("stops at a LinkedIn warning and says restricted", async () => {
    const env = linkedin(() => ({ ok: true, state: "restricted", jobs: [], complete: false, notes: ["LinkedIn asked to verify it's you."] }));
    const result = await scan();
    expect(result).toMatchObject({ status: "restricted", error: "LinkedIn asked to verify it's you." });
    expect(env.opened).toHaveLength(1);
  });

  it("keeps what it read when a page fails, and reports the failure", async () => {
    linkedin((url) => {
      if (url === tabUrl) return ok([card(1), card(2)], { memberId: "1441" });
      throw new Error("The jobs page took too long to load.");
    });
    const result = await scan();
    expect(result.jobs).toHaveLength(2);
    expect(result.passes[1]).toMatchObject({ pass: 2, complete: false });
    expect(result.notes.join(" ")).toMatch(/Verification page 1/);
  });

  it("fails with a reason, not an empty result, when the first page cannot be read", async () => {
    linkedin(() => { throw new Error("The jobs page took too long to load."); });
    const result = await scan();
    expect(result).toMatchObject({ status: "failed", error: "The jobs page took too long to load." });
    expect(result.passes[0].complete).toBe(false);
  });

  it("does not run when capture is stopped by a LinkedIn warning or switched off", async () => {
    const env = linkedin(() => ok([]));
    env.store.skoutCaptureHalt = { reason: "LinkedIn showed a warning.", at: Date.now() };
    expect(await scan()).toMatchObject({ status: "restricted" });
    expect(env.opened).toEqual([]);
    delete env.store.skoutCaptureHalt;
    __test.deps.skoutFetch = async () => ({ enabled: false, disabledReason: "Paused by admin" });
    expect(await scan()).toMatchObject({ status: "failed", error: "Capture is disabled for this workspace: Paused by admin" });
  });

  it("reads details only for roles the workspace lacks them for, newest first, up to the cap", async () => {
    const jobs = Array.from({ length: 20 }, (_, i) => card(i + 1, { postedAt: `2026-11-${String(i + 1).padStart(2, "0")}T00:00:00.000Z` }));
    const env = linkedin((url, message) => {
      if (message.type === "COLLECT_JOB_DETAIL") return detail(url.match(/view\/(\d+)/)[1]);
      if (url === tabUrl) return ok(jobs, { memberId: "1441" });
      return ok(jobs, { hasNext: false });
    }, { known: [{ jobId: id_(20), detailsComplete: true }, { jobId: id_(19), detailsComplete: false }] });
    const result = await scan();
    const read = env.opened.filter((url) => url.includes("/jobs/view/")).map((url) => url.match(/view\/(\d+)/)[1]);
    expect(read).toHaveLength(15);
    expect(read).not.toContain(id_(20));
    expect(read[0]).toBe(id_(19));
    expect(result.jobs.filter((job) => job.description)).toHaveLength(15);
    expect(result.notes.join(" ")).toMatch(/5 roles have no description yet/);
  });
});

describe("saving a scan", () => {
  beforeEach(() => __test.resetStatusCache());
  const lone = () => linkedin((url, message) => (message.type === "COLLECT_JOB_DETAIL" ? detail("x") : ok([card(1)], { memberId: "1441", hasNext: false })));
  const timeout = () => Object.assign(new Error("The API didn't respond in time."), { transient: true, timedOut: true });

  it("saves the scan and shows what the workspace recorded", async () => {
    const env = lone();
    const original = __test.deps.skoutFetch;
    __test.deps.skoutFetch = async (path, options) => (path.endsWith("/jobs/scan") ? { scan: { status: "completed_verified", verified: true, jobsNew: 1, jobsUpdated: 0 } } : original(path, options));
    const result = await handleCaptureMessage({ type: "capture-jobs-scan", tabId: 7, companyId: "acme", name: "Acme" }, {});
    expect(result).toMatchObject({ ok: true, saved: true, scan: { status: "completed_verified", verified: true, jobsFound: 1, jobsNew: 1 } });
    expect(env.store[JOB_SCAN_RESULT_KEY]).toMatchObject({ companyId: "acme", jobsFound: 1 });
    expect(env.api.some((call) => call.path.endsWith("/jobs/scan/start"))).toBe(true);
  });

  it("sends a timed-out save again with the same scan id, and keeps the scan when it cannot be confirmed", async () => {
    const env = lone();
    const ids = [];
    const original = __test.deps.skoutFetch;
    let calls = 0;
    __test.deps.skoutFetch = async (path, options) => {
      if (path.endsWith("/jobs/scan")) { ids.push(JSON.parse(options.body).clientScanId); calls++; throw timeout(); }
      return original(path, options);
    };
    const result = await handleCaptureMessage({ type: "capture-jobs-scan", tabId: 7, companyId: "acme", name: "Acme" }, {});
    expect(result).toMatchObject({ ok: false, pending: true });
    expect(result.error).toMatch(/will not be saved twice/);
    expect(calls).toBe(3);
    expect(new Set(ids).size).toBe(1);
    expect(env.store[JOB_SCAN_PENDING_KEY].scan.clientScanId).toBe(ids[0]);
    // Save again succeeds once Skout answers.
    __test.deps.skoutFetch = async () => ({ scan: { status: "completed_verified", verified: true, jobsNew: 1, jobsUpdated: 0 } });
    expect(await handleCaptureMessage({ type: "capture-jobs-retry-save" }, {})).toMatchObject({ ok: true, saved: true });
    expect(env.store[JOB_SCAN_PENDING_KEY]).toBeUndefined();
  });

  it("explains that the company must be captured first", async () => {
    lone();
    const original = __test.deps.skoutFetch;
    __test.deps.skoutFetch = async (path, options) => {
      if (path.endsWith("/jobs/scan")) throw Object.assign(new Error("Capture this company first, then its job roles can be saved."), { body: { error: "company_not_captured" } });
      return original(path, options);
    };
    const result = await handleCaptureMessage({ type: "capture-jobs-scan", tabId: 7, companyId: "acme", name: "Acme" }, {});
    expect(result).toMatchObject({ ok: false, error: "Capture this company first, then its job roles can be saved." });
    expect(result.pending).toBeUndefined();
  });

  it("refuses a bad company, a missing tab, a second scan on the same tab and a tab that is not the panel's", async () => {
    lone();
    expect(await handleCaptureMessage({ type: "capture-jobs-scan", tabId: 7, companyId: "../x" }, {})).toMatchObject({ ok: false });
    expect(await handleCaptureMessage({ type: "capture-jobs-scan", companyId: "acme" }, {})).toMatchObject({ ok: false });
    expect(handleCaptureMessage({ type: "capture-jobs-scan", tabId: 7, companyId: "acme" }, { tab: { id: 7 } })).toBeUndefined();
    expect(handleCaptureMessage({ type: "capture-jobs-retry-save" }, { tab: { id: 7 } })).toBeUndefined();
  });

  it("lists the rescans the workspace asked for", async () => {
    lone();
    __test.deps.skoutFetch = async () => ({ scans: [{ scanId: "s1", companyPublicId: "acme", name: "Acme" }, { scanId: "s2", companyPublicId: "../bad", name: "Bad" }] });
    expect(await handleCaptureMessage({ type: "capture-job-scans-requested" }, {})).toEqual({ ok: true, scans: [{ scanId: "s1", companyPublicId: "acme", name: "Acme" }] });
  });
});

describe("what is sent to the API", () => {
  it("is trimmed to what the API accepts, deduplicated, and never invents a field", () => {
    const clean = sanitizeJobScan({
      clientScanId: "scan-12345678",
      status: "completed",
      passes: [{ pass: 1, method: "x".repeat(200), found: 9, complete: true }],
      jobs: [
        { jobId: "4010001", title: "  Engineer  ", workplaceType: "anywhere", postedAt: "not a date", description: "d".repeat(40000) },
        { jobId: "4010001", title: "Engineer again" },
        { title: "No id", location: "Remote" },
        { title: "No id", location: "remote" },
        { title: "" },
        { jobId: "12", title: "Bad id" },
      ],
      notes: ["n".repeat(400), "", "ok"],
      error: "e".repeat(600),
    });
    expect(clean.jobs).toHaveLength(3);
    expect(clean.jobs[0]).toEqual({ jobId: "4010001", jobUrl: "https://www.linkedin.com/jobs/view/4010001/", title: "Engineer", description: "d".repeat(30000) });
    expect(clean.jobs[0]).not.toHaveProperty("workplaceType");
    expect(clean.jobs[0]).not.toHaveProperty("postedAt");
    expect(clean.jobs[2]).toEqual({ title: "Bad id" });
    expect(clean.passes[0].method).toHaveLength(80);
    expect(clean.notes).toEqual(["n".repeat(300), "ok"]);
    expect(clean.error).toHaveLength(500);
  });
});
