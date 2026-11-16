import { describe, expect, it } from "vitest";
import { loadCapturePage } from "./helpers/capture-dom.js";
import { normalizeWebsiteInput, parseCountInput } from "../capture-panel.js";

const FILES = ["capture/extract-common.js", "capture/company-sections.js", "capture/page-extract.js"];
const wrapped = (url) => `https://www.linkedin.com/redir/redirect?url=${encodeURIComponent(url)}&urlhash=abc&trk=profile`;
const json = (value) => JSON.parse(JSON.stringify(value));

describe("person website from Contact info", () => {
  const page = (dialog) => loadCapturePage({
    url: "https://www.linkedin.com/in/jane-doe/",
    html: `<main><h1>Jane Doe</h1><p>2,300 followers</p><div role="dialog"><h2>Contact info</h2>${dialog}</div></main>`,
    files: FILES,
  });

  it("reads the portfolio, unwrapping LinkedIn's redirect link, and keeps the other links", () => {
    const person = page(`
      <section><h3>Website</h3>
        <div><a href="${wrapped("https://acme.example/careers?utm_source=x")}">acme.example/careers</a> <span>(Company Website)</span></div>
        <div><a href="${wrapped("https://jane.dev/work?utm_medium=y#top")}">jane.dev</a> <span>(Portfolio)</span></div>
        <div><a href="https://blog.jane.dev">blog.jane.dev</a></div>
        <div><a href="https://www.linkedin.com/in/jane-doe/">linkedin.com/in/jane-doe</a></div>
      </section>`).SkoutCapturePage.extractPerson();
    expect(person.website).toBe("https://jane.dev/work");
    expect(json(person.websites)).toEqual([
      { url: "https://acme.example/careers", label: "Company Website" },
      { url: "https://jane.dev/work", label: "Portfolio" },
      { url: "https://blog.jane.dev" },
    ]);
    expect(person.followersCount).toBe(2300);
  });

  it("never uses the employer's website as the person's own", () => {
    const person = page(`<section><div><a href="https://acme.example">acme.example</a> <span>(Company Website)</span></div></section>`)
      .SkoutCapturePage.extractPerson();
    expect(person.website).toBeUndefined();
    expect(json(person.websites)).toEqual([{ url: "https://acme.example", label: "Company Website" }]);
  });

  it("ignores mailto, tel and non-web links", () => {
    const person = page(`<a href="mailto:jane@example.com">jane@example.com</a><a href="tel:+15550100">call</a><a href="javascript:alert(1)">x</a>`)
      .SkoutCapturePage.extractPerson();
    expect(person.website).toBeUndefined();
    expect(person.websites).toBeUndefined();
  });
});

describe("company website and followers", () => {
  it("unwraps the Visit website redirect so the domain is the company's, not LinkedIn's", () => {
    const window = loadCapturePage({
      url: "https://www.linkedin.com/company/phonepe-internet/home/",
      html: `<main><h1>PhonePe</h1><p>Financial Services</p><p>1.7M followers</p>
        <div class="org-top-card-primary-actions"><a href="${wrapped("https://www.phonepe.com/?trk=x")}">Visit website</a></div></main>`,
      files: FILES,
    });
    const company = window.SkoutCapturePage.extractCompany();
    expect(company.website).toBe("https://www.phonepe.com/");
    expect(company.domain).toBe("phonepe.com");
  });
});

describe("cleanWebsite", () => {
  const { cleanWebsite } = loadCapturePage({ url: "https://www.linkedin.com/in/x/", html: "<main></main>", files: FILES }).SkoutCaptureExtract;
  it("keeps only real web addresses", () => {
    expect(cleanWebsite("acme.example/path?utm_campaign=1&a=2")).toBe("https://acme.example/path?a=2");
    expect(cleanWebsite("http://acme.example/")).toBe("http://acme.example/");
    expect(cleanWebsite("https://www.linkedin.com/company/acme/")).toBeUndefined();
    expect(cleanWebsite("javascript:alert(1)")).toBeUndefined();
    expect(cleanWebsite("mailto:a@b.co")).toBeUndefined();
    expect(cleanWebsite("localhost")).toBeUndefined();
    expect(cleanWebsite("")).toBeUndefined();
  });
});

describe("review dialog inputs", () => {
  it("parses follower counts", () => {
    expect(parseCountInput("2,300")).toEqual({ value: 2300 });
    expect(parseCountInput("1.2K")).toEqual({ value: 1200 });
    expect(parseCountInput("1.7M followers")).toEqual({ value: 1_700_000 });
    expect(parseCountInput("  ")).toEqual({ empty: true });
    expect(parseCountInput("lots")).toHaveProperty("error");
    expect(parseCountInput("-5")).toHaveProperty("error");
    expect(parseCountInput("9999999999")).toHaveProperty("error");
  });

  it("normalizes website addresses and rejects bad ones", () => {
    expect(normalizeWebsiteInput("jane.dev")).toEqual({ value: "https://jane.dev" });
    expect(normalizeWebsiteInput(" http://jane.dev/work/ ")).toEqual({ value: "http://jane.dev/work/" });
    expect(normalizeWebsiteInput("")).toEqual({ empty: true });
    expect(normalizeWebsiteInput("not a site")).toHaveProperty("error");
    expect(normalizeWebsiteInput("ftp://jane.dev")).toHaveProperty("error");
    expect(normalizeWebsiteInput("https://www.linkedin.com/in/jane")).toHaveProperty("error");
    expect(normalizeWebsiteInput("localhost")).toHaveProperty("error");
  });
});
