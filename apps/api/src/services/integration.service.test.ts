import { describe, expect, it } from "vitest";
import { normalizeUnipileDsn } from "./integration.service.js";

describe("normalizeUnipileDsn", () => {
  it("adds https:// to a schemeless DSN, as shown in Unipile's own dashboard", () => {
    expect(normalizeUnipileDsn("api61.unipile.com:19183")).toBe("https://api61.unipile.com:19183");
  });

  it("leaves an already-schemed DSN untouched", () => {
    expect(normalizeUnipileDsn("https://api1.unipile.com:13111")).toBe("https://api1.unipile.com:13111");
  });

  it("preserves an explicit http:// scheme instead of forcing https", () => {
    expect(normalizeUnipileDsn("http://localhost:9999")).toBe("http://localhost:9999");
  });

  it("strips a trailing slash", () => {
    expect(normalizeUnipileDsn("api61.unipile.com:19183/")).toBe("https://api61.unipile.com:19183");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeUnipileDsn("  api61.unipile.com:19183  ")).toBe("https://api61.unipile.com:19183");
  });
});
