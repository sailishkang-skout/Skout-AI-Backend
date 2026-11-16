import { describe, expect, it } from "vitest";
import { personIngestSchema } from "./capture-schemas.js";

const base = {
  runId: "6f1c7a52-4f0e-4b57-8a8e-0d7d3f5d9a11",
  publicId: "jane-doe",
  sourceUrl: "https://www.linkedin.com/in/jane-doe/",
  fullName: "Jane Doe",
};

describe("person capture website and followers", () => {
  it("accepts the portfolio, other links and the follower count", () => {
    const parsed = personIngestSchema.parse({
      ...base,
      followersCount: 2300,
      website: "https://jane.dev/work",
      websites: [{ url: "https://jane.dev/work", label: "Portfolio" }, { url: "http://blog.jane.dev" }],
    });
    expect(parsed).toMatchObject({ followersCount: 2300, website: "https://jane.dev/work" });
    expect(parsed.websites).toHaveLength(2);
  });

  it.each([
    "javascript:alert(1)",
    "ftp://jane.dev",
    "https://www.linkedin.com/in/jane-doe/",
    "https://lnkd.in/abc",
    "https://localhost/admin",
    "jane.dev",
    "not a url",
  ])("rejects a website that is not a web address outside LinkedIn: %s", (website) => {
    expect(personIngestSchema.safeParse({ ...base, website }).success).toBe(false);
  });

  it("rejects an oversized or malformed link list", () => {
    const link = { url: "https://jane.dev" };
    expect(personIngestSchema.safeParse({ ...base, websites: Array(11).fill(link) }).success).toBe(false);
    expect(personIngestSchema.safeParse({ ...base, websites: [{ url: "https://jane.dev", extra: 1 }] }).success).toBe(false);
  });

  it("still accepts a capture without either field", () => {
    expect(personIngestSchema.safeParse(base).success).toBe(true);
  });
});
