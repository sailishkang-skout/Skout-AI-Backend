import { describe, expect, it } from "vitest";
import {
  COPILOT_PERSONAS,
  COPILOT_PERSONA_DEFS,
  composeSystemPrompt,
  getCopilotPersonaDef,
  isCopilotPersona,
} from "./ai-copilot-personas.service.js";

describe("COPILOT_PERSONA_DEFS — SP-06 persona registry", () => {
  it("registers exactly the 4 personas the vision doc names", () => {
    expect(COPILOT_PERSONAS).toEqual(["sales", "crm_data", "meeting_call", "gtm_strategy"]);
  });

  it("gives every persona a non-empty label, description, and system-prompt fragment", () => {
    for (const id of COPILOT_PERSONAS) {
      const def = COPILOT_PERSONA_DEFS[id];
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.description.length).toBeGreaterThan(0);
      expect(def.systemPromptFragment.length).toBeGreaterThan(0);
    }
  });

  it("marks Sales and CRM Data as fully fleshed out, and the other two as not yet — matching the ticket's explicit first-cut scope", () => {
    expect(COPILOT_PERSONA_DEFS.sales.fleshedOut).toBe(true);
    expect(COPILOT_PERSONA_DEFS.crm_data.fleshedOut).toBe(true);
    expect(COPILOT_PERSONA_DEFS.meeting_call.fleshedOut).toBe(false);
    expect(COPILOT_PERSONA_DEFS.gtm_strategy.fleshedOut).toBe(false);
  });

  it("gives CRM Data a real, non-empty tool-subset restriction", () => {
    expect(COPILOT_PERSONA_DEFS.crm_data.allowedToolNames?.length).toBeGreaterThan(0);
  });

  it("does not restrict Sales, Meeting/Call, or GTM Strategy's tool set in this cut", () => {
    expect(COPILOT_PERSONA_DEFS.sales.allowedToolNames).toBeUndefined();
    expect(COPILOT_PERSONA_DEFS.meeting_call.allowedToolNames).toBeUndefined();
    expect(COPILOT_PERSONA_DEFS.gtm_strategy.allowedToolNames).toBeUndefined();
  });
});

describe("isCopilotPersona", () => {
  it("accepts every registered persona id", () => {
    for (const id of COPILOT_PERSONAS) expect(isCopilotPersona(id)).toBe(true);
  });

  it("rejects an unknown string, undefined, and non-string values", () => {
    expect(isCopilotPersona("marketing")).toBe(false);
    expect(isCopilotPersona(undefined)).toBe(false);
    expect(isCopilotPersona(42)).toBe(false);
  });
});

describe("getCopilotPersonaDef", () => {
  it("returns null when no persona is given (the no-persona/general case)", () => {
    expect(getCopilotPersonaDef(undefined)).toBeNull();
  });

  it("returns the matching def for a given persona id", () => {
    expect(getCopilotPersonaDef("sales")?.label).toBe("Sales");
  });
});

describe("composeSystemPrompt", () => {
  const base = "BASE SYSTEM PROMPT";

  it("returns the base prompt unchanged when no persona is set", () => {
    expect(composeSystemPrompt(base, undefined)).toBe(base);
  });

  it("prepends the persona's fragment ahead of the base prompt, never replacing it", () => {
    const composed = composeSystemPrompt(base, "crm_data");
    expect(composed).toContain(COPILOT_PERSONA_DEFS.crm_data.systemPromptFragment);
    expect(composed).toContain(base);
    expect(composed.indexOf(COPILOT_PERSONA_DEFS.crm_data.systemPromptFragment)).toBeLessThan(composed.indexOf(base));
  });

  it("composes correctly for every registered persona", () => {
    for (const id of COPILOT_PERSONAS) {
      const composed = composeSystemPrompt(base, id);
      expect(composed).toContain(COPILOT_PERSONA_DEFS[id].systemPromptFragment);
      expect(composed).toContain(base);
    }
  });
});
