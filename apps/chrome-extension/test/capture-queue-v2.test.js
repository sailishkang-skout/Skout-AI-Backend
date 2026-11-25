import { afterEach, describe, expect, it } from "vitest";
import { loadCapturePage } from "./helpers/capture-dom.js";
import { CAPTURE_DRAFT_KEY, RUN_QUEUE_KEY, __test, handleCaptureMessage, timing } from "../capture-background.js";

timing.delay = () => Promise.resolve();
const FILES = ["capture/extract-common.js", "capture/company-sections.js", "capture/page-extract.js"];
const json = (value) => JSON.parse(JSON.stringify(value));
const previousChrome = globalThis.chrome;
afterEach(() => { globalThis.chrome = previousChrome; });

describe("country from a place", () => {
  const { countryFromPlace } = loadCapturePage({ url: "https://www.linkedin.com/company/x/", html: "<main></main>", files: FILES }).SkoutCaptureExtract;

  it.each([
    ["Mumbai, Maharashtra, India", "India"],
    ["Bengaluru, Karnataka", "India"],
    ["Gurugram, Haryana", "India"],
    ["Greater Bengaluru Area", "India"],
    ["Austin, TX", "United States"],
    ["Austin, Texas", "United States"],
    ["Seattle, WA", "United States"],
    ["Atlanta, Georgia", "United States"],
    ["San Francisco Bay Area", "United States"],
    ["New York, NY", "United States"],
    ["Toronto, ON", "Canada"],
    ["Toronto, Ontario", "Canada"],
    ["Sydney, NSW", "Australia"],
    ["London", "United Kingdom"],
    ["London, England", "United Kingdom"],
    ["Dubai, UAE", "United Arab Emirates"],
    ["Amsterdam, North Holland", "Netherlands"],
    ["Berlin, Germany", "Germany"],
    ["Singapore", "Singapore"],
  ])("%s -> %s", (place, country) => {
    expect(countryFromPlace(place)).toBe(country);
  });

  it("does not guess from a bare code, an unknown place or nothing", () => {
    expect(countryFromPlace("CA")).toBeUndefined();
    expect(countryFromPlace("Remote")).toBeUndefined();
    expect(countryFromPlace("Somewhereville")).toBeUndefined();
    expect(countryFromPlace("")).toBeUndefined();
    expect(countryFromPlace(undefined)).toBeUndefined();
  });
});

describe("company details", () => {
  const company = (html, url = "https://www.linkedin.com/company/acme/") =>
    loadCapturePage({ url, html, files: FILES }).SkoutCapturePage.extractCompany();
  const wrapped = (url) => `/redir/redirect/?url=${encodeURIComponent(url)}&urlhash=x`;

  it("reads a website from a relative LinkedIn redirect link", () => {
    const { cleanWebsite } = loadCapturePage({ url: "https://www.linkedin.com/company/acme/", html: "<main></main>", files: FILES }).SkoutCaptureExtract;
    expect(cleanWebsite(wrapped("https://acme.example/?utm_source=li"))).toBe("https://acme.example/");
    expect(cleanWebsite("/company/acme/")).toBeUndefined();
    expect(cleanWebsite("acme.example")).toBe("https://acme.example");
  });

  it("finds the Visit website button by its accessible name in the new top card", () => {
    const acme = company(`<main><h1>Acme</h1><a aria-label="Visit website for Acme" href="${wrapped("https://www.acme.example/")}"><span></span></a></main>`);
    expect(acme.website).toBe("https://www.acme.example/");
    expect(acme.domain).toBe("acme.example");
  });

  it("reads the About tab's Website link, and the country from the headquarters", () => {
    const acme = company(`<main><h1>Acme</h1><dl>
      <dt>Website</dt><dd><a href="${wrapped("https://acme.example")}">acme.example</a></dd>
      <dt>Headquarters</dt><dd>Pune, Maharashtra</dd></dl></main>`, "https://www.linkedin.com/company/acme/about/");
    expect(acme.website).toBe("https://acme.example/");
    expect(acme.headquarter).toBe("Pune, Maharashtra");
    expect(acme.locationCountry).toBe("India");
  });

  it("takes the company's LinkedIn id only from its own associated-members link", () => {
    const own = company(`<main><h1>Acme</h1><a href="/search/results/people/?currentCompany=%5B%221441%22%5D">1,141 associated members</a></main>`);
    expect(own.memberId).toBe("1441");
    const sidebar = company(`<main><h1>Acme</h1></main><aside><a href="/search/results/people/?currentCompany=%5B%229999%22%5D">People at Other Co</a></aside>`);
    expect(sidebar.memberId).toBeUndefined();
  });

  it("gives a person a country from a two-part location", () => {
    const person = loadCapturePage({
      url: "https://www.linkedin.com/in/jane/",
      html: `<main><section id="profile-Topcard"><h1>Jane</h1><p>Engineer</p><p>Pune, Maharashtra</p></section></main>`,
      files: FILES,
    }).SkoutCapturePage.extractPerson();
    expect(person.locationCountry).toBe("India");
  });
});

