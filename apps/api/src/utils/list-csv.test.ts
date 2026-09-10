import { describe, expect, it } from "vitest";
import { buildListCsv } from "./list-csv.js";

describe("buildListCsv", () => {
  it("escapes quotes and builds attachment filename", () => {
    const { filename, content } = buildListCsv('Acme "Q2" List', [
      {
        prospectId: "p1",
        snapshot: {
          fullName: 'Jane "Demo"',
          title: "VP Sales",
          companyDomain: "acme.com",
          industry: "Software",
          country: "US",
          email: "jane@acme.com",
          emailStatus: "valid",
        },
        score: { score: 82 },
      },
    ]);

    expect(filename).toBe("acme--q2--list.csv");
    expect(content).toContain('"Jane ""Demo"""');
    expect(content).toContain('"82"');
  });
});
