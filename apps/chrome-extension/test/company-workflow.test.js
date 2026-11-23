import { afterEach, describe, expect, it } from "vitest";
import { RUN_QUEUE_KEY, __test, handleCaptureMessage, jobsStepFromScan, nextUnfinishedStep, reportableSteps, timing } from "../capture-background.js";

timing.delay = () => Promise.resolve();
const previousChrome = globalThis.chrome;
afterEach(() => { globalThis.chrome = previousChrome; });
const panel = {};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async (times = 25) => { for (let i = 0; i < times; i++) await tick(); };
const job = (n, extra = {}) => ({ jobId: String(7010000 + n), jobUrl: `https://www.linkedin.com/jobs/view/${7010000 + n}/`, title: `Role ${n}`, companyName: "Acme", location: "Austin, TX", source: "company-jobs-tab", ...extra });

/**
 * A scripted browser and workspace: one company tab for the company and people steps, temporary tabs for
 * job pages, and an API that records everything it is sent.
 */
function world({ jobsRoute, verify, saveJobs } = {}) {
  const store = {};
  const tabs = new Map();
  const starts = [];
  const api = [];
  let companyUrl = "";
  let nextTab = 100;
  globalThis.chrome = {
    runtime: { id: "t" },
    tabs: {
      async create({ url }) {
        if (/\/company\/[^/]+\/$/.test(url)) { companyUrl = url; return { id: 50 }; }
        const id = nextTab++; tabs.set(id, url); return { id };
      },
      async get(id) { if (id !== 50) throw new Error("Tab closed"); return { id, url: companyUrl, status: "complete" }; },
      async update(_id, props) { companyUrl = props.url; },
      async remove(id) { tabs.delete(id); },
      async sendMessage(id, message) {
        if (id === 50) {
          if (message.type === "SKOUT_CAPTURE_START") { starts.push(message.options); return { ok: true, kind: "company" }; }
          return { ok: true };
        }
        const url = tabs.get(id);
        if (!url) throw new Error("Tab closed");
        if (message.type === "JOBS_READER_READY") return { ok: true, url };
        return (jobsRoute || defaultJobs)(url, message);
      },
    },
    storage: { local: {
      async get(keys) { return keys === null ? { ...store } : Object.fromEntries([].concat(keys).map((key) => [key, store[key]])); },
      async set(values) { Object.assign(store, values); },
      async remove(keys) { for (const key of [].concat(keys)) delete store[key]; },
    } },
  };
  const defaultJobs = (url, message) => {
    if (message.type === "COLLECT_JOB_DETAIL") return { ok: true, state: "ok", detail: { description: "A real description of the role with enough words to count as one." } };
    return { ok: true, state: "ok", jobs: [job(1), job(2), job(3)], complete: true, hasNext: false, memberId: "1441", notes: [] };
  };
  __test.deps.skoutFetch = async (path, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    api.push({ path, method: options.method || "GET", body });
    if (path.includes("/ingest/company")) return { run: { id: "r", status: "completed", terminal: true }, received: body.peopleProfiles?.length || 0, created: body.peopleProfiles?.length || 0, merged: 0, rejected: 0 };
    if (path.endsWith("/jobs/known")) return { jobs: [] };
    if (path.endsWith("/jobs/scan/start")) return { ok: true };
    if (path.endsWith("/jobs/scan")) return saveJobs ? saveJobs(body) : { scan: { status: body.status !== "completed" ? body.status : body.passes.every((pass) => pass.complete) ? "completed_verified" : "partial", jobsNew: body.jobs.length, jobsUpdated: 0, verified: true } };
    if (path.endsWith("/verify")) return verify ? verify() : { companyCaptured: true, jobs: 3, people: 2, lastJobScan: "completed_verified" };
    if (path.endsWith("/capture/queue/sync")) return { updated: 1, cancelled: [] };
    if (path.includes("/capture/queue/")) return { item: {} };
    return { enabled: true, caps: { dailyLeadLimit: 1000 }, usage: { remainingToday: 1000 } };
  };
  __test.resetStatusCache();
  const review = (id, people = []) => handleCaptureMessage({
    type: "SKOUT_CAPTURE_REVIEW", kind: "company", sourceUrl: `https://www.linkedin.com/company/${id}/`,
    data: { publicId: id, name: "Acme", sourceUrl: `https://www.linkedin.com/company/${id}/`, ...(people.length ? { peopleProfiles: people } : {}) },
  }, { tab: { id: 50 } });
  const queue = () => store[RUN_QUEUE_KEY];
  const item = () => queue().items[0];
  const reported = () => api.filter((call) => call.path.endsWith("/capture/queue/sync")).flatMap((call) => call.body.items);
  return { store, api, starts, review, queue, item, reported, tabs };
}
const person = (n) => ({ publicId: `acme-p${n}`, sourceUrl: `https://www.linkedin.com/in/acme-p${n}/`, fullName: `Person ${n}` });
const start = (extra = {}) => handleCaptureMessage({ type: "capture-queue-start", companies: [{ companyPublicId: "acme", name: "Acme" }], ...extra }, panel);

