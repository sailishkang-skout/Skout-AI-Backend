import { describe, expect, it } from "vitest";
import { MERGE_TOKENS } from "./sequence-merge-tokens.js";
import {
  buildStepSuggestionPrompt,
  coerceStepSuggestions,
  summarizeSiblingStep,
  type StepSuggestionContext,
} from "./sequence-step-suggestions.js";

const UNSUB = '<p style="font-size:11px;color:#888"><a href="{{unsubscribeUrl}}">Unsubscribe</a></p>';

function ctx(overrides: Partial<StepSuggestionContext> = {}): StepSuggestionContext {
  return {
    sequenceName: "Q3 SaaS CFO Outreach",
    target: { stepType: "email" },
    position: 3,
    total: 5,
    before: ["Step 1 · email: subject \"Quick idea\" — Hi {{firstName}}, noticed…"],
    after: [],
    ...overrides,
  };
}

describe("summarizeSiblingStep", () => {
  it("summarises an email with its subject and a tag-stripped, truncated body", () => {
    const line = summarizeSiblingStep({
      stepOrder: 1,
      stepType: "email",
      delayDays: 2,
      delayUnit: "days",
      subject: "Quick idea",
      bodyTemplate: `<p>Hi {{firstName}},</p><p>${"x".repeat(400)}</p>`,
    });
    expect(line).toContain("Step 1");
    expect(line).toContain("email");
    expect(line).toContain("Quick idea");
    expect(line).not.toContain("<p>");
    expect(line.length).toBeLessThan(400);
  });

  it("includes the LinkedIn action", () => {
    const line = summarizeSiblingStep({
      stepOrder: 2,
      stepType: "linkedin",
      linkedinAction: "connect",
      delayDays: 1,
      delayUnit: "days",
      subject: null,
      bodyTemplate: "Hi {{firstName}}, let's connect",
    });
    expect(line).toContain("linkedin");
    expect(line).toContain("connect");
  });

  it("summarises a wait step by its delay", () => {
    const line = summarizeSiblingStep({
      stepOrder: 3,
      stepType: "wait",
      delayDays: 3,
      delayUnit: "days",
      subject: null,
      bodyTemplate: null,
    });
    expect(line).toContain("wait");
    expect(line).toContain("3");
  });
});

describe("buildStepSuggestionPrompt", () => {
  it("grounds the prompt in the sequence name, position and neighbouring steps", () => {
    const { system, user } = buildStepSuggestionPrompt(
      ctx({ after: ["Step 4 · linkedin (message)"] })
    );
    expect(user).toContain("Q3 SaaS CFO Outreach");
    expect(user).toMatch(/step 3 of 5/i);
    expect(user).toContain("Quick idea");
    expect(user).toContain("Step 4");
    // system prompt must constrain tokens to what the API accepts
    for (const token of ["firstName", "companyName", "senderName", "unsubscribeUrl"]) {
      expect(system).toContain(`{{${token}}}`);
    }
  });

  it("says what each merge token contains, so the model can't misuse one", () => {
    const { system } = buildStepSuggestionPrompt(ctx());
    // every token the API accepts has its own described line — a new token can't ship undescribed
    for (const token of MERGE_TOKENS) {
      expect(system).toMatch(new RegExp(`^\\{\\{${token}\\}\\} — .+`, "m"));
    }
    // companyDomain is a website address, not an industry
    expect(system).toMatch(/^\{\{companyDomain\}\} — .*domain.*never .*(industry|sector)/im);
  });

  it("warns that company/title tokens can be blank so copy still reads without them", () => {
    const { system } = buildStepSuggestionPrompt(ctx());
    expect(system).toMatch(/may be (blank|empty)/i);
    expect(system).toMatch(/still read (naturally|correctly)/i);
    for (const token of ["companyName", "companyDomain", "title"]) {
      expect(system).toContain(`{{${token}}}`);
    }
  });

  it("adds audience, insights and angles-to-avoid only when provided", () => {
    const bare = buildStepSuggestionPrompt(ctx()).user;
    expect(bare).not.toMatch(/audience/i);
    expect(bare).not.toMatch(/avoid/i);

    const rich = buildStepSuggestionPrompt(
      ctx({
        audience: "Common titles: CFO, VP Finance.",
        insights: "Subject lines under 6 words got 2x replies.",
        excludeAngles: ["Warm intro"],
      })
    ).user;
    expect(rich).toContain("CFO, VP Finance");
    expect(rich).toContain("2x replies");
    expect(rich).toContain("Warm intro");
  });

  it("gives LinkedIn connect requests a short-note constraint", () => {
    const { system, user } = buildStepSuggestionPrompt(
      ctx({ target: { stepType: "linkedin", linkedinAction: "connect" } })
    );
    const all = `${system}\n${user}`;
    expect(all).toMatch(/connection (request|note)/i);
    expect(all).toMatch(/300/);
  });

  it("asks for a subject only on email; LinkedIn drafts are body-only", () => {
    const email = buildStepSuggestionPrompt(ctx());
    expect(email.system).toContain('"subject"');
    expect(email.system).not.toMatch(/no subject/i);

    for (const linkedinAction of ["connect", "message", "inmail"] as const) {
      const { system } = buildStepSuggestionPrompt(ctx({ target: { stepType: "linkedin", linkedinAction } }));
      expect(system).toMatch(/no subject/i);
      expect(system).not.toContain('"subject":"');
    }
  });
});

