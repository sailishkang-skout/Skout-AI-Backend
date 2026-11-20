import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CAPTURE_DRAFT_KEY, RUN_QUEUE_KEY, __test, buildCapturePayload, handleCaptureMessage, timing } from "../capture-background.js";

timing.delay = () => Promise.resolve();
const previousChrome = globalThis.chrome;
afterEach(() => { globalThis.chrome = previousChrome; });

function browser() {
  const store = {};
  globalThis.chrome = {
    runtime: { id: "test-extension" },
    tabs: {
      async create() { return { id: 50 }; },
      async get(id) { return { id, url: "https://www.linkedin.com/company/alpha/", status: "complete" }; },
      async update() {}, async remove() {},
      async sendMessage() { return { ok: true, kind: "company" }; },
    },
    storage: { local: {
      async get(keys) { return keys === null ? { ...store } : Object.fromEntries([].concat(keys).map((key) => [key, store[key]])); },
      async set(values) { Object.assign(store, values); },
      async remove(keys) { for (const key of [].concat(keys)) delete store[key]; },
    } },
  };
  return store;
}
const timeout = () => Object.assign(new Error("The API at https://x didn't respond in time."), { transient: true, timedOut: true });

describe("status check that survives a slow reply", () => {
  beforeEach(() => { browser(); __test.resetStatusCache(); });

  it("carries on with a recent confirmation when one status check fails", async () => {
    __test.deps.skoutFetch = async () => ({ enabled: true });
    expect(await __test.captureBlockDetail()).toEqual({});
    __test.deps.skoutFetch = async () => { throw timeout(); };
    expect(await __test.captureBlockDetail()).toEqual({});
  });

  it("calls an unconfirmable status temporary, not a decision", async () => {
    __test.deps.skoutFetch = async () => { throw timeout(); };
    const block = await __test.captureBlockDetail();
    expect(block.transient).toBe(true);
    expect(block.reason).toMatch(/could not be confirmed/);
  });

  it("never carries on past the kill switch", async () => {
    __test.deps.skoutFetch = async () => ({ enabled: true });
    await __test.captureBlockDetail();
    __test.deps.skoutFetch = async () => ({ enabled: false, disabledReason: "Paused by admin" });
    expect(await __test.captureBlockDetail()).toEqual({ reason: "Capture is disabled for this workspace: Paused by admin" });
    // The cached confirmation is gone: a later failed check is unconfirmed again.
    __test.deps.skoutFetch = async () => { throw timeout(); };
    expect((await __test.captureBlockDetail()).transient).toBe(true);
  });

  it("keeps a queue waiting (not stopped) while Skout cannot be reached", async () => {
    const store = browser();
    __test.deps.skoutFetch = async () => { throw timeout(); };
    const delay = timing.delay;
    timing.delay = () => new Promise(() => {}); // the retry is scheduled, not run yet
    try {
      await handleCaptureMessage({ type: "capture-queue-start", companies: [{ companyPublicId: "alpha", name: "Alpha" }] }, {});
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(store[RUN_QUEUE_KEY]).toMatchObject({ active: true, statusRetries: 1 });
      expect(store[RUN_QUEUE_KEY].note).toMatch(/Waiting for Skout/);
      expect(store[RUN_QUEUE_KEY].items[0].status).toBe("pending");
    } finally { timing.delay = delay; }
  });
});

describe("saving without saving twice", () => {
  const draft = (extra = {}) => ({ kind: "company", data: { publicId: "alpha", name: "Alpha", peopleProfiles: [] }, capturedAt: "2026-11-20T10:00:00.000Z", clientRunId: "11111111-2222-4333-8444-555555555555", meta: {}, ...extra });
  const saved = { run: { id: "r", status: "completed", terminal: true }, created: 3, merged: 1, rejected: 0 };

  it("gives every reviewed batch a stable id and sends it", async () => {
    const store = browser();
    __test.deps.skoutFetch = async () => ({ enabled: true });
    await handleCaptureMessage({ type: "SKOUT_CAPTURE_REVIEW", kind: "company", sourceUrl: "https://www.linkedin.com/company/alpha/", data: { publicId: "alpha", name: "Alpha", peopleProfiles: [{ publicId: "p1", sourceUrl: "https://www.linkedin.com/in/p1/", fullName: "P One" }] } }, { tab: { id: 50 } });
    expect(store[CAPTURE_DRAFT_KEY].clientRunId).toMatch(/^[0-9a-f-]{36}$/);
    expect(buildCapturePayload(store[CAPTURE_DRAFT_KEY], store[CAPTURE_DRAFT_KEY].data).clientRunId).toBe(store[CAPTURE_DRAFT_KEY].clientRunId);
  });

  it("sends a save again after a timeout with the same id, and succeeds", async () => {
    const store = browser();
    store[CAPTURE_DRAFT_KEY] = draft();
    const bodies = [];
    __test.deps.skoutFetch = async (path, options) => {
      bodies.push(JSON.parse(options.body).clientRunId);
      if (bodies.length < 3) throw timeout();
      return saved;
    };
    const result = await handleCaptureMessage({ type: "capture-send" }, {});
    expect(result).toMatchObject({ ok: true, counts: { created: 3, merged: 1 } });
    expect(bodies).toEqual(Array(3).fill("11111111-2222-4333-8444-555555555555"));
    expect(store[CAPTURE_DRAFT_KEY]).toBeUndefined();
  });

  it("keeps the reviewed batch and says it is unconfirmed, not failed, when every attempt times out", async () => {
    const store = browser();
    store[CAPTURE_DRAFT_KEY] = draft();
    __test.deps.skoutFetch = async () => { throw timeout(); };
    const result = await handleCaptureMessage({ type: "capture-send" }, {});
    expect(result).toMatchObject({ ok: false, pending: true, code: "save_unconfirmed" });
    expect(result.error).toMatch(/will not be saved twice/);
    expect(store[CAPTURE_DRAFT_KEY]).toBeTruthy();
  });

  it("still reports a real refusal as a failure, without retrying", async () => {
    const store = browser();
    store[CAPTURE_DRAFT_KEY] = draft();
    let calls = 0;
    __test.deps.skoutFetch = async () => { calls++; throw Object.assign(new Error("Daily capture limit reached"), { body: { code: "daily_limit_reached" } }); };
    const result = await handleCaptureMessage({ type: "capture-send" }, {});
    expect(result).toMatchObject({ ok: false, code: "daily_limit_reached" });
    expect(result.pending).toBeUndefined();
    expect(calls).toBe(1);
  });
});
