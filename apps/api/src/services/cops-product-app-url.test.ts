import { describe, expect, it } from "vitest";
import { productAppUrl } from "./cops-onboarding.service.js";

describe("productAppUrl", () => {
  it("adds the /app basePath once", () => {
    expect(productAppUrl("https://skoutai.io")).toBe("https://skoutai.io/app");
    expect(productAppUrl("https://skoutai.io/")).toBe("https://skoutai.io/app");
    expect(productAppUrl("https://skoutai.io/app")).toBe("https://skoutai.io/app");
    expect(productAppUrl("https://skoutai.io/app/")).toBe("https://skoutai.io/app");
  });
});
