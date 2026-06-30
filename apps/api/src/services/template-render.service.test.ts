import { describe, expect, it } from "vitest";
import { renderTemplate } from "./template-render.service.js";

describe("renderTemplate", () => {
  it("interpolates known merge tokens", () => {
    const result = renderTemplate("Hi {{firstName}}, {{senderName}} here from {{companyName}}.", {
      firstName: "Ada",
      senderName: "Sam",
      companyName: "Skout",
    });
    expect(result).toBe("Hi Ada, Sam here from Skout.");
  });

  it("replaces unknown/missing tokens with an empty string", () => {
    expect(renderTemplate("Hello {{firstName}} {{lastName}}", { firstName: "Ada" })).toBe("Hello Ada ");
  });

  it("leaves plain text without tokens untouched", () => {
    expect(renderTemplate("No tokens here.", {})).toBe("No tokens here.");
  });

  it("interpolates the unsubscribeUrl token", () => {
    const result = renderTemplate("Bye. {{unsubscribeUrl}}", {
      unsubscribeUrl: "https://api.skout.ai/api/v1/unsubscribe/abc",
    });
    expect(result).toBe("Bye. https://api.skout.ai/api/v1/unsubscribe/abc");
  });

  it("supports repeated tokens", () => {
    expect(renderTemplate("{{firstName}} {{firstName}}", { firstName: "Ada" })).toBe("Ada Ada");
  });
});
