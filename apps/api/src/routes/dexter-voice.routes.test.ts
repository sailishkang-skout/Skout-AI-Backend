import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";

/**
 * §8.8 + §10.5 — LinkedIn Workspace & AI Voice Message Unit/Integration Tests.
 */
const hasDatabase = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabase)("§8.8 / §10.5 LinkedIn Voice Studio Routes", () => {
  let app: FastifyInstance;
  const email = `linkedin-voice-${Date.now()}@test.com`;

  beforeAll(async () => {
    const config = loadEnv();
    app = await buildApp({
      ...config,
      CLERK_SECRET_KEY: undefined,
      LOG_LEVEL: "error",
      AUTH_STUB: true,
      OPENROUTER_API_KEY: undefined,
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  function headers() {
    return {
      "x-stub-user-email": email,
      "content-type": "application/json",
    };
  }

  it("GET /linkedin/voice/eligibility — returns eligibility check for prospect", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/linkedin/voice/eligibility?prospectId=test-prospect-1",
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: { eligible: boolean; status: string; prospectName: string };
    };
    expect(body.data).toBeDefined();
    expect(typeof body.data.eligible).toBe("boolean");
    expect(body.data.prospectName).toBeDefined();
  });

  it("POST /linkedin/voice/draft-script — drafts personalized voice script with regional norms", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/linkedin/voice/draft-script",
      headers: headers(),
      payload: {
        prospectId: "test-prospect-2",
        goal: "Discuss enterprise pipeline acceleration",
        tone: "Warm, professional, consultative",
        customNotes: "Mention recent Series B funding",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: {
        scriptText: string;
        regionalBriefPreview: string;
        estimatedDurationSeconds: number;
        prospect: { id: string; name: string };
      };
    };
    expect(body.data.scriptText).toBeTruthy();
    expect(body.data.regionalBriefPreview).toContain("Regional Tone");
    expect(body.data.estimatedDurationSeconds).toBeGreaterThanOrEqual(15);
    expect(body.data.prospect.id).toBe("test-prospect-2");
  });

  it("POST /linkedin/voice/synthesize — generates audio synthesis stream/preview", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/linkedin/voice/synthesize",
      headers: headers(),
      payload: {
        scriptText: "Hey Alex, saw your work at Acme and wanted to share a quick 30-second idea.",
        voice: "alloy",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: {
        audioBase64: string;
        mimeType: string;
        voice: string;
        durationEstimateSeconds: number;
      };
    };
    expect(body.data.audioBase64).toBeTruthy();
    expect(body.data.mimeType).toBe("audio/mpeg");
    expect(body.data.voice).toBe("alloy");
    expect(body.data.durationEstimateSeconds).toBeGreaterThanOrEqual(5);
  });

  it("POST /linkedin/voice/handoff & POST /linkedin/voice/confirm-sent — full lifecycle", async () => {
    // 1. Create handoff with bypass flag for testing without live Unipile connection
    const handoff = await app.inject({
      method: "POST",
      url: "/api/v1/linkedin/voice/handoff",
      headers: headers(),
      payload: {
        prospectId: "test-prospect-voice-lifecycle",
        scriptText: "Hi Sarah, checking in regarding your outbound automation workflows.",
        voiceChoice: "alloy",
        regionalBriefPreview: "US Tech Norms: Consultative & concise",
        bypassEligibilityCheck: true,
      },
    });
    expect(handoff.statusCode).toBe(201);
    const handoffBody = handoff.json() as {
      data: { id: string; handoffToken: string; status: string; note: string };
    };
    expect(handoffBody.data.id).toBeTruthy();
    expect(handoffBody.data.handoffToken).toBeTruthy();
    expect(handoffBody.data.status).toBe("handed_off");
    expect(handoffBody.data.note).toContain("Manual send only");

    // 2. Confirm sent
    const confirmed = await app.inject({
      method: "POST",
      url: "/api/v1/linkedin/voice/confirm-sent",
      headers: headers(),
      payload: {
        handoffToken: handoffBody.data.handoffToken,
      },
    });
    expect(confirmed.statusCode).toBe(200);
    const confirmedBody = confirmed.json() as {
      data: { id: string; status: string; confirmedAt: string };
    };
    expect(confirmedBody.data.status).toBe("confirmed");
    expect(confirmedBody.data.confirmedAt).toBeTruthy();
  });
});