describe("a company runs company → job roles → employees → verification, in that order", () => {
  it("does not finish after the company profile: jobs and employees follow, and it is complete only after verification", async () => {
    const w = world();
    await start();
    await settle();
    await w.review("acme");
    // Step 1: only the company's own page is read; nothing about people or jobs yet.
    expect(w.starts[0]).toEqual({ includeCompany: true, includePeople: false, includeJobs: false });
    expect(w.item()).toMatchObject({ step: "company", status: "review" });
    expect((await handleCaptureMessage({ type: "capture-send" }, panel)).ok).toBe(true);
    await settle();
    // Step 2 ran by itself: the job roles were scanned and saved, then step 3 started reading employees.
    expect(w.item().stepDetail.company).toMatchObject({ status: "done" });
    expect(w.item().stepDetail.jobs).toMatchObject({ status: "done", found: 3, captured: 3 });
    expect(w.api.some((call) => call.path.endsWith("/companies/acme/jobs/scan") && call.body.jobs.length === 3)).toBe(true);
    expect(w.starts[1]).toEqual({ includeCompany: false, includePeople: true, resume: true });
    expect(w.item()).toMatchObject({ step: "people", status: "running" });
    // Employees: a batch is reviewed and saved.
    await w.review("acme", [person(1), person(2)]);
    await handleCaptureMessage({ type: "capture-send" }, panel);
    await settle();
    expect(w.item().stepDetail.people).toMatchObject({ status: "done", captured: 2 });
    // Step 4 asked the workspace what it holds, and only then finished.
    expect(w.api.some((call) => call.path.endsWith("/capture/queue/acme/verify"))).toBe(true);
    expect(w.item()).toMatchObject({ step: "verify", status: "done" });
    expect(w.item().stepDetail.verify).toMatchObject({ status: "done", found: 3, captured: 2 });
    expect(w.queue()).toMatchObject({ active: false });
    // The workspace was told each step as it happened, ending completed with every step done.
    const steps = w.reported().filter((entry) => entry.companyPublicId === "acme").map((entry) => entry.step);
    expect(steps).toEqual(expect.arrayContaining(["company", "jobs", "people", "verify"]));
    expect(steps.indexOf("jobs")).toBeGreaterThan(steps.indexOf("company"));
    expect(steps.lastIndexOf("verify")).toBeGreaterThan(steps.lastIndexOf("people"));
    expect(w.reported().at(-1)).toMatchObject({ status: "completed", step: "verify", stepDetail: { company: { status: "done" }, jobs: { status: "done" }, people: { status: "done" }, verify: { status: "done" } } });
  });

  it("is not completed when the workspace does not hold what was reported saved", async () => {
    const w = world({ verify: () => ({ companyCaptured: true, jobs: 0, people: 0 }) });
    await start();
    await settle();
    await w.review("acme");
    await handleCaptureMessage({ type: "capture-send" }, panel);
    await settle();
    await w.review("acme", [person(1)]);
    await handleCaptureMessage({ type: "capture-send" }, panel);
    await settle();
    expect(w.item()).toMatchObject({ status: "failed" });
    expect(w.item().stepDetail.verify.status).toBe("failed");
    expect(w.item().error).toMatch(/Job roles were reported saved but the workspace holds none/);
    expect(w.reported().at(-1)).toMatchObject({ status: "failed" });
  });

  it("goes on to the employees when job roles cannot be read, and finishes as partial instead of complete", async () => {
    const w = world({ jobsRoute: () => ({ ok: true, state: "restricted", jobs: [], complete: false, notes: ["LinkedIn restricted this page."] }) });
    await start();
    await settle();
    await w.review("acme");
    await handleCaptureMessage({ type: "capture-send" }, panel);
    await settle();
    expect(w.item().stepDetail.jobs.status).toBe("failed");
    expect(w.item()).toMatchObject({ step: "people" });
    await w.review("acme", [person(1)]);
    await handleCaptureMessage({ type: "capture-send" }, panel);
    await settle();
    expect(w.item()).toMatchObject({ status: "done", step: "verify" });
    expect(w.reported().at(-1)).toMatchObject({ status: "completed", stepDetail: { jobs: { status: "failed" }, people: { status: "done" } } });
  });

  it("retries a failed job step by itself, without repeating the company profile, and resumes the scan", async () => {
    let allow = false;
    const w = world({ jobsRoute: (url, message) => (allow ? (message.type === "COLLECT_JOB_DETAIL" ? { ok: true, state: "ok", detail: { description: "A full description of the role with enough words." } } : { ok: true, state: "ok", jobs: [job(1)], complete: true, hasNext: false, memberId: "1441", notes: [] }) : { ok: true, state: "restricted", jobs: [], complete: false, notes: ["restricted"] }) });
    await start();
    await settle();
    await w.review("acme");
    await handleCaptureMessage({ type: "capture-send" }, panel);
    await settle();
    await w.review("acme", [person(1)]);
    await handleCaptureMessage({ type: "capture-send" }, panel);
    await settle();
    expect(w.item().stepDetail.jobs.status).toBe("failed");
    // The people step failing makes the company retryable; retry resumes at the first step that is not done.
    expect(nextUnfinishedStep(w.item())).toBe("jobs");
    allow = true;
    w.item().status = "failed";
    const profileSaves = w.api.filter((call) => call.path.includes("/ingest/company")).length;
    await handleCaptureMessage({ type: "capture-queue-retry", companyPublicId: "acme" }, panel);
    await settle();
    expect(w.item().stepDetail.jobs.status).toBe("done");
    expect(w.api.filter((call) => call.path.includes("/ingest/company")).length).toBe(profileSaves);
  });

  it("people-only queues are still available and do not run the company or job steps", async () => {
    const w = world();
    await start({ workflow: false });
    await settle();
    expect(w.starts[0]).toEqual({ includeCompany: false, includePeople: true, resume: true });
    expect(w.item().workflow).toBeUndefined();
    expect(w.reported().every((entry) => entry.step === undefined)).toBe(true);
  });
});

