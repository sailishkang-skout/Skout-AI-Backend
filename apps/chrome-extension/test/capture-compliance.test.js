import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { CAPTURE_CONTENT_FILES } from "../capture-background.js";
import { captureKindForUrl, draftSummary, reviewedData } from "../capture-panel.js";
import { extensionRoot, readSource } from "./helpers/capture-dom.js";

const manifest = JSON.parse(readSource("manifest.json"));
const captureScripts = readdirSync(resolve(extensionRoot, "capture")).map((file) => `capture/${file}`);
const shippedSources = [...captureScripts, "capture-background.js", "capture-panel.js", "background.js", "linkedin-scrape.js"];

describe("capture compliance guardrails", () => {
  it("declares every capture reader once, in load order, on LinkedIn only", () => {
    const entry = manifest.content_scripts.find((script) => script.js.includes("capture/capture-content.js"));
    expect(entry.matches).toEqual(["https://www.linkedin.com/*"]);
    expect(entry.js).toEqual(CAPTURE_CONTENT_FILES);
    expect([...captureScripts].sort()).toEqual([...CAPTURE_CONTENT_FILES].sort());
  });

  it("keeps LinkedIn outreach unwired", () => {
    const wired = [
      JSON.stringify(manifest),
      readSource("background.js"),
      readSource("vite.config.js"),
      readSource("scripts/package-chrome-extension.mjs"),
      readSource("content-script.js"),
      readSource("panel-app.js"),
    ].join("\n");
    expect(wired).not.toMatch(/linkedin-outreach/);
  });

  it("uses no hidden or private LinkedIn API and makes no network request from a LinkedIn page", () => {
    for (const file of shippedSources) {
      const source = readSource(file);
      expect(source, file).not.toMatch(/voyager|\/sales-api\/|csrf-token|JSESSIONID|li_at/i);
    }
    for (const file of captureScripts) {
      const source = readSource(file);
      expect(source, file).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource/);
    }
  });

  it("never sets filters, submits searches or sends messages", () => {
    for (const file of captureScripts) {
      const source = readSource(file);
      // No form submission, no typed input, no synthetic key or input events.
      expect(source, file).not.toMatch(/\.submit\s*\(|requestSubmit|\.value\s*=[^=]|dispatchEvent|KeyboardEvent|InputEvent|execCommand/);
      expect(source, file).not.toMatch(/messaging|\/msg\/|invite|connect-button|InMail/i);
    }
    // Every click a reader makes is one of: next results page, a profile's own "show more
    // skills", or opening the lead actions menu to read the link LinkedIn shows there.
    const clicks = captureScripts.flatMap((file) =>
      [...readSource(file).matchAll(/(\w+)(?:\(\))?\.click\(\)/g)].map((match) => `${file}:${match[1]}`)
    );
    expect(clicks.sort()).toEqual([
      "capture/company-people-search.js:next",
      "capture/person-capture.js:showMore",
      "capture/sales-lead-link-reader.js:button",
      "capture/sales-navigator-capture.js:nextButton",
    ]);
  });

  it("reads rendered content only in the existing profile scraper", () => {
    const source = readSource("linkedin-scrape.js");
    expect(source).not.toMatch(/innerHTML|ld\+json|publicIdentifier|JSON\.parse/);
  });
});

describe("side-panel review helpers", () => {
  it("offers a capture only on a profile, a company page or a Sales Navigator people search", () => {
    expect(captureKindForUrl("https://www.linkedin.com/in/jane-doe/")).toBe("person");
    expect(captureKindForUrl("https://www.linkedin.com/company/acme/people/")).toBe("company");
    expect(captureKindForUrl("https://www.linkedin.com/sales/search/people?query=x")).toBe("sales");
    expect(captureKindForUrl("https://www.linkedin.com/feed/")).toBeNull();
    expect(captureKindForUrl("https://www.linkedin.com/sales/lead/abc")).toBeNull();
    expect(captureKindForUrl("https://evil.example/in/jane-doe/")).toBeNull();
  });

  it("removes the leads the reviewer unticked and summarizes what is left", () => {
    const data = {
      pagesRead: 2,
      peopleProfiles: [
        { publicId: "real-1", sourceUrl: "https://www.linkedin.com/in/real-1/" },
        { publicId: "sales-lead:x", sourceUrl: "https://www.linkedin.com/sales/lead/x,NAME_SEARCH,y" },
      ],
    };
    const kept = reviewedData(data, new Set(["sales-lead:x"]));
    expect(kept.peopleProfiles.map((profile) => profile.publicId)).toEqual(["real-1"]);
    expect(draftSummary("sales", data)).toBe("2 leads from 2 page(s) · 1 with a public LinkedIn link, 1 Sales Navigator only");
  });
});

describe("capture progress", () => {
  it("stops treating a silent reader as running", async () => {
    const { isProgressActive } = await import("../capture-panel.js");
    const background = await import("../capture-background.js");
    const now = Date.now();
    for (const isActive of [isProgressActive, background.isProgressActive]) {
      expect(isActive({ active: true, at: now - 5_000 }, now)).toBe(true);
      expect(isActive({ active: true, at: now - 4 * 60_000 }, now)).toBe(false);
      expect(isActive({ active: false, at: now }, now)).toBe(false);
      expect(isActive(null, now)).toBe(false);
    }
  });
});
