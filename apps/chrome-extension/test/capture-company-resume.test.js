import { beforeEach, describe, expect, it } from "vitest";
import {
  CAPTURE_DRAFT_KEY,
  CAPTURE_HALT_KEY,
  CAPTURE_PROGRESS_KEY,
  __test,
  buildCapturePayload,
  handleCaptureMessage,
  timing,
} from "../capture-background.js";

const companyUrl = "https://www.linkedin.com/company/example/people/";
const searchUrl = "https://www.linkedin.com/search/results/people/?currentCompany=%5B%22123%22%5D";
const companyTab = { tab: { id: 7 }, frameId: 0, url: companyUrl };
const sidePanel = {};
const stateKey = "company-people-capture:example";

timing.delay = () => Promise.resolve();

/** A company-filtered people search in a temporary tab, ported from the prototype's harness. */
function harness(totalPages, { failAdvanceAt, profilesPerPage = 1, api } = {}) {
  const storage = {};
  const tabs = new Map();
  let nextTab = 100;
  let failed = false;
  const pageUrl = (page) => `${searchUrl}&page=${page}`;
  const requests = [];
  globalThis.chrome = {
    runtime: { id: "test-extension" },
    tabs: {
      async create({ url }) {
        const id = nextTab++;
        tabs.set(id, { page: Number(new URL(url).searchParams.get("page") || 1) });
        return { id };
      },
      async remove(id) {
        tabs.delete(id);
      },
      async sendMessage(id, request) {
        const tab = tabs.get(id);
        if (!tab) throw new Error("Tab closed");
        if (request.type === "COMPANY_PEOPLE_READER_READY") return { ok: true, url: pageUrl(tab.page), page: tab.page };
        if (request.type === "COLLECT_COMPANY_PEOPLE_PAGE") {
          return {
            ok: true,
            url: pageUrl(tab.page),
            page: tab.page,
            hasNext: tab.page < totalPages,
            peopleProfiles: Array.from({ length: profilesPerPage }, (_, index) => ({
              publicId: `person-${tab.page}-${index}`,
              sourceUrl: `https://www.linkedin.com/in/person-${tab.page}-${index}/`,
              fullName: `Person ${tab.page}-${index}`,
            })),
          };
        }
        if (request.type === "ADVANCE_COMPANY_PEOPLE_PAGE") {
          if (!failed && tab.page === failAdvanceAt) {
            failed = true;
            throw new Error("Browser interrupted");
          }
          tab.page++;
          return { ok: true };
        }
        if (request.type === "SKOUT_CAPTURE_STOP") return { ok: true };
        throw new Error("Unexpected message");
      },
    },
    storage: {
      local: {
        async get(keys) {
          return Object.fromEntries([].concat(keys).map((key) => [key, storage[key]]));
        },
        async set(values) {
          Object.assign(storage, values);
        },
        async remove(keys) {
          for (const key of [].concat(keys)) delete storage[key];
        },
      },
    },
  };
  __test.deps.skoutFetch = async (path, options) => {
    requests.push({ path, options });
    if (api) return api(path, options, requests);
    return { enabled: true, caps: { dailyLeadLimit: 1000 }, usage: { remainingToday: 1000 } };
  };
  const read = (expectedAssociatedMembers) =>
    handleCaptureMessage({ type: "READ_COMPANY_PEOPLE_SEARCH", companyId: "example", url: searchUrl, expectedAssociatedMembers }, companyTab);
  const commit = (token) => __test.commitCompanyPeopleCapture({ companyId: "example", token });
  return { storage, read, commit, requests, tabs };
}

