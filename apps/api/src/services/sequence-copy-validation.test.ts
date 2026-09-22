import { describe, expect, it } from "vitest";
import { assertValidStepCopy } from "./sequence-copy-validation.js";

interface Failure {
  statusCode?: number;
  message: string;
  details?: { invalidToken?: string; reason?: string; allowed?: string[] };
}

function failure(fn: () => void): Failure {
  try {
    fn();
  } catch (err) {
    return err as Failure;
  }
  throw new Error("expected assertValidStepCopy to throw");
}

describe("assertValidStepCopy", () => {
  it("accepts valid copy, valid fallbacks, and missing fields", () => {
    expect(() => assertValidStepCopy({})).not.toThrow();
    expect(() =>
      assertValidStepCopy({ subject: null, bodyTemplate: null, variants: [{ subject: null, bodyTemplate: null }] })
    ).not.toThrow();
    expect(() =>
      assertValidStepCopy({
        subject: "Hi {{firstName|there}}",
        bodyTemplate: "<p>Hi {{firstName}}</p>",
        variants: [{ subject: "S", bodyTemplate: "{{title|your role}}" }],
      })
    ).not.toThrow();
  });

  it("rejects a bad token in the body with a 422 that names it", () => {
    const err = failure(() => assertValidStepCopy({ bodyTemplate: "Hi {{unknownField}}" }));
    expect(err.statusCode).toBe(422);
    expect(err.message).toBe("Unknown merge token: {{unknownField}}");
    expect(err.details).toMatchObject({ invalidToken: "unknownField", reason: "unknown_token" });
    expect(err.details?.allowed).toContain("firstName");
  });

  it("also checks the subject and every variant's subject and body", () => {
    for (const copy of [
      { subject: "Hi {{nickname}}" },
      { variants: [{ bodyTemplate: "ok" }, { subject: "{{nickname}}" }] },
      { variants: [{}, {}, { bodyTemplate: "<p>{{nickname}}</p>" }] },
    ]) {
      expect(failure(() => assertValidStepCopy(copy)).statusCode).toBe(422);
    }
  });

  it("rejects bad fallbacks and malformed placeholders with a reason", () => {
    expect(failure(() => assertValidStepCopy({ subject: "{{firstName|}}" })).details?.reason).toBe("empty_fallback");
    expect(failure(() => assertValidStepCopy({ bodyTemplate: "{{unsubscribeUrl|x}}" })).details?.reason).toBe(
      "fallback_not_allowed"
    );
    expect(failure(() => assertValidStepCopy({ bodyTemplate: "Hi {{ firstName }}" })).details?.reason).toBe(
      "malformed_token"
    );
  });

  it("reports the first problem, checking the subject before the body", () => {
    const err = failure(() => assertValidStepCopy({ subject: "{{aaa}}", bodyTemplate: "{{bbb}}" }));
    expect(err.details?.invalidToken).toBe("aaa");
  });
});
