import { describe, expect, it } from "vitest";
import {
  FALLBACK_MAX,
  findMergeTemplateIssue,
  parseMergeTokens,
  renderMergeTemplate,
} from "./merge-template.js";

const ALLOWED = new Set(["firstName", "companyName", "title", "unsubscribeUrl"]);

describe("parseMergeTokens", () => {
  it("finds plain and fallback tokens in order, trimming fallbacks", () => {
    const tokens = parseMergeTokens("Hi {{firstName|there}}, {{companyName}} {{title| your role }}");
    expect(tokens.map((t) => [t.name, t.fallback])).toEqual([
      ["firstName", "there"],
      ["companyName", null],
      ["title", "your role"],
    ]);
  });

  it("records each token's raw text and position", () => {
    const [token] = parseMergeTokens("ab {{firstName|x}}");
    expect(token).toMatchObject({ raw: "{{firstName|x}}", index: 3 });
  });

  it("ignores anything that isn't a valid token", () => {
    expect(parseMergeTokens("{{ firstName }} {{a|b|c}} {{}} {firstName}")).toEqual([]);
  });
});

describe("renderMergeTemplate", () => {
  it("fills plain tokens, and a missing value renders empty (unchanged behaviour)", () => {
    expect(renderMergeTemplate("Hi {{firstName}} {{lastName}}!", { firstName: "Ada" })).toBe("Hi Ada !");
  });

  it("uses the fallback when the value is missing, empty or whitespace", () => {
    const template = "Hi {{firstName|there}},";
    expect(renderMergeTemplate(template, {})).toBe("Hi there,");
    expect(renderMergeTemplate(template, { firstName: "" })).toBe("Hi there,");
    expect(renderMergeTemplate(template, { firstName: "   " })).toBe("Hi there,");
    expect(renderMergeTemplate(template, { firstName: "Ada" })).toBe("Hi Ada,");
  });

  it("trims the fallback", () => {
    expect(renderMergeTemplate("{{title| your role }}", {})).toBe("your role");
  });

  it("keeps a whitespace-only value when there is no fallback (unchanged behaviour)", () => {
    expect(renderMergeTemplate("[{{title}}]", { title: " " })).toBe("[ ]");
  });

  it("resolves repeated tokens independently", () => {
    expect(renderMergeTemplate("{{firstName|A}} {{firstName|B}} {{firstName}}", { firstName: "Ada" })).toBe("Ada Ada Ada");
    expect(renderMergeTemplate("{{firstName|A}} {{firstName|B}}", {})).toBe("A B");
  });

  it("leaves malformed placeholders untouched", () => {
    expect(renderMergeTemplate("{{ firstName }} {{a|b|c}}", { firstName: "Ada" })).toBe("{{ firstName }} {{a|b|c}}");
  });
});

describe("findMergeTemplateIssue", () => {
  it("accepts plain tokens, valid fallbacks and plain text", () => {
    expect(findMergeTemplateIssue("Hi {{firstName}}, at {{companyName|your company}}", ALLOWED)).toBeNull();
    expect(findMergeTemplateIssue("No placeholders here.", ALLOWED)).toBeNull();
    expect(findMergeTemplateIssue(`{{title|${"x".repeat(FALLBACK_MAX)}}}`, ALLOWED)).toBeNull();
  });

  it("rejects unknown tokens, with or without a fallback", () => {
    expect(findMergeTemplateIssue("Hi {{nickname}}", ALLOWED)).toEqual({
      code: "unknown_token",
      token: "nickname",
      message: "Unknown merge token: {{nickname}}",
    });
    expect(findMergeTemplateIssue("Hi {{nickname|pal}}", ALLOWED)).toMatchObject({
      code: "unknown_token",
      token: "nickname",
    });
  });

  it("rejects malformed placeholders", () => {
    for (const bad of ["{{ firstName }}", "{{firstName|a|b}}", "{{}}", "{{first-name}}"]) {
      expect(findMergeTemplateIssue(bad, ALLOWED)?.code).toBe("malformed_token");
    }
    expect(findMergeTemplateIssue("{{ firstName }}", ALLOWED)?.message).toBe("Malformed merge token: {{ firstName }}");
  });

  it("rejects empty and over-long fallbacks", () => {
    expect(findMergeTemplateIssue("{{title|}}", ALLOWED)).toMatchObject({
      code: "empty_fallback",
      token: "title",
      message: "Fallback for {{title}} is empty",
    });
    expect(findMergeTemplateIssue("{{title|   }}", ALLOWED)?.code).toBe("empty_fallback");
    expect(findMergeTemplateIssue(`{{title|${"x".repeat(FALLBACK_MAX + 1)}}}`, ALLOWED)).toMatchObject({
      code: "fallback_too_long",
      token: "title",
      message: `Fallback for {{title}} is longer than ${FALLBACK_MAX} characters`,
    });
  });

  it("rejects a fallback on the unsubscribe link", () => {
    expect(findMergeTemplateIssue("{{unsubscribeUrl|https://x.test}}", ALLOWED)).toMatchObject({
      code: "fallback_not_allowed",
      token: "unsubscribeUrl",
      message: "{{unsubscribeUrl}} can't have a fallback",
    });
  });

  it("reports the first problem in reading order", () => {
    expect(findMergeTemplateIssue("{{title|}} {{nickname}}", ALLOWED)?.code).toBe("empty_fallback");
    expect(findMergeTemplateIssue("{{nickname}} {{title|}}", ALLOWED)?.code).toBe("unknown_token");
  });
});