describe("people search results reader", () => {
  const reader = (html, url = "https://www.linkedin.com/search/results/people/?currentCompany=%5B%221441%22%5D&page=3") =>
    loadCapturePage({
      url,
      html,
      files: ["capture/extract-common.js", "capture/company-people-search.js"],
      chrome: { runtime: { id: "t", onMessage: { addListener() {} } } },
    }).SkoutCompanyPeopleSearch;
  const card = (n) => `<div data-chameleon-result-urn="urn:li:member:${n}">
      <a href="https://www.linkedin.com/in/person-${n}/?miniProfileUrn=x"><span aria-hidden="true">Person ${n}</span><span class="visually-hidden">View Person ${n}’s profile</span></a>
      <p>Engineer at Acme</p><button>Connect</button></div>`;

  it("reads every card of the new layout with its visible name and headline", () => {
    const people = [...reader(`<main>${[1, 2, 3].map(card).join("")}</main>`).collect().values()];
    expect(json(people)).toEqual([1, 2, 3].map((n) => ({
      publicId: `person-${n}`, sourceUrl: `https://www.linkedin.com/in/person-${n}/`, fullName: `Person ${n}`, headline: "Engineer at Acme", associationSource: "company-search-result",
    })));
  });

  it("knows a full page has a next page, and opens it by address", async () => {
    const page = reader(`<main>${Array.from({ length: 10 }, (_, i) => card(i)).join("")}</main>`);
    const result = await page.readPage();
    expect(result).toMatchObject({ ok: true, page: 3, hasNext: true });
    expect(result.peopleProfiles).toHaveLength(10);
    expect(page.nextPageUrl()).toBe("https://www.linkedin.com/search/results/people/?currentCompany=%5B%221441%22%5D&page=4");
  });

  it("ends the search on a page with no results", async () => {
    const result = await reader("<main><h2>No results found</h2></main>").readPage();
    expect(result).toMatchObject({ ok: true, peopleProfiles: [], hasNext: false });
  });

  it("ignores profile links outside the results (sidebar)", () => {
    const people = reader(`<main>${card(1)}</main><aside><li><a href="/in/ad-person/"><span aria-hidden="true">Ad Person</span></a></li></aside>`).collect();
    expect([...people.keys()]).toEqual(["person-1"]);
  });
});