describe("coerceStepSuggestions — email", () => {
  const email = { stepType: "email" as const };

  it("returns angle/subject/html and appends the unsubscribe footer when missing", () => {
    const raw = JSON.stringify({
      suggestions: [{ angle: "Warm intro", subject: "Hi {{firstName}}", body: "<p>Hello {{firstName}}</p>" }],
    });
    const [s] = coerceStepSuggestions(raw, email);
    expect(s!.angle).toBe("Warm intro");
    expect(s!.subject).toBe("Hi {{firstName}}");
    expect(s!.body).toContain("<p>Hello {{firstName}}</p>");
    expect(s!.body).toContain("{{unsubscribeUrl}}");
  });

  it("does not duplicate an unsubscribe link the model already wrote", () => {
    const raw = JSON.stringify({
      suggestions: [{ angle: "A", subject: "S", body: `<p>Hi</p>${UNSUB}` }],
    });
    const [s] = coerceStepSuggestions(raw, email);
    expect(s!.body.match(/unsubscribeUrl/g)).toHaveLength(1);
  });

  it("wraps plain-text bodies into paragraphs", () => {
    const raw = JSON.stringify({
      suggestions: [{ angle: "A", subject: "S", body: "Hi {{firstName}},\n\nSecond para" }],
    });
    const [s] = coerceStepSuggestions(raw, email);
    expect(s!.body).toContain("<p>Hi {{firstName}},</p>");
    expect(s!.body).toContain("<p>Second para</p>");
  });

  it("drops suggestions with unknown merge tokens or bracket placeholders", () => {
    const raw = JSON.stringify({
      suggestions: [
        { angle: "bad token", subject: "S", body: "<p>Hi {{nickname}}</p>" },
        { angle: "bad subject token", subject: "Hi {{pet}}", body: "<p>ok</p>" },
        { angle: "bracket", subject: "S", body: "<p>Hi [Your Name]</p>" },
        { angle: "good", subject: "S", body: "<p>Hi {{firstName}}</p>" },
      ],
    });
    const out = coerceStepSuggestions(raw, email);
    expect(out.map((s) => s.angle)).toEqual(["good"]);
  });

  it("drops suggestions with an empty body or missing subject", () => {
    const raw = JSON.stringify({
      suggestions: [
        { angle: "no body", subject: "S", body: "  " },
        { angle: "no subject", body: "<p>x</p>" },
        { angle: "good", subject: "S", body: "<p>x</p>" },
      ],
    });
    expect(coerceStepSuggestions(raw, email).map((s) => s.angle)).toEqual(["good"]);
  });

  it("caps at three suggestions and truncates over-long subjects", () => {
    const raw = JSON.stringify({
      suggestions: Array.from({ length: 5 }, (_, i) => ({
        angle: `A${i}`,
        subject: "x".repeat(200),
        body: "<p>x</p>",
      })),
    });
    const out = coerceStepSuggestions(raw, email);
    expect(out).toHaveLength(3);
    expect(out[0]!.subject!.length).toBeLessThanOrEqual(80);
  });

  it("returns [] for unparseable output or a missing suggestions array", () => {
    expect(coerceStepSuggestions("not json", email)).toEqual([]);
    expect(coerceStepSuggestions("{}", email)).toEqual([]);
    expect(coerceStepSuggestions('{"suggestions":"nope"}', email)).toEqual([]);
  });

  it("falls back to a numbered angle when the model omits one", () => {
    const raw = JSON.stringify({ suggestions: [{ subject: "S", body: "<p>x</p>" }] });
    expect(coerceStepSuggestions(raw, email)[0]!.angle).toBe("Option 1");
  });
});

describe("coerceStepSuggestions — LinkedIn", () => {
  it("connect: plain text, no subject, drops notes over 300 chars", () => {
    const raw = JSON.stringify({
      suggestions: [
        { angle: "long", subject: "ignored", body: "y".repeat(301) },
        { angle: "short", subject: "ignored", body: "<p>Hi {{firstName}}, let's connect</p>" },
      ],
    });
    const out = coerceStepSuggestions(raw, { stepType: "linkedin", linkedinAction: "connect" });
    expect(out).toHaveLength(1);
    expect(out[0]!.angle).toBe("short");
    expect(out[0]!.subject).toBeUndefined();
    expect(out[0]!.body).toBe("Hi {{firstName}}, let's connect");
  });

  it("message: no subject, no unsubscribe footer", () => {
    const raw = JSON.stringify({
      suggestions: [{ angle: "A", subject: "ignored", body: "Hi {{firstName}}" }],
    });
    const [s] = coerceStepSuggestions(raw, { stepType: "linkedin", linkedinAction: "message" });
    expect(s!.subject).toBeUndefined();
    expect(s!.body).toBe("Hi {{firstName}}");
  });

  it("inmail: body-only (subject ignored), longer limit than a DM", () => {
    const raw = JSON.stringify({
      suggestions: [
        { angle: "long ok", subject: "ignored", body: "z".repeat(1000) },
        { angle: "too long", body: "z".repeat(1201) },
      ],
    });
    const out = coerceStepSuggestions(raw, { stepType: "linkedin", linkedinAction: "inmail" });
    expect(out.map((s) => s.angle)).toEqual(["long ok"]);
    expect(out[0]!.subject).toBeUndefined();
  });

  it("message: drops DMs over 700 chars", () => {
    const raw = JSON.stringify({ suggestions: [{ angle: "x", body: "z".repeat(701) }] });
    expect(coerceStepSuggestions(raw, { stepType: "linkedin", linkedinAction: "message" })).toEqual([]);
  });
});
