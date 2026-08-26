import { describe, expect, it, vi, beforeEach } from "vitest";
import { HttpError } from "../utils/http.js";

vi.mock("./linkedin-connection.service.js", () => ({
  checkLinkedinConnectionStatus: vi.fn(),
}));

vi.mock("./linkedin-account.service.js", () => ({
  LinkedinAccountService: vi.fn().mockImplementation(() => ({
    list: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock("./prospect-resolver.service.js", () => ({
  resolveProspectFields: vi.fn(),
}));

vi.mock("./regional-intel.service.js", () => ({
  generateRegionalBrief: vi.fn(),
}));

vi.mock("./ai-evidence.service.js", () => ({
  pinAiClaim: vi.fn().mockResolvedValue({ evidenceId: "ev-1", modelVersionId: null, promptVersionId: null }),
}));

vi.mock("./policy-gateway.service.js", () => ({
  assertAllowed: vi.fn().mockResolvedValue({ outcome: "allowed", decisionId: "d-1", mode: "approve" }),
}));

vi.mock("./journey-metrics.js", () => ({
  incrJourneyMetric: vi.fn(),
}));

import { checkLinkedinConnectionStatus } from "./linkedin-connection.service.js";
import { LinkedinAccountService } from "./linkedin-account.service.js";
import { resolveProspectFields } from "./prospect-resolver.service.js";
import { generateRegionalBrief } from "./regional-intel.service.js";
import { assertAllowed } from "./policy-gateway.service.js";
import {
  checkLinkedinVoiceEligibility,
  confirmLinkedinVoiceSent,
  createLinkedinVoiceHandoff,
  draftLinkedinVoiceScript,
  normalizeVoiceChoice,
} from "./linkedin-voice.service.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const CONTACT_ID = "22222222-2222-4222-8222-222222222222";
const HANDOFF_ID = "33333333-3333-4333-8333-333333333333";
const TOKEN = "44444444-4444-4444-8444-444444444444";

const config = {
  NODE_ENV: "development",
  FRONTEND_URL: "http://localhost:3000",
  CORS_ORIGIN: ["http://localhost:3000"],
  OPENROUTER_API_KEY: undefined,
  OPENAI_API_KEY: undefined,
} as any;

const prospect = {
  prospectId: "p-1",
  firstName: "Ada",
  lastName: "Lovelace",
  fullName: "Ada Lovelace",
  title: "VP Engineering",
  companyName: "Analytical Engines",
  linkedinUrl: "https://www.linkedin.com/in/ada-lovelace",
  location: "London, United Kingdom",
};

function makeDb(opts: {
  handoff?: Record<string, unknown> | null;
  contacts?: Array<Record<string, unknown>>;
  insertHandoff?: Record<string, unknown>;
  updatedHandoff?: Record<string, unknown>;
  insertedActivity?: Record<string, unknown>;
}) {
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn(),
  };
  selectChain.limit.mockImplementation(async () => {
    // First select in confirm is the handoff; later selects are contacts.
    if (selectChain.limit.mock.calls.length <= 1) {
      return opts.handoff ? [opts.handoff] : [];
    }
    return opts.contacts ?? [];
  });

  return {
    select: vi.fn().mockReturnValue(selectChain),
    insert: vi.fn().mockImplementation((table: { name?: string } | unknown) => {
      const tableName = String((table as { name?: string })?.name ?? "");
      const isActivity = tableName.includes("activities") || (table as { _: { name?: string } })?._?.name === "activities";
      return {
        values: vi.fn().mockImplementation((values: Record<string, unknown>) => ({
          returning: vi.fn().mockResolvedValue([
            isActivity || values.activityType
              ? (opts.insertedActivity ?? { id: "act-1", ...values })
              : {
                  id: HANDOFF_ID,
                  handoffToken: values.handoffToken ?? TOKEN,
                  status: values.status ?? "handed_off",
                  ...values,
                  ...opts.insertHandoff,
                },
          ]),
        })),
      };
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([
            opts.updatedHandoff ?? { id: HANDOFF_ID, status: "confirmed", confirmedAt: new Date() },
          ]),
        }),
      }),
    }),
    _select: selectChain,
  } as any;
}

describe("normalizeVoiceChoice", () => {
  it("maps self/none and OpenAI names onto personal vs synthetic", () => {
    expect(normalizeVoiceChoice("self")).toEqual({ voiceChoice: "personal", syntheticProfile: null });
    expect(normalizeVoiceChoice("personal")).toEqual({ voiceChoice: "personal", syntheticProfile: null });
    expect(normalizeVoiceChoice("alloy")).toEqual({ voiceChoice: "synthetic", syntheticProfile: "alloy" });
    expect(normalizeVoiceChoice("cloned")).toEqual({ voiceChoice: "synthetic", syntheticProfile: "alloy" });
  });
});

describe("checkLinkedinVoiceEligibility", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is not eligible when the prospect has no LinkedIn URL", async () => {
    vi.mocked(resolveProspectFields).mockResolvedValue({ ...prospect, linkedinUrl: undefined });
    const result = await checkLinkedinVoiceEligibility({} as any, config, {
      workspaceId: WORKSPACE_ID,
      prospectId: "p-1",
    });
    expect(result.eligible).toBe(false);
    expect(result.status).toBe("unknown");
    expect(result.reason).toBe("missing_linkedin_url");
    expect(checkLinkedinConnectionStatus).not.toHaveBeenCalled();
  });

  it("is not eligible when no LinkedIn account is connected", async () => {
    vi.mocked(resolveProspectFields).mockResolvedValue(prospect);
    vi.mocked(LinkedinAccountService).mockImplementation(
      () => ({ list: vi.fn().mockResolvedValue([]) }) as any
    );
    const result = await checkLinkedinVoiceEligibility({} as any, config, {
      workspaceId: WORKSPACE_ID,
      prospectId: "p-1",
    });
    expect(result.eligible).toBe(false);
    expect(result.status).toBe("unknown");
    expect(result.reason).toBe("linkedin_account_not_connected");
  });

  it("is eligible only for a confirmed first-degree connection", async () => {
    vi.mocked(resolveProspectFields).mockResolvedValue(prospect);
    vi.mocked(LinkedinAccountService).mockImplementation(
      () => ({ list: vi.fn().mockResolvedValue([{ id: "acct-1", status: "active" }]) }) as any
    );
    vi.mocked(checkLinkedinConnectionStatus).mockResolvedValue("accepted");
    const result = await checkLinkedinVoiceEligibility({} as any, config, {
      workspaceId: WORKSPACE_ID,
      prospectId: "p-1",
    });
    expect(result.eligible).toBe(true);
    expect(result.status).toBe("accepted");
    expect(result.reason).toBeUndefined();
  });
});

