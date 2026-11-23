import { afterEach, describe, expect, it } from "vitest";
import { JOB_SCAN_PENDING_KEY, JOB_SCAN_RESULT_KEY, __test, activeJobScanInfo, handleCaptureMessage, timing } from "../capture-background.js";

timing.delay = () => Promise.resolve();
const previousChrome = globalThis.chrome;
afterEach(() => { globalThis.chrome = previousChrome; });
const panel = {};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async (times = 20) => { for (let i = 0; i < times; i++) await tick(); };
const job = (n) => ({ jobId: String(8010000 + n), jobUrl: `https://www.linkedin.com/jobs/view/${8010000 + n}/`, title: `Role ${n}`, companyName: "Acme", location: "Austin, TX", source: "company-jobs-tab" });

/** A LinkedIn whose search pages wait on a gate, so a scan can be stopped while it is in the middle of reading. */
function world() {
  const store = {};
  const tabs = new Map();
  const api = [];
  let nextTab = 100;
  let gate = null;
  const gated = { value: false };
  globalThis.chrome = {
    runtime: { id: "t" },
    tabs: {
      async create({ url }) { const id = nextTab++; tabs.set(id, url); return { id }; },
      async remove(id) { tabs.delete(id); },
      async sendMessage(id, message) {
        const url = tabs.get(id);
        if (!url) throw new Error("Tab closed");
        if (message.type === "JOBS_READER_READY") return { ok: true, url };
        if (message.type === "COLLECT_JOB_DETAIL") return { ok: true, state: "ok", detail: { description: "A real description of the role with enough words in it." } };
        const start = Number(new URL(url).searchParams.get("start") || 0);
        if (url.includes("/jobs/search/") && start >= 25 && gated.value) await new Promise((resolve) => { gate = resolve; });
        if (url.includes("/jobs/search/")) return { ok: true, state: "ok", jobs: [job(100 + start)], complete: true, hasNext: start < 50, expectedTotal: 75, notes: [] };
        return { ok: true, state: "ok", jobs: [job(1), job(2)], complete: true, memberId: "1441", notes: [] };
      },
    },
    storage: { local: {
      async get(keys) { return keys === null ? { ...store } : Object.fromEntries([].concat(keys).map((key) => [key, store[key]])); },
      async set(values) { Object.assign(store, values); },
      async remove(keys) { for (const key of [].concat(keys)) delete store[key]; },
    } },
  };
  __test.deps.skoutFetch = async (path, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    api.push({ path, method: options.method || "GET", body });
    if (path.endsWith("/jobs/known")) return { jobs: [] };
    if (path.endsWith("/jobs/scan")) return { scan: { status: body.status === "failed" && !body.jobs.length ? "failed" : body.passes.every((pass) => pass.complete) && body.status === "completed" ? "completed_verified" : "partial", jobsNew: body.jobs.length, jobsUpdated: 0 } };
    return { enabled: true, caps: { dailyLeadLimit: 1000 }, usage: { remainingToday: 1000 } };
  };
  __test.resetStatusCache();
  return { store, api, tabs, gated, release: () => gate?.() };
}
const scan = (company = "acme", extra = {}) => handleCaptureMessage({ type: "capture-jobs-scan", tabId: 7, companyId: company, name: company.toUpperCase(), ...extra }, panel);

describe("Scan job roles: Start, Stop and Quit run the real scan", () => {
  it("refuses a second scan while one is running, whichever company it is for", async () => {
    const w = world();
    w.gated.value = true;
    const first = scan("acme");
    await settle();
    expect(activeJobScanInfo()).toMatchObject({ companyId: "acme", name: "ACME" });
    const second = await scan("globex", { tabId: 8 });
    expect(second).toMatchObject({ ok: false, error: expect.stringMatching(/already running/) });
    expect(second.error).toMatch(/ACME/);
    expect((await handleCaptureMessage({ type: "capture-jobs-active" }, panel)).active).toMatchObject({ companyId: "acme" });
    w.gated.value = false;
    w.release();
    await first;
    expect(activeJobScanInfo()).toBeNull();
    // A scan can start again once the first has ended.
    expect((await scan("globex", { tabId: 8 })).ok).toBe(true);
  });

  it("Stop ends the scan after the page it is on, keeps what was read, saves it as unfinished, and Start resumes it", async () => {
    const w = world();
    w.gated.value = true;
    const running = scan("acme");
    await settle();
    expect((await handleCaptureMessage({ type: "capture-jobs-stop" }, panel)).ok).toBe(true);
    expect(activeJobScanInfo()).toMatchObject({ stopping: "stop" });
    w.gated.value = false;
    w.release();
    const result = await running;
    expect(result).toMatchObject({ ok: true, saved: true, stopped: true });
    // What was read is saved as an unfinished scan, never as a verified one.
    const saved = w.api.filter((call) => call.path.endsWith("/jobs/scan")).at(-1).body;
    expect(saved.status).toBe("failed");
    expect(saved.error).toMatch(/stopped/);
    expect(saved.jobs.length).toBeGreaterThanOrEqual(3);
    expect(result.scan.status).toBe("partial");
    expect(Object.keys(w.store).some((key) => key.startsWith("skoutJobScanCheckpoint:acme"))).toBe(true);
    // Start again: it resumes, and does not read the Jobs tab or the first result pages a second time.
    w.api.length = 0;
    const resumed = await scan("acme");
    expect(resumed.ok).toBe(true);
    expect(resumed.scan.counts).toMatchObject({ resumed: true });
  });

  it("Quit discards the scan: nothing is kept, the checkpoint is removed, and no roles are saved", async () => {
    const w = world();
    w.gated.value = true;
    const running = scan("acme");
    await settle();
    expect((await handleCaptureMessage({ type: "capture-jobs-quit" }, panel)).ok).toBe(true);
    w.gated.value = false;
    w.release();
    const result = await running;
    expect(result).toMatchObject({ ok: true, quit: true });
    expect(Object.keys(w.store).filter((key) => key.startsWith("skoutJobScanCheckpoint:"))).toEqual([]);
    expect(w.store[JOB_SCAN_RESULT_KEY]).toBeUndefined();
    expect(w.store[JOB_SCAN_PENDING_KEY]).toBeUndefined();
    const posts = w.api.filter((call) => call.path.endsWith("/jobs/scan"));
    // The only thing sent is the closing of the "in progress" scan: no roles.
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({ status: "failed", jobs: [], error: "Cancelled by the user." });
    expect(activeJobScanInfo()).toBeNull();
    // Quit means start fresh: the next scan does not resume anything.
    expect((await scan("acme")).scan.counts.resumed).toBe(false);
  });

  it("says so when there is nothing to stop", async () => {
    world();
    expect(await handleCaptureMessage({ type: "capture-jobs-stop" }, panel)).toMatchObject({ ok: false, error: expect.stringMatching(/No job scan is running/) });
    expect(await handleCaptureMessage({ type: "capture-jobs-quit" }, panel)).toMatchObject({ ok: false });
  });
});
