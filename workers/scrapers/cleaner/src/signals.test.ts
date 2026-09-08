import { describe, expect, it } from "vitest";
import { collectSignals } from "./signals.js";

describe("collectSignals — leadership_change (§8.5 SS-07)", () => {
  it("emits a leadership_change signal when a leadership change is detected", () => {
    const signals = collectSignals({
      source: "company-web",
      domain: "acme.com",
      scrapedAt: new Date().toISOString(),
      leadershipChange: {
        changeType: "hire",
        role: "CFO",
        personName: "Jane Doe",
        effectiveDate: "2026-08-01",
      },
    });

    const signal = signals.find((s) => s.type === "leadership_change");
    expect(signal).toBeDefined();
    expect(signal?.observedAt).toBe("2026-08-01");
    expect(signal?.detail).toBe("hire CFO Jane Doe");
    expect(signal?.source).toBe("company-web");
  });

  it("does not emit when leadershipChange is absent", () => {
    const signals = collectSignals({
      source: "company-web",
      domain: "acme.com",
      scrapedAt: new Date().toISOString(),
    });
    expect(signals.some((s) => s.type === "leadership_change")).toBe(false);
  });
});

describe("collectSignals — news_mention (§8.5 SS-07)", () => {
  it("emits one news_mention signal per news item", () => {
    const signals = collectSignals({
      source: "company-web",
      domain: "acme.com",
      scrapedAt: new Date().toISOString(),
      newsMentions: [
        { headline: "Acme raises Series B", publishedAt: "2026-07-01", source: "techcrunch" },
        { headline: "Acme opens new office", publishedAt: "2026-07-15" },
      ],
    });

    const newsSignals = signals.filter((s) => s.type === "news_mention");
    expect(newsSignals).toHaveLength(2);
    expect(newsSignals[0]).toMatchObject({
      observedAt: "2026-07-01",
      detail: "Acme raises Series B",
      source: "techcrunch",
    });
    // falls back to the company's own scrape source when the mention has none
    expect(newsSignals[1]).toMatchObject({
      observedAt: "2026-07-15",
      detail: "Acme opens new office",
      source: "company-web",
    });
  });

  it("does not emit when newsMentions is absent", () => {
    const signals = collectSignals({
      source: "company-web",
      domain: "acme.com",
      scrapedAt: new Date().toISOString(),
    });
    expect(signals.some((s) => s.type === "news_mention")).toBe(false);
  });
});
