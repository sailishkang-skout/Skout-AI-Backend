import { describe, expect, it } from "vitest";
import { productAppUrl } from "./app-url.js";

describe("productAppUrl", () => {
  it("keeps a base that already ends in /app", () => {
    expect(productAppUrl("https://www.skoutai.io/app")).toBe("https://www.skoutai.io/app");
    expect(productAppUrl("https://www.skoutai.io/app/")).toBe("https://www.skoutai.io/app");
  });

  it("adds /app to a bare origin", () => {
    expect(productAppUrl("https://www.skoutai.io")).toBe("https://www.skoutai.io/app");
    expect(productAppUrl("http://localhost:3000/")).toBe("http://localhost:3000/app");
  });

  it("never doubles /app when a path is appended", () => {
    expect(`${productAppUrl("https://www.skoutai.io/app")}/settings/calendar`).toBe("https://www.skoutai.io/app/settings/calendar");
  });
});
