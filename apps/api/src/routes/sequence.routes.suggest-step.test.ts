import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@skout/auth";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";

const { suggestStepForSequence } = vi.hoisted(() => ({ suggestStepForSequence: vi.fn() }));
vi.mock("../services/sequence-step-suggest.service.js", () => ({ suggestStepForSequence }));

const SEQ_ID = "3361d2f2-5127-456a-9ca7-a6aa48460c94";
const STEP_ID = "0b0f2d4e-5b1e-4f5e-9d5e-0d6c1c1f7a11";
const URL = `/api/v1/sequences/${SEQ_ID}/steps/suggest`;

const HEADERS = {
  "x-stub-user-email": "suggest-step@test.com",
  "content-type": "application/json",
};

async function buildTestApp() {
  return buildApp({
    ...loadEnv(),
    CLERK_SECRET_KEY: undefined,
    LOG_LEVEL: "fatal",
    OPENSEARCH_URL: undefined,
  });
}

const okResult = {
  suggestions: [{ angle: "Warm intro", body: "Hi {{firstName}}" }],
  evidenceId: "ev-1",
  modelVersionId: null,
  promptVersionId: null,
};

describe("POST /sequences/:id/steps/suggest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    suggestStepForSequence.mockResolvedValue(okResult);
  });

  async function post(payload: unknown) {
    const app = await buildTestApp();
    const res = await app.inject({ method: "POST", url: URL, headers: HEADERS, payload: payload as object });
    await app.close();
    return res;
  }

  /** The test env has no DB in some setups — the route 503s before reaching the (mocked) service. */
  function dbMissing(res: { statusCode: number; json: () => unknown }) {
    return res.statusCode === 503 && (res.json() as { error?: string }).error === "database_unavailable";
  }

  it("returns the suggestions and passes the step context to the service", async () => {
    const res = await post({ stepType: "linkedin", linkedinAction: "connect", stepId: STEP_ID, excludeAngles: ["Warm intro"] });
    if (dbMissing(res)) return;

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(okResult);
    expect(suggestStepForSequence).toHaveBeenCalledTimes(1);
    const [, , workspaceId, sequenceId, input] = suggestStepForSequence.mock.calls[0]!;
    expect(workspaceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(sequenceId).toBe(SEQ_ID);
    expect(input).toEqual({
      target: { stepType: "linkedin", linkedinAction: "connect" },
      stepId: STEP_ID,
      excludeAngles: ["Warm intro"],
    });
  });

  it("accepts an email step with no LinkedIn action or stepId", async () => {
    const res = await post({ stepType: "email" });
    if (dbMissing(res)) return;
    expect(res.statusCode).toBe(200);
    expect(suggestStepForSequence.mock.calls[0]![4].target).toEqual({ stepType: "email" });
  });

  it.each([
    ["a LinkedIn step without an action", { stepType: "linkedin" }],
    ["an unsupported LinkedIn action", { stepType: "linkedin", linkedinAction: "like" }],
    ["an unsupported step type", { stepType: "call" }],
    ["a malformed stepId", { stepType: "email", stepId: "not-a-uuid" }],
  ])("400s for %s without calling the AI", async (_label, payload) => {
    const res = await post(payload);
    if (dbMissing(res)) return;
    expect(res.statusCode).toBe(400);
    expect(suggestStepForSequence).not.toHaveBeenCalled();
  });

  it("maps HttpError from the service (e.g. unknown sequence) to its status", async () => {
    suggestStepForSequence.mockRejectedValueOnce(new HttpError("sequence_not_found", 404));
    const res = await post({ stepType: "email" });
    if (dbMissing(res)) return;
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "sequence_not_found" });
  });

  it("surfaces AI provider failures with their status (503 no key, 502 bad output)", async () => {
    suggestStepForSequence.mockRejectedValueOnce(
      Object.assign(new Error("OpenRouter API key is not configured on this workspace"), { statusCode: 503 })
    );
    const noKey = await post({ stepType: "email" });
    if (dbMissing(noKey)) return;
    expect(noKey.statusCode).toBe(503);
    expect(noKey.json()).toMatchObject({ error: expect.stringContaining("OpenRouter") });

    suggestStepForSequence.mockRejectedValueOnce(
      Object.assign(new Error("AI returned no usable suggestions"), { statusCode: 502 })
    );
    const bad = await post({ stepType: "email" });
    expect(bad.statusCode).toBe(502);
  });
});