describe("draftLinkedinVoiceScript", () => {
  beforeEach(() => vi.clearAllMocks());

  it("loads regional brief from the prospect location, not a hardcoded US default", async () => {
    vi.mocked(resolveProspectFields).mockResolvedValue(prospect);
    vi.mocked(generateRegionalBrief).mockResolvedValue({
      location: "London, United Kingdom",
      locale: "en-GB",
      purpose: "onboarding",
      summary: "UK SaaS buyers prefer concise, evidence-led notes.",
      marketNotes: ["Keep under 30 seconds"],
      complianceHints: [],
      outreachTone: "measured, professional",
      territoryHints: [],
      model: "heuristic",
      unverified: true,
    });

    const result = await draftLinkedinVoiceScript({} as any, config, {
      workspaceId: WORKSPACE_ID,
      prospectId: "p-1",
      goal: "Book a 15-minute working session",
      tone: "Warm",
    });

    expect(generateRegionalBrief).toHaveBeenCalledWith(
      expect.objectContaining({ location: "London, United Kingdom" }),
      undefined
    );
    expect(result.language).toBe("en-GB");
    expect(result.regionalBriefPreview).toContain("measured, professional");
    expect(result.evidence.unverified).toBe(true);
    expect(result.scriptText.toLowerCase()).toContain("ada");
  });
});

