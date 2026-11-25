import { afterEach, describe, expect, it } from "vitest";
import { CAPTURE_DRAFT_KEY, __test, draftCompleteness, draftValidation, handleCaptureMessage, timing } from "../capture-background.js";
import { captureCompletenessText } from "../capture-panel.js";

timing.delay = () => Promise.resolve();
const previousChrome = globalThis.chrome;
afterEach(() => { globalThis.chrome = previousChrome; });

const partialVerification = { status: "partial", passes: 2, sections: { skills: { found: 12, expected: 27, state: "incomplete" }, education: { found: 2, state: "complete" }, experience: { found: 0, state: "none" } }, missing: ["Phone"], notes: [] };

describe("a capture is only as complete as it was verified to be", () => {
  it("refuses a record with no name or no LinkedIn id, saying why in words", () => {
    expect(draftValidation({ kind: "person", data: { publicId: "jo" } })).toEqual(["The person's name was not found on the page."]);
    expect(draftValidation({ kind: "person", data: { fullName: "Jo" } })).toEqual(["The profile's LinkedIn id was not found."]);
    expect(draftValidation({ kind: "company", data: {} })).toHaveLength(2);
    expect(draftValidation({ kind: "company", data: { name: "Acme", publicId: "acme" } })).toEqual([]);
    expect(draftValidation({ kind: "person", data: { fullName: "  ", publicId: "jo" } })).toHaveLength(1);
  });

  it("is complete only when the verification passed every section; otherwise partial, with what is missing", () => {
    expect(draftCompleteness({ data: {} })).toMatchObject({ level: "unverified" });
    expect(draftCompleteness({ data: { verification: { status: "verified", passes: 2, sections: { skills: { found: 27, expected: 27, state: "complete" } } } } })).toMatchObject({ level: "complete" });
    expect(draftCompleteness({ data: { verification: partialVerification } })).toEqual({ level: "partial", status: "partial", missing: ["Phone"], incomplete: ["skills (12 of 27)"] });
    // A "verified" status with an incomplete section is not complete.
    expect(draftCompleteness({ data: { verification: { status: "verified", passes: 2, sections: { skills: { found: 3, expected: 9, state: "incomplete" } } } } }).level).toBe("partial");
  });

  it("tells the user a partial capture is partial", () => {
    expect(captureCompletenessText({ level: "complete" })).toMatch(/Complete/);
    expect(captureCompletenessText({ level: "partial", incomplete: ["skills (12 of 27)"], missing: ["Phone"] })).toBe(" PARTIAL capture (skills (12 of 27) is incomplete; not found: Phone). The data found is saved; open the page again and recapture to complete it.");
    expect(captureCompletenessText({ level: "unverified" })).toBe("");
    expect(captureCompletenessText(undefined)).toBe("");
  });

  function browser(draft, api) {
    const store = { [CAPTURE_DRAFT_KEY]: draft };
    globalThis.chrome = { runtime: { id: "t" }, storage: { local: {
      async get(keys) { return Object.fromEntries([].concat(keys).map((key) => [key, store[key]])); },
      async set(values) { Object.assign(store, values); },
      async remove(keys) { for (const key of [].concat(keys)) delete store[key]; },
    } } };
    __test.deps.skoutFetch = api;
    return store;
  }

  it("does not send an empty shell, and keeps the draft so it can be fixed", async () => {
    const calls = [];
    const store = browser({ kind: "person", data: { publicId: "jo" }, clientRunId: "run-1" }, async (path) => { calls.push(path); return {}; });
    const result = await handleCaptureMessage({ type: "capture-send" }, {});
    expect(result).toMatchObject({ ok: false, code: "invalid_capture", error: expect.stringMatching(/name was not found/) });
    expect(calls).toEqual([]);
    expect(store[CAPTURE_DRAFT_KEY]).toBeTruthy();
  });

  it("saves a partial person and reports it as partial, not as a plain success", async () => {
    browser({ kind: "person", data: { publicId: "jo", fullName: "Jo", verification: partialVerification }, clientRunId: "run-2" },
      async () => ({ run: { id: "r", status: "completed", terminal: true }, received: 1, created: 1, merged: 0, rejected: 0 }));
    const result = await handleCaptureMessage({ type: "capture-send" }, {});
    expect(result).toMatchObject({ ok: true, completeness: { level: "partial", missing: ["Phone"] } });
  });
});