describe("company people discovery", () => {
  it("reviews 10-page batches and commits a cursor until the final visible page", async () => {
    const { read, commit, storage } = harness(43);
    const ids = [];
    for (const expected of [10, 10, 10, 10, 3]) {
      const result = await read(10);
      expect(result.ok).toBe(true);
      expect(result.peopleProfiles).toHaveLength(expected);
      ids.push(...result.peopleProfiles.map((profile) => profile.publicId));
      expect((await commit(result.checkpointToken)).ok).toBe(true);
    }
    expect(new Set(ids).size).toBe(43);
    expect(storage[stateKey].committed).toMatchObject({ complete: true, pagesRead: 43 });
  });

  it("re-reads an interrupted page without losing the saved draft candidates", async () => {
    const { read, storage } = harness(22, { failAdvanceAt: 5 });
    const interrupted = await read(1000);
    expect(interrupted.ok).toBe(false);
    expect(storage[stateKey].draft.profiles).toHaveLength(5);
    const resumed = await read(1000);
    expect(resumed.ok).toBe(true);
    expect(resumed.peopleProfiles).toHaveLength(10);
    expect(new Set(resumed.peopleProfiles.map((profile) => profile.publicId)).size).toBe(10);
  });

  it("keeps the draft and the committed cursor when a review is not saved", async () => {
    const { read, storage } = harness(25);
    const first = await read(25);
    expect(first.peopleProfiles).toHaveLength(10);
    expect(storage[stateKey].committed).toBeUndefined();
    const again = await read(25);
    expect(again.checkpointToken).toBe(first.checkpointToken);
    expect(again.peopleProfiles.map((profile) => profile.publicId)).toEqual(first.peopleProfiles.map((profile) => profile.publicId));
  });

  it("makes one repeat pass for a member-count gap and stops when it finds nothing new", async () => {
    const { read, commit, storage } = harness(2, { profilesPerPage: 10 });
    const first = await read(25);
    const firstCommit = await commit(first.checkpointToken);
    expect(firstCommit.data).toMatchObject({ retryScheduled: true, complete: false });
    const retry = await read(25);
    const retryCommit = await commit(retry.checkpointToken);
    expect(retryCommit.data).toMatchObject({ complete: true, stopReason: "no new profiles in the repeat pass", distinctCandidates: 20 });
    expect(storage[stateKey].committed.pagesRead).toBe(4);
  });

  it("ends a batch before it could exceed 250 leads", async () => {
    const { read } = harness(40, { profilesPerPage: 30 });
    const result = await read(2000);
    expect(result.ok).toBe(true);
    expect(result.peopleProfiles).toHaveLength(240);
    expect(result.complete).toBe(false);
  });

  it("stops at the next page when the workspace kill switch is turned on, keeping the draft", async () => {
    let statusChecks = 0;
    const { read, storage } = harness(20, {
      api: () => ({ enabled: ++statusChecks <= 3, disabledReason: "Paused by admin" }),
    });
    const result = await read(100);
    expect(result).toMatchObject({ ok: false, error: "Capture is disabled for this workspace: Paused by admin" });
    expect(storage[stateKey].draft.pagesRead).toBe(3);
  });
});

describe("LinkedIn warning auto-stop", () => {
  beforeEach(() => harness(5));

  it("ignores a warning when no capture is running", async () => {
    const { storage } = harness(5);
    const result = await handleCaptureMessage({ type: "SKOUT_CAPTURE_RESTRICTION", reason: "LinkedIn reported unusual activity." }, companyTab);
    expect(result.halted).toBe(false);
    expect(storage[CAPTURE_HALT_KEY]).toBeUndefined();
  });

  it("halts the running capture and refuses further page reads until acknowledged", async () => {
    const { storage, read } = harness(5);
    await handleCaptureMessage({ type: "SKOUT_CAPTURE_PROGRESS", kind: "company", text: "Reading…", active: true }, companyTab);
    const halted = await handleCaptureMessage({ type: "SKOUT_CAPTURE_RESTRICTION", reason: "LinkedIn reported unusual activity.", url: companyUrl }, companyTab);
    expect(halted.halted).toBe(true);
    expect(storage[CAPTURE_HALT_KEY].reason).toBe("LinkedIn reported unusual activity.");
    expect(storage[CAPTURE_PROGRESS_KEY]).toMatchObject({ active: false, isError: true });

    const blocked = await read(10);
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toMatch(/Capture is stopped: LinkedIn reported unusual activity/);
    const start = await handleCaptureMessage({ type: "capture-start", tabId: 7, kind: "company" }, sidePanel);
    expect(start.ok).toBe(false);

    await handleCaptureMessage({ type: "capture-ack-halt" }, sidePanel);
    expect((await read(10)).ok).toBe(true);
  });

  it("does not let a LinkedIn tab drive side-panel actions", () => {
    expect(handleCaptureMessage({ type: "capture-send" }, companyTab)).toBeUndefined();
    expect(handleCaptureMessage({ type: "capture-ack-halt" }, companyTab)).toBeUndefined();
  });
});

