import { afterEach, describe, expect, it } from "vitest";
import {
  CAPTURE_DRAFT_KEY,
  CAPTURE_PROGRESS_KEY,
  MAX_ITEM_ATTEMPTS,
  RUN_QUEUE_KEY,
  __test,
  handleCaptureMessage,
  isRecoverableFailure,
  timing,
} from "../capture-background.js";

timing.delay = () => Promise.resolve();
const previousChrome = globalThis.chrome;
afterEach(() => { globalThis.chrome = previousChrome; });
const sidePanel = {};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async (times = 12) => { for (let i = 0; i < times; i++) await tick(); };

function browser({ startReply = { ok: true, kind: "company" } } = {}) {
  const store = {};
  const reported = [];
  let reply = startReply;
  globalThis.chrome = {
    runtime: { id: "test-extension" },
    tabs: {
      async create() { return { id: 50 }; },
      async get(id) { return { id, url: "https://www.linkedin.com/company/alpha/", status: "complete" }; },
      async update() {},
      async remove() {},
      async sendMessage(_id, message) { return message.type === "SKOUT_CAPTURE_START" ? reply : { ok: true }; },
    },
    storage: { local: {
      async get(keys) { return keys === null ? { ...store } : Object.fromEntries([].concat(keys).map((key) => [key, store[key]])); },
      async set(values) { Object.assign(store, values); },
      async remove(keys) { for (const key of [].concat(keys)) delete store[key]; },
    } },
  };
  __test.deps.skoutFetch = async (path, options = {}) => {
    if (path.endsWith("/capture/queue/sync")) { reported.push(JSON.parse(options.body).items); return { updated: 1, cancelled: [] }; }
    return { enabled: true, caps: { dailyLeadLimit: 1000 }, usage: { remainingToday: 1000 } };
  };
  __test.resetStatusCache();
  return { store, reported, setReply: (next) => { reply = next; } };
}
const queueOf = (store) => store[RUN_QUEUE_KEY];
const seed = (store, items, at = Date.now() - 10 * 60_000, active = true) => { store[RUN_QUEUE_KEY] = { active, tabId: 50, items, at }; };

describe("a stuck queue recovers", () => {
  it("puts a company that says it is running, with nothing reading it, back in the queue", async () => {
    const { store } = browser();
    seed(store, [{ companyPublicId: "alpha", name: "ALPHA", status: "running" }], Date.now() - 10 * 60_000, false);
    expect(await __test.recoverStuckRunQueue()).toBe(true);
    expect(queueOf(store).items[0]).toMatchObject({ status: "pending", attempts: 1 });
    expect(queueOf(store).note).toMatch(/stopped reporting/);
  });

  it("fails it with the reason once it has been put back too many times, so it cannot loop for ever", async () => {
    const { store } = browser();
    seed(store, [{ companyPublicId: "alpha", name: "ALPHA", status: "running", attempts: MAX_ITEM_ATTEMPTS }], Date.now() - 10 * 60_000, false);
    await __test.recoverStuckRunQueue();
    expect(queueOf(store).items[0]).toMatchObject({ status: "failed" });
    expect(queueOf(store).items[0].error).toMatch(/did not recover after 2 tries/);
  });

  it("leaves alone a reader that is alive, a just-started company, and a batch waiting for review", async () => {
    const { store } = browser();
    seed(store, [{ companyPublicId: "alpha", name: "ALPHA", status: "running" }], Date.now() - 10 * 60_000, false);
    store[CAPTURE_PROGRESS_KEY] = { active: true, at: Date.now(), kind: "company" };
    expect(await __test.recoverStuckRunQueue()).toBe(false);
    delete store[CAPTURE_PROGRESS_KEY];
    seed(store, [{ companyPublicId: "alpha", name: "ALPHA", status: "running" }], Date.now() - 5_000, false);
    expect(await __test.recoverStuckRunQueue()).toBe(false);
    seed(store, [{ companyPublicId: "alpha", name: "ALPHA", status: "review" }]);
    store[CAPTURE_DRAFT_KEY] = { kind: "company", data: {} };
    expect(await __test.recoverStuckRunQueue()).toBe(false);
    expect(queueOf(store).items[0].status).toBe("review");
    // The same review without its saved batch cannot be completed: it is recovered.
    delete store[CAPTURE_DRAFT_KEY];
    expect(await __test.recoverStuckRunQueue()).toBe(true);
    expect(queueOf(store).items[0].status).toBe("pending");
  });
});

describe("failures are retried when they can pass, and reported honestly", () => {
  it("tells recoverable failures from ones that need a person", () => {
    for (const text of ["The company page took too long to load.", "Skout didn't respond in time.", "Receiving end does not exist", "Failed to fetch", "Request failed (503)"]) expect(isRecoverableFailure(text)).toBe(true);
    for (const text of ["You have reached the daily capture limit.", "LinkedIn showed a warning. Capture is paused.", "Not signed in to Skout.", "Not a LinkedIn company.", ""]) expect(isRecoverableFailure(text)).toBe(false);
  });

  it("tries a slow company again, then fails it with the reason, and the workspace sees the retries", async () => {
    const { store, reported } = browser({ startReply: { ok: false, error: "The company page took too long to load." } });
    await handleCaptureMessage({ type: "capture-queue-start", companies: [{ companyPublicId: "alpha", name: "ALPHA" }] }, sidePanel);
    await settle();
    const item = queueOf(store).items[0];
    expect(item).toMatchObject({ status: "failed", attempts: MAX_ITEM_ATTEMPTS });
    expect(item.error).toMatch(/took too long/);
    const sent = reported.flat().filter((entry) => entry.companyPublicId === "alpha");
    expect(sent.some((entry) => entry.status === "queued" && entry.attempts === 1)).toBe(true);
    expect(sent.at(-1)).toMatchObject({ status: "failed", error: expect.stringMatching(/took too long/) });
  });

  it("fails at once, without retrying, when a person has to act", async () => {
    const { store } = browser({ startReply: { ok: false, error: "Open the company page first." } });
    await handleCaptureMessage({ type: "capture-queue-start", companies: [{ companyPublicId: "alpha", name: "ALPHA" }] }, sidePanel);
    await settle();
    expect(queueOf(store).items[0]).toMatchObject({ status: "failed" });
    expect(queueOf(store).items[0].attempts).toBeUndefined();
  });

  it("retries a failed company from the side panel, from the start of its attempts", async () => {
    const { store, setReply } = browser({ startReply: { ok: false, error: "Open the company page first." } });
    await handleCaptureMessage({ type: "capture-queue-start", companies: [{ companyPublicId: "alpha", name: "ALPHA" }] }, sidePanel);
    await settle();
    expect(queueOf(store).items[0].status).toBe("failed");
    setReply({ ok: true, kind: "company" });
    expect((await handleCaptureMessage({ type: "capture-queue-retry", companyPublicId: "alpha" }, sidePanel)).ok).toBe(true);
    await settle();
    expect(queueOf(store).items[0]).toMatchObject({ status: "running", attempts: 0 });
    expect(queueOf(store).items[0].error).toBeUndefined();
    // Only a failed or skipped company can be retried, and only one that is in the queue.
    expect((await handleCaptureMessage({ type: "capture-queue-retry", companyPublicId: "alpha" }, sidePanel)).ok).toBe(false);
    expect((await handleCaptureMessage({ type: "capture-queue-retry", companyPublicId: "nobody" }, sidePanel)).ok).toBe(false);
  });
});
