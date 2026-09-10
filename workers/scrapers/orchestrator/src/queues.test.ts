import { describe, expect, it } from "vitest";
import { queueForSource, SCRAPE_QUEUES } from "./queues.js";

describe("queueForSource", () => {
  it("maps known sources to bot queues", () => {
    expect(queueForSource("company-web")).toBe(SCRAPE_QUEUES.companyWeb);
    expect(queueForSource("linkedin")).toBe(SCRAPE_QUEUES.linkedin);
    expect(queueForSource("opencorporates")).toBe(SCRAPE_QUEUES.opencorporates);
    expect(queueForSource("sec-edgar")).toBe(SCRAPE_QUEUES.secEdgar);
  });

  it("throws for unknown sources", () => {
    expect(() => queueForSource("unknown")).toThrow("Unknown scrape source");
  });
});
