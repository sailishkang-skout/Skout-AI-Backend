import { describe, it, expect, vi, afterEach } from "vitest";
import { mockCreate } from "../test/mocks/openai.js";
import { extractFieldsFromCallNotes, isCallNotesExtractionConfigured } from "./call-notes-extraction.service.js";
import type { Env } from "../config/env.js";

afterEach(() => {
  vi.clearAllMocks();
});

const configuredEnv = { OPENROUTER_API_KEY: "test-key" } as unknown as Env;
const unconfiguredEnv = {} as unknown as Env;

function mockLlm(payload: Record<string, unknown>) {
  mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(payload) } }] });
}

describe("isCallNotesExtractionConfigured", () => {
  it("is false without an OpenRouter key", () => {
    expect(isCallNotesExtractionConfigured(unconfiguredEnv)).toBe(false);
  });
  it("is true with an OpenRouter key", () => {
    expect(isCallNotesExtractionConfigured(configuredEnv)).toBe(true);
  });
});

describe("extractFieldsFromCallNotes", () => {
  it("returns {} when unconfigured — never throws", async () => {
    const result = await extractFieldsFromCallNotes(unconfiguredEnv, "Talked about a Q3 budget of $50k");
    expect(result).toEqual({});
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns {} for empty notes without calling the LLM", async () => {
    const result = await extractFieldsFromCallNotes(configuredEnv, "   ");
    expect(result).toEqual({});
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns {} (never throws) when the LLM call fails", async () => {
    mockCreate.mockRejectedValueOnce(new Error("network error"));
    const result = await extractFieldsFromCallNotes(configuredEnv, "Some notes");
    expect(result).toEqual({});
  });

  it("returns {} (never throws) on unparseable JSON", async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: "not json" } }] });
    const result = await extractFieldsFromCallNotes(configuredEnv, "Some notes");
    expect(result).toEqual({});
  });

  it("parses typed contact/company fields with clamped confidence", async () => {
    mockLlm({
      contact: { title: "VP Sales", email: "a@b.com" },
      contactConfidence: 1.4, // out of range — must clamp to 1
      company: { industry: "Fintech", employeeCount: 120 },
      companyConfidence: -0.2, // clamp to 0
    });
    const result = await extractFieldsFromCallNotes(configuredEnv, "They mentioned a Q3 budget");
    expect(result).toEqual({
      contact: { title: "VP Sales", email: "a@b.com" },
      contactConfidence: 1,
      company: { industry: "Fintech", employeeCount: 120 },
      companyConfidence: 0,
    });
  });

  it("omits contact/company entirely when the notes said nothing relevant", async () => {
    mockLlm({});
    const result = await extractFieldsFromCallNotes(configuredEnv, "Just a quick hello, no update");
    expect(result.contact).toBeUndefined();
    expect(result.company).toBeUndefined();
  });
});
