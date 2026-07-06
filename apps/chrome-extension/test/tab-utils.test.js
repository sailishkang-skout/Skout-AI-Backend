import { describe, expect, it } from "vitest";
import { pickLinkedInProfileTab, nameFromLinkedInUrl } from "../tab-utils.js";

describe("pickLinkedInProfileTab", () => {
  const patrick = {
    id: 1,
    url: "https://www.linkedin.com/in/patrickcollison/",
    active: false,
    lastAccessed: 100,
  };
  const jane = {
    id: 2,
    url: "https://www.linkedin.com/in/jane-doe/",
    active: true,
    lastAccessed: 200,
  };
  const feed = {
    id: 3,
    url: "https://www.linkedin.com/feed/",
    active: true,
    lastAccessed: 300,
  };

  it("prefers the focused active profile tab over an older profile tab", () => {
    const picked = pickLinkedInProfileTab([patrick, jane], jane);
    expect(picked?.id).toBe(2);
  });

  it("prefers active profile tab when focused tab is not a profile", () => {
    const picked = pickLinkedInProfileTab([patrick, jane, feed], feed);
    expect(picked?.id).toBe(2);
  });

  it("falls back to most recently accessed profile tab", () => {
    const older = { ...patrick, lastAccessed: 50 };
    const newer = { ...jane, active: false, lastAccessed: 250 };
    const picked = pickLinkedInProfileTab([older, newer], feed);
    expect(picked?.id).toBe(2);
  });

  it("returns null when no profile tabs exist", () => {
    expect(pickLinkedInProfileTab([feed], feed)).toBeNull();
  });
});

describe("nameFromLinkedInUrl", () => {
  it("formats hyphenated slugs as separate words", () => {
    expect(nameFromLinkedInUrl("https://www.linkedin.com/in/jane-doe/")).toBe("Jane Doe");
  });

  it("capitalizes single-word vanity slugs", () => {
    expect(nameFromLinkedInUrl("https://www.linkedin.com/in/patrickcollison/")).toBe("Patrickcollison");
  });
});