describe("saving a reviewed capture", () => {
  const review = (data, kind = "sales") =>
    handleCaptureMessage({ type: "SKOUT_CAPTURE_REVIEW", kind, data, notes: ["note"], sourceUrl: "https://www.linkedin.com/sales/search/people", capturedAt: "2026-10-08T10:00:00.000Z" }, companyTab);
  const lead = (index) => ({
    publicId: `sales-lead:id${index}`,
    sourceUrl: `https://www.linkedin.com/sales/lead/id${index},NAME_SEARCH,x`,
    fullName: `Person ${index}`,
    relationshipContext: { salesNavigatorLeadUrl: `https://www.linkedin.com/sales/lead/id${index},NAME_SEARCH,x`, degree: undefined },
  });

  it("strips review-only fields and bounds the request", () => {
    const draft = { kind: "sales", capturedAt: "2026-10-08T10:00:00.000Z" };
    const payload = buildCapturePayload(draft, { sourceUrl: "https://www.linkedin.com/sales/search/people", pagesRead: 14, peopleProfiles: [lead(1)], _salesCapture: { stopped: false } });
    expect(payload).toEqual({ sourceUrl: "https://www.linkedin.com/sales/search/people", filters: undefined, pagesRead: 10, resultCount: undefined, peopleProfiles: [lead(1)], capturedAt: draft.capturedAt });
    expect(() => buildCapturePayload(draft, { peopleProfiles: Array.from({ length: 251 }, (_, index) => lead(index)) })).toThrow(/at most 250 leads/);
  });

  it("reports success only after the API records a completed capture run", async () => {
    const run = { id: "run-1", status: "completed", terminal: true };
    const { storage, requests } = harness(1, {
      api: (path) => (path.endsWith("/ingest/sales-search") ? { run, received: 2, created: 2, merged: 0, rejected: 0 } : { enabled: true }),
    });
    await review({ sourceUrl: "https://www.linkedin.com/sales/search/people", pagesRead: 1, peopleProfiles: [lead(1), lead(2)], _salesCapture: {} });
    expect(storage[CAPTURE_DRAFT_KEY].data._salesCapture).toBeUndefined();
    // The reviewer removed one lead before saving.
    const result = await handleCaptureMessage({ type: "capture-send", data: { ...storage[CAPTURE_DRAFT_KEY].data, peopleProfiles: [lead(1)] } }, sidePanel);
    expect(result).toMatchObject({ ok: true, run, counts: { created: 2 } });
    expect(JSON.parse(requests.at(-1).options.body).peopleProfiles).toHaveLength(1);
    expect(storage[CAPTURE_DRAFT_KEY]).toBeUndefined();
  });

  it("surfaces a run that did not complete and keeps the draft for another attempt", async () => {
    const { storage } = harness(1, { api: () => ({ run: { id: "run-2", status: "running", terminal: false } }) });
    await review({ sourceUrl: "https://www.linkedin.com/sales/search/people", peopleProfiles: [lead(1)] });
    const result = await handleCaptureMessage({ type: "capture-send" }, sidePanel);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not recorded as completed \(status: running\)/);
    expect(storage[CAPTURE_DRAFT_KEY]).toBeDefined();
  });

  it("surfaces the kill switch and validation failures from the API", async () => {
    const failure = Object.assign(new Error("LinkedIn warning under review"), {
      status: 403,
      body: { code: "capture_disabled", run: { id: "run-3", status: "halted", terminal: true } },
    });
    const { storage } = harness(1, {
      api: () => {
        throw failure;
      },
    });
    await review({ sourceUrl: "https://www.linkedin.com/sales/search/people", peopleProfiles: [lead(1)] });
    const result = await handleCaptureMessage({ type: "capture-send" }, sidePanel);
    expect(result).toMatchObject({ ok: false, error: "LinkedIn warning under review", code: "capture_disabled", run: { status: "halted" } });
    expect(storage[CAPTURE_DRAFT_KEY]).toBeDefined();
  });
});

describe("validation failures from the API", () => {
  it("names the fields the API rejected", async () => {
    const failure = Object.assign(new Error("The captured data did not pass validation."), {
      status: 422,
      body: { error: "VALIDATION_FAILED", details: { fields: [{ path: "peopleProfiles.0.publicId", code: "custom", message: "Public LinkedIn URL does not match person ID." }] } },
    });
    harness(1, {
      api: () => {
        throw failure;
      },
    });
    await handleCaptureMessage(
      { type: "SKOUT_CAPTURE_REVIEW", kind: "sales", data: { sourceUrl: "https://www.linkedin.com/sales/search/people", peopleProfiles: [] }, sourceUrl: "https://www.linkedin.com/sales/search/people" },
      companyTab
    );
    const result = await handleCaptureMessage({ type: "capture-send" }, sidePanel);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("The captured data did not pass validation. · peopleProfiles.0.publicId: Public LinkedIn URL does not match person ID.");
    expect(result.code).toBe("VALIDATION_FAILED");
  });
});