describe("workflow helpers", () => {
  it("finds the first unfinished step, treating partial and failed as unfinished", () => {
    expect(nextUnfinishedStep({})).toBe("company");
    expect(nextUnfinishedStep({ stepDetail: { company: { status: "done" }, jobs: { status: "skipped" } } })).toBe("people");
    expect(nextUnfinishedStep({ stepDetail: { company: { status: "done" }, jobs: { status: "partial" } } })).toBe("jobs");
    expect(nextUnfinishedStep({ stepDetail: { company: { status: "done" }, jobs: { status: "done" }, people: { status: "done" }, verify: { status: "done" } } })).toBe("verify");
  });

  it("maps a job scan to an honest step result", () => {
    expect(jobsStepFromScan({ ok: true, saved: true, scan: { status: "completed_verified", jobsFound: 12, counts: { skipped: 2 } } })).toMatchObject({ status: "done", found: 12, captured: 10 });
    expect(jobsStepFromScan({ ok: true, saved: true, scan: { status: "not_found", jobsFound: 0 } })).toMatchObject({ status: "done", note: expect.stringMatching(/No open roles/) });
    expect(jobsStepFromScan({ ok: true, saved: true, scan: { status: "partial", jobsFound: 5, counts: { remaining: 40 } } })).toMatchObject({ status: "partial", note: expect.stringMatching(/40 remaining/) });
    expect(jobsStepFromScan({ ok: false, pending: true, scan: { status: "completed_verified", jobsFound: 4 } })).toMatchObject({ status: "partial", note: expect.stringMatching(/not confirmed/) });
    expect(jobsStepFromScan({ ok: true, scan: { status: "failed", jobsFound: 0, error: "LinkedIn restricted this page." } })).toMatchObject({ status: "failed", error: "LinkedIn restricted this page." });
    expect(jobsStepFromScan({ ok: false, error: "A job scan is already running." })).toMatchObject({ status: "failed" });
  });

  it("reports only known, bounded step fields", () => {
    expect(reportableSteps({ companyPublicId: "a" })).toEqual({});
    const reported = reportableSteps({ workflow: true, step: "people", stepDetail: { company: { status: "done", secret: "x" }, jobs: { status: "partial", found: -3, captured: 4.6, error: "e".repeat(900) }, bogus: { status: "done" } } });
    expect(reported.step).toBe("people");
    expect(Object.keys(reported.stepDetail)).toEqual(["company", "jobs"]);
    expect(reported.stepDetail.company).toEqual({ status: "done" });
    expect(reported.stepDetail.jobs).toMatchObject({ found: 0, captured: 5 });
    expect(reported.stepDetail.jobs.error).toHaveLength(500);
  });
});

describe("a retry from the workspace does not repeat what is done", () => {
  it("starts a company at its first unfinished step when the workspace already holds the earlier ones", async () => {
    const w = world();
    await start({ companies: [{ companyPublicId: "acme", name: "Acme", stepDetail: { company: { status: "done" }, jobs: { status: "done", found: 3 } } }] });
    await settle();
    // Straight to the employees: the company page and the job roles are not read again.
    expect(w.starts).toEqual([{ includeCompany: false, includePeople: true, resume: true }]);
    expect(w.item()).toMatchObject({ step: "people", stepDetail: { company: { status: "done" }, jobs: { status: "done", found: 3 } } });
  });

  it("re-runs a step the workspace holds as failed or partial", async () => {
    const w = world();
    await start({ companies: [{ companyPublicId: "acme", name: "Acme", stepDetail: { company: { status: "done" }, jobs: { status: "partial", found: 40 } } }] });
    await settle();
    expect(w.item().stepDetail.jobs.status).toBe("done");
    expect(w.starts.length).toBe(1);
  });
});
