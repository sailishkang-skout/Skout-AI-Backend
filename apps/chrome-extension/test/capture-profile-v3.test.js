import { afterEach, describe, expect, it } from "vitest";
import { loadCapturePage } from "./helpers/capture-dom.js";
import { RUN_QUEUE_KEY, __test, captureQueueReport, handleCaptureMessage, timing } from "../capture-background.js";

timing.delay = () => Promise.resolve();
const FILES = ["capture/extract-common.js", "capture/company-sections.js", "capture/page-extract.js"];
const wrapped = (url) => `https://www.linkedin.com/redir/redirect?url=${encodeURIComponent(url)}&urlhash=x`;
const person = (html, url = "https://www.linkedin.com/in/jane-doe/") =>
  loadCapturePage({ url, html, files: FILES }).SkoutCapturePage.extractPerson();
const json = (value) => JSON.parse(JSON.stringify(value));
const previousChrome = globalThis.chrome;
afterEach(() => { globalThis.chrome = previousChrome; });

describe("website from Contact info", () => {
  it("reads a Contact info page that lists only a website (no email or phone)", () => {
    const jane = person(`<main><h1>Jane Doe</h1></main>
      <div class="overlay"><h2>Contact info</h2>
        <section><h3>Jane’s Profile</h3><a href="https://www.linkedin.com/in/jane-doe">linkedin.com/in/jane-doe</a></section>
        <section><h3>Website</h3><div><a href="${wrapped("https://jane.design")}">jane.design</a> <span>(Portfolio)</span></div></section>
      </div>`, "https://www.linkedin.com/in/jane-doe/overlay/contact-info/");
    expect(jane.website).toBe("https://jane.design/");
    expect(json(jane.websites)).toEqual([{ url: "https://jane.design/", label: "Portfolio" }]);
  });

  it("falls back to a website shown in the profile header when there is no Contact info", () => {
    const jane = person(`<main><section id="profile-Topcard"><h1>Jane Doe</h1><p>Designer</p>
      <a href="${wrapped("https://jane.design/work")}">jane.design/work</a></section></main>`);
    expect(jane.website).toBe("https://jane.design/work");
  });
});

describe("current company and title", () => {
  const top = (extra, headline = "Senior Engineer at Uber") =>
    `<main><section id="profile-Topcard"><h1>Jane Doe</h1><p>${headline}</p>${extra}</section></main>`;

  it("drops LinkedIn's \"+ 1 more\" from the header's company", () => {
    const jane = person(top(`<a href="/company/uber/"><span>Uber + 1 more</span></a>`));
    expect(jane.currentCompanies[0]).toMatchObject({ name: "Uber", title: "Senior Engineer", companyPublicId: "uber" });
  });

  it.each([
    ["Senior Engineer @ Uber", "Senior Engineer"],
    ["Senior Engineer | Uber", "Senior Engineer"],
    ["Senior Engineer - Uber · Ex-Google", "Senior Engineer"],
    ["Senior Engineer, Uber", "Senior Engineer"],
    ["Senior Engineer at Uber Technologies Inc.", undefined],
    ["Helping teams ship faster", undefined],
  ])("reads the title from the headline %s", (headline, title) => {
    const jane = person(top(`<a href="/company/uber/"><span>Uber</span></a>`, headline));
    expect(jane.currentCompanies[0].title).toBe(title);
  });

  it("puts the employer the header names first when Experience lists several current roles", () => {
    const experience = `<div componentkey="profile.ExperienceTopLevelSection">
      <div componentkey="entity-collection-item-1"><p>Advisor</p><p>Side Co · Part-time</p><p>2023 - Present</p></div>
      <div componentkey="entity-collection-item-2"><p>Staff Engineer</p><p>Uber · Full-time</p><p>2021 - Present</p></div>
    </div>`;
    const jane = person(top(`<a href="/company/uber/"><span>Uber + 1 more</span></a>`, "Staff Engineer at Uber").replace("</main>", `${experience}</main>`));
    expect(jane.currentCompanies.map((role) => [role.name, role.title])).toEqual([["Uber", "Staff Engineer"], ["Side Co", "Advisor"]]);
  });
});

describe("company website from a Website label", () => {
  it("reads the link next to a Website label in a new About layout", () => {
    const company = loadCapturePage({
      url: "https://www.linkedin.com/company/acme/about/",
      html: `<main><h1>Acme</h1><section><div><h3>Website</h3></div><div><a href="${wrapped("https://www.acme.example/")}">acme.example</a></div></section></main>`,
      files: FILES,
    }).SkoutCapturePage.extractCompany();
    expect(company.website).toBe("https://www.acme.example/");
  });
});

describe("dashboard sync", () => {
  it("reports what a saved batch did: added, duplicates, refused", () => {
    expect(captureQueueReport("Acme", { pagesRead: 25, distinctCandidates: 240, complete: false }, { created: 200, merged: 38, rejected: 2 }))
      .toEqual({ companyName: "Acme", pagesRead: 25, peopleFound: 240, complete: false, created: 200, merged: 38, rejected: 2 });
    expect(captureQueueReport(undefined, { pagesRead: 1, complete: true }, { created: -1, merged: "x" })).toEqual({ pagesRead: 1, peopleFound: 0, complete: true });
  });

  it("drops a job cancelled in the workspace and moves on to the next company", async () => {
    const store = {};
    const sent = [];
    let url = "";
    globalThis.chrome = {
      runtime: { id: "t" },
      tabs: {
        async create({ url: next }) { url = next; return { id: 50 }; },
        async get(id) { return { id, url, status: "complete" }; },
        async update(_id, props) { url = props.url; },
        async remove() {},
        async sendMessage(_id, message) { sent.push(message.type); return { ok: true, kind: "company" }; },
      },
      storage: { local: {
        async get(keys) { return keys === null ? { ...store } : Object.fromEntries([].concat(keys).map((key) => [key, store[key]])); },
        async set(values) { Object.assign(store, values); },
        async remove(keys) { for (const key of [].concat(keys)) delete store[key]; },
      } },
    };
    let cancelAlpha = false;
    __test.deps.skoutFetch = async (path) => {
      if (path.endsWith("/capture/queue/sync")) return { updated: 1, cancelled: cancelAlpha ? ["alpha"] : [] };
      return { enabled: true, caps: { dailyLeadLimit: 1000 }, usage: { remainingToday: 1000 } };
    };
    await handleCaptureMessage({ type: "capture-queue-start", companies: [{ companyPublicId: "alpha", name: "Alpha" }, { companyPublicId: "beta", name: "Beta" }] }, {});
    const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
    await tick();
    expect(store[RUN_QUEUE_KEY].items.map((item) => item.status)).toEqual(["running", "pending"]);
    cancelAlpha = true;
    // Any queue change reports to the server, which answers that alpha is cancelled.
    await handleCaptureMessage({ type: "SKOUT_CAPTURE_PROGRESS", kind: "company", active: true, text: "Reading" }, { tab: { id: 50 } });
    await handleCaptureMessage({ type: "capture-queue-start", companies: [{ companyPublicId: "gamma", name: "Gamma" }] }, {});
    await tick(); await tick();
    const items = Object.fromEntries(store[RUN_QUEUE_KEY].items.map((item) => [item.companyPublicId, item]));
    expect(items.alpha).toMatchObject({ status: "skipped", error: "Cancelled in the workspace." });
    expect(sent).toContain("SKOUT_CAPTURE_STOP");
    expect(items.beta.status).toBe("running");
  });
});