describe("createLinkedinVoiceHandoff", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuses an ineligible prospect and never implies a LinkedIn send", async () => {
    vi.mocked(resolveProspectFields).mockResolvedValue({ ...prospect, linkedinUrl: undefined });
    const db = makeDb({});
    await expect(
      createLinkedinVoiceHandoff(db, config, {
        workspaceId: WORKSPACE_ID,
        prospectId: "p-1",
        scriptText: "Hi Ada, quick thought on pipeline.",
      })
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("creates a manual-only mobile handoff for an eligible 1st-degree connection", async () => {
    vi.mocked(resolveProspectFields).mockResolvedValue(prospect);
    vi.mocked(LinkedinAccountService).mockImplementation(
      () => ({ list: vi.fn().mockResolvedValue([{ id: "acct-1", status: "active" }]) }) as any
    );
    vi.mocked(checkLinkedinConnectionStatus).mockResolvedValue("accepted");
    const db = makeDb({
      insertHandoff: {
        id: HANDOFF_ID,
        handoffToken: TOKEN,
        status: "handed_off",
        prospectId: "p-1",
        scriptText: "Hi Ada",
        voiceChoice: "personal",
      },
    });

    const result = await createLinkedinVoiceHandoff(db, config, {
      workspaceId: WORKSPACE_ID,
      prospectId: "p-1",
      scriptText: "Hi Ada, sharing a 30-second idea.",
      voiceChoice: "personal",
    });

    expect(result.status).toBe("handed_off");
    expect(result.note.toLowerCase()).toContain("manual");
    expect(result.mobileUrl).toContain(`/linkedin/voice/h/${TOKEN}`);
    expect(result.linkedinUrl).toContain("linkedin.com/in/ada-lovelace");
    expect(db.insert).toHaveBeenCalled();
  });
});

describe("confirmLinkedinVoiceSent", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes the timeline activity onto the CRM contact, not a random UUID", async () => {
    const db = makeDb({
      handoff: {
        id: HANDOFF_ID,
        workspaceId: WORKSPACE_ID,
        prospectId: "p-1",
        scriptText: "Hi Ada",
        status: "handed_off",
        handoffToken: TOKEN,
      },
      contacts: [{ id: CONTACT_ID }],
      insertedActivity: { id: "act-9", entityId: CONTACT_ID },
      updatedHandoff: {
        id: HANDOFF_ID,
        status: "confirmed",
        confirmedAt: new Date("2026-08-26T12:00:00Z"),
        activityId: "act-9",
      },
    });

    const row = await confirmLinkedinVoiceSent(db, {
      workspaceId: WORKSPACE_ID,
      handoffToken: TOKEN,
      userId: "user-1",
    });

    expect(assertAllowed).toHaveBeenCalled();
    expect(row.status).toBe("confirmed");
    const insertArg = db.insert.mock.calls[0]?.[0];
    expect(insertArg).toBeDefined();
    const valuesFn = db.insert.mock.results[0]?.value.values as ReturnType<typeof vi.fn>;
    expect(valuesFn).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "contact",
        entityId: CONTACT_ID,
        activityType: "linkedin_voice_sent",
      })
    );
  });

  it("is idempotent once already confirmed", async () => {
    const existing = {
      id: HANDOFF_ID,
      status: "confirmed",
      confirmedAt: new Date(),
      handoffToken: TOKEN,
      workspaceId: WORKSPACE_ID,
    };
    const db = makeDb({ handoff: existing });
    const row = await confirmLinkedinVoiceSent(db, {
      workspaceId: WORKSPACE_ID,
      handoffToken: TOKEN,
    });
    expect(row.status).toBe("confirmed");
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("404s when the token is unknown", async () => {
    const db = makeDb({ handoff: null });
    await expect(
      confirmLinkedinVoiceSent(db, { workspaceId: WORKSPACE_ID, handoffToken: TOKEN })
    ).rejects.toBeInstanceOf(HttpError);
  });
});