describe("queue: empty, already-saved and automatic batches", () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
  function browser({ ingest } = {}) {
    const store = {};
    const api = [];
    let url = "";
    globalThis.chrome = {
      runtime: { id: "test-extension" },
      tabs: {
        async create({ url: next }) { url = next; return { id: 50 }; },
        async get(id) { return { id, url, status: "complete" }; },
        async update(_id, props) { url = props.url; },
        async remove() {},
        async sendMessage() { return { ok: true, kind: "company" }; },
      },
      storage: { local: {
        async get(keys) { return keys === null ? { ...store } : Object.fromEntries([].concat(keys).map((key) => [key, store[key]])); },
        async set(values) { Object.assign(store, values); },
        async remove(keys) { for (const key of [].concat(keys)) delete store[key]; },
      } },
    };
    __test.deps.skoutFetch = async (path, options = {}) => {
      api.push({ path, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined });
      if (path.includes("/ingest/company")) {
        if (ingest) return ingest();
        const body = JSON.parse(options.body);
        return { run: { status: "completed", terminal: true }, created: body.peopleProfiles?.length || 0, merged: 0, rejected: 0 };
      }
      if (path.endsWith("/capture/auto") && options.method === "POST") return { queued: ["alpha"], skipped: [{ companyPublicId: "zzz", reason: "Capture this company first" }] };
      if (path.endsWith("/capture/auto")) return { available: true, reason: null, accountName: "Owner LinkedIn" };
      return { enabled: true, caps: { dailyLeadLimit: 1000 }, usage: { remainingToday: 1000 } };
    };
    const review = (id, peopleProfiles, extra = {}) => handleCaptureMessage({
      type: "SKOUT_CAPTURE_REVIEW", kind: "company", sourceUrl: `https://www.linkedin.com/company/${id}/`,
      data: { publicId: id, name: id.toUpperCase(), sourceUrl: `https://www.linkedin.com/company/${id}/`, peopleProfiles, ...extra },
    }, { tab: { id: 50 } });
    const statuses = () => Object.fromEntries(store[RUN_QUEUE_KEY].items.map((item) => [item.companyPublicId, item.status]));
    return { store, api, review, statuses };
  }
  const person = (id) => ({ publicId: id, sourceUrl: `https://www.linkedin.com/in/${id}/`, fullName: id });
  const start = (extra = {}) => handleCaptureMessage({ type: "capture-queue-start", workflow: false, companies: [{ companyPublicId: "alpha", name: "Alpha" }, { companyPublicId: "beta", name: "Beta" }], ...extra }, {});

  it("retries a company whose batch has no people once, then fails it and moves on", async () => {
    const env = browser();
    await start();
    await tick();
    env.store["company-people-capture:alpha"] = { draft: { token: "t", profiles: [], pagesRead: 25 } };
    await env.review("alpha", []);
    await tick();
    // No review is waiting, the stale empty page cursor is gone, and alpha is tried again.
    expect(env.store[CAPTURE_DRAFT_KEY]).toBeUndefined();
    expect(env.store["company-people-capture:alpha"].draft).toBeUndefined();
    expect(env.statuses()).toEqual({ alpha: "running", beta: "pending" });
    await env.review("alpha", []);
    await tick();
    expect(env.statuses()).toEqual({ alpha: "failed", beta: "running" });
    expect(env.store[RUN_QUEUE_KEY].items[0].error).toMatch(/no people for this company/);
  });

  it("moves past pages whose people are all saved already, instead of calling the company empty", async () => {
    const env = browser();
    await start({ untilComplete: true });
    await tick();
    env.store["company-people-capture:alpha"] = {
      searchKey: '["1"]', searchUrl: "https://www.linkedin.com/search/results/people/?currentCompany=%5B%221%22%5D",
      draft: { token: "t2", profiles: [person("a1")], pagesRead: 25, complete: false, resumeUrl: "https://www.linkedin.com/search/results/people/?currentCompany=%5B%221%22%5D&page=26" },
    };
    await env.review("alpha", [], { _captureCheckpointToken: "t2", _captureStats: { discovered: 250, alreadyCaptured: 250 } });
    await tick();
    expect(env.store["company-people-capture:alpha"].committed).toMatchObject({ pagesRead: 25, complete: false });
    // Still pages left and "keep reading" is on: alpha is read again from page 26.
    expect(env.statuses()).toEqual({ alpha: "running", beta: "pending" });
    expect(env.api.some((call) => call.path.endsWith("/capture/queue/alpha") && call.method === "PUT")).toBe(true);
  });

  it("saves each batch by itself in automatic mode and goes on to the next company", async () => {
    const env = browser();
    await start({ autoSave: true });
    await tick();
    await env.review("alpha", [person("a1"), person("a2")]);
    await tick(); await tick();
    expect(env.api.filter((call) => call.path.includes("/ingest/company"))).toHaveLength(1);
    expect(env.store[CAPTURE_DRAFT_KEY]).toBeUndefined();
    expect(env.statuses()).toEqual({ alpha: "done", beta: "running" });
    expect(env.store[RUN_QUEUE_KEY].items[0].saved).toBe(2);
  });

  it("stops an automatic queue at the daily limit and keeps the batch for later", async () => {
    const env = browser({ ingest: () => { throw Object.assign(new Error("Daily capture limit of 1000 leads reached."), { body: {} }); } });
    await start({ autoSave: true });
    await tick();
    await env.review("alpha", [person("a1")]);
    await tick(); await tick();
    expect(env.store[RUN_QUEUE_KEY]).toMatchObject({ active: false });
    expect(env.store[RUN_QUEUE_KEY].note).toMatch(/Daily capture limit/);
    expect(env.store[CAPTURE_DRAFT_KEY]).toBeTruthy();
  });

  it("discarding a batch forgets its unsaved page cursor", async () => {
    const env = browser();
    await start();
    await tick();
    env.store["company-people-capture:alpha"] = { committed: { pagesRead: 25 }, draft: { token: "t", profiles: [person("a1")], pagesRead: 25 } };
    await env.review("alpha", [person("a1")]);
    await handleCaptureMessage({ type: "capture-discard" }, {});
    expect(env.store["company-people-capture:alpha"]).toEqual({ committed: { pagesRead: 25 }, draft: undefined });
  });

  it("hands the content script the people search saved by an earlier run", async () => {
    const env = browser();
    env.store["company-people-capture:alpha"] = { searchUrl: "https://www.linkedin.com/search/results/people/?currentCompany=%5B%221%22%5D" };
    expect(await handleCaptureMessage({ type: "GET_SAVED_PEOPLE_SEARCH", companyId: "alpha" }, { tab: { id: 50 } }))
      .toEqual({ ok: true, url: "https://www.linkedin.com/search/results/people/?currentCompany=%5B%221%22%5D" });
    expect((await handleCaptureMessage({ type: "GET_SAVED_PEOPLE_SEARCH", companyId: "nobody" }, { tab: { id: 50 } })).url).toBeUndefined();
  });

  it("starts automatic capture on the server and reports what was skipped", async () => {
    const env = browser();
    expect(await handleCaptureMessage({ type: "capture-auto-status" }, {})).toEqual({ ok: true, available: true, reason: null, accountName: "Owner LinkedIn" });
    const result = await handleCaptureMessage({ type: "capture-auto-start", companyPublicIds: ["alpha", "zzz", "../bad"] }, {});
    expect(result).toEqual({ ok: true, queued: ["alpha"], skipped: [{ companyPublicId: "zzz", reason: "Capture this company first" }] });
    expect(env.api.at(-1)).toMatchObject({ path: "/api/v1/enrichment/capture/auto", method: "POST", body: { companyPublicIds: ["alpha", "zzz"] } });
    expect(handleCaptureMessage({ type: "capture-auto-start", companyPublicIds: ["alpha"] }, { tab: { id: 7 } })).toBeUndefined();
  });
});
