import { describe, expect, it } from "vitest";
import { loadCapturePage } from "./helpers/capture-dom.js";

const FILES = ["capture/extract-common.js", "capture/restriction-detect.js", "capture/company-jobs.js"];
const load = (html, url = "https://www.linkedin.com/company/acme/jobs/") =>
  loadCapturePage({ url, html, files: FILES, chrome: { runtime: { id: "t", onMessage: { addListener() {} } } } });
const reader = (html, url) => load(html, url).SkoutCompanyJobs;
const json = (value) => JSON.parse(JSON.stringify(value));

const squareCard = (id, title, location = "Austin, TX") => `
  <li class="job-card-square"><a class="job-card-square__link" href="/jobs/view/${id}/?trackingId=x">
    <span class="job-card-square__title"><strong>${title}</strong></span></a>
    <div class="job-card-container__metadata-wrapper">${location}</div></li>`;
const searchCard = (id, title, { company = "Acme", place = "Austin, TX (Hybrid)", time = "2026-11-10T09:00:00.000Z", extra = "" } = {}) => `
  <li data-occludable-job-id="${id}" class="scaffold-layout__list-item"><div class="job-card-container">
    <a class="job-card-container__link" href="/jobs/view/${id}/" aria-label="${title} with verification"><strong>${title}</strong><span class="visually-hidden">${title}</span></a>
    <div class="artdeco-entity-lockup__subtitle">${company}</div>
    <div class="artdeco-entity-lockup__caption">${place}</div>
    <time datetime="${time}">3 days ago</time><span>${extra}</span></div></li>`;

describe("job cards", () => {
  it("reads a company Jobs tab's cards with the job id and link", () => {
    const { extractJobCards } = reader(`<main>${squareCard("4010001", "Senior Engineer")}${squareCard("4010002", "Designer", "London, England")}</main>`);
    expect(json(extractJobCards())).toEqual([
      { jobId: "4010001", jobUrl: "https://www.linkedin.com/jobs/view/4010001/", title: "Senior Engineer", location: "Austin, TX", country: "United States", source: "company-jobs-tab" },
      { jobId: "4010002", jobUrl: "https://www.linkedin.com/jobs/view/4010002/", title: "Designer", location: "London, England", country: "United Kingdom", source: "company-jobs-tab" },
    ]);
  });

  it("reads job search cards: company, place, workplace type, posting date and employment type", () => {
    const { extractJobCards } = reader(`<main>${searchCard("5020001", "Data Scientist", { extra: "Full-time" })}</main>`, "https://www.linkedin.com/jobs/search/?f_C=77");
    expect(json(extractJobCards(undefined, "job-search"))).toEqual([{
      jobId: "5020001", jobUrl: "https://www.linkedin.com/jobs/view/5020001/", title: "Data Scientist", companyName: "Acme",
      location: "Austin, TX", country: "United States", workplaceType: "hybrid", employmentType: "Full-time",
      postedAt: "2026-11-10T09:00:00.000Z", postedText: "3 days ago", source: "job-search",
    }]);
  });

  it("does not double a title that LinkedIn repeats in a hidden twin, and never invents fields", () => {
    const { extractJobCards } = reader(`<main>${searchCard("5020002", "Platform Engineer", { place: "Pune, Maharashtra (Remote)", extra: "Contract" })}</main>`);
    const [job] = json(extractJobCards(undefined, "job-search"));
    expect(job).toMatchObject({
      jobId: "5020002", title: "Platform Engineer", companyName: "Acme", location: "Pune, Maharashtra", country: "India",
      workplaceType: "remote", employmentType: "Contract", postedAt: "2026-11-10T09:00:00.000Z", postedText: "3 days ago", source: "job-search",
    });
    const bare = json(reader(`<main>${squareCard("4010009", "Analyst", "")}</main>`).extractJobCards())[0];
    expect(bare).not.toHaveProperty("workplaceType");
    expect(bare).not.toHaveProperty("postedAt");
    expect(bare).not.toHaveProperty("employmentType");
  });

  it("finds one card per job, even when a job is linked twice, and ignores sidebars and other pages", () => {
    const html = `<main>${squareCard("4010001", "Engineer")}<li><a href="/jobs/view/4010001/">Engineer</a></li></main>
      <aside><a href="/jobs/view/9999999/">Promoted job</a></aside><footer><a href="/jobs/view/8888888/">Footer</a></footer>`;
    const jobs = json(reader(html).extractJobCards());
    expect(jobs.map((job) => job.jobId)).toEqual(["4010001"]);
    expect(reader(`<main><a href="/company/acme/">Acme</a><a href="/jobs/collections/">Jobs</a></main>`).extractJobCards()).toEqual([]);
  });

  it("reads LinkedIn's own result count and the company id from the all-jobs link", () => {
    const page = reader(`<main><small>1,234 results</small><a href="/jobs/search/?f_C=1441%2C9&geoId=1">See all jobs</a></main>`);
    expect(page.expectedTotal()).toBe(1234);
    expect(page.memberIdFromPage()).toBe("1441");
    expect(reader(`<main><h2>18 open jobs</h2></main>`).expectedTotal()).toBe(18);
    expect(reader(`<main><p>Jobs</p></main>`).expectedTotal()).toBeUndefined();
  });
});

describe("loading every card", () => {
  /** A page that shows 3 cards and reveals 3 more each time it is scrolled, up to `total`. */
  function lazyPage(total, { button = false } = {}) {
    const window = load(`<main><ul id="list">${[1, 2, 3].map((n) => squareCard(`60${n}0001`, `Role ${n}`)).join("")}</ul>${button ? '<button id="more">Show more jobs</button>' : ""}</main>`);
    const doc = window.document;
    let shown = 3;
    const reveal = () => {
      const next = Math.min(total, shown + 3);
      for (let n = shown + 1; n <= next; n++) doc.getElementById("list").insertAdjacentHTML("beforeend", squareCard(`60${n}0001`, `Role ${n}`));
      shown = next;
      if (button && shown >= total) doc.getElementById("more")?.remove();
    };
    if (button) doc.getElementById("more").addEventListener("click", reveal);
    else window.scrollBy = reveal;
    return window;
  }

  it("scrolls until every lazily loaded card is on the page (not just the first few)", async () => {
    const window = lazyPage(21);
    const result = await window.SkoutCompanyJobs.loadAllCards({ wait: 0, maxPasses: 40 });
    expect(result.cards).toHaveLength(21);
    expect(result.complete).toBe(true);
  });

  it("presses Show more until the list is exhausted", async () => {
    const window = lazyPage(12, { button: true });
    const result = await window.SkoutCompanyJobs.loadAllCards({ wait: 0, maxPasses: 40 });
    expect(result.cards).toHaveLength(12);
    expect(result.expanded).toBeGreaterThanOrEqual(3);
    expect(result.complete).toBe(true);
  });

  it("says so when it was cut short, instead of calling a partial list complete", async () => {
    const window = lazyPage(500);
    const result = await window.SkoutCompanyJobs.loadAllCards({ wait: 0, maxPasses: 5 });
    expect(result.cards.length).toBeGreaterThan(3);
    expect(result.complete).toBe(false);
  });
});

describe("what a page can say", () => {
  it("tells apart cards, a real empty list, a LinkedIn warning and a page that did not load", async () => {
    expect(reader(`<main>${squareCard("4010001", "Engineer")}</main>`).pageState().state).toBe("ok");
    expect(reader(`<main><p>No matching jobs found.</p></main>`).pageState().state).toBe("empty");
    expect(reader(`<main><p>Acme does not have any open jobs right now</p></main>`).pageState().state).toBe("empty");
    expect(reader(`<main></main>`).pageState().state).toBe("pending");
    expect(load(`<div>nothing</div>`).SkoutCompanyJobs.pageState().state).toBe("not_loaded");
    expect(reader(`<main><p>Something went wrong. Try refreshing the page.</p></main>`).pageState().state).toBe("not_loaded");
  });

  it("collects a page: zero is only reported for a real empty list, never for a page that did not load", async () => {
    const empty = await reader(`<main><p>No results found</p></main>`).collectJobsPage({ readyAttempts: 1 });
    expect(empty).toMatchObject({ ok: true, state: "empty", jobs: [], complete: true });
    const notLoaded = await reader(`<main></main>`).collectJobsPage({ readyAttempts: 2 });
    expect(notLoaded).toMatchObject({ ok: true, state: "not_loaded", jobs: [], complete: false });
    expect(notLoaded.notes[0]).toMatch(/did not finish loading/);
  });

  it("knows another results page follows a full page, and when the last one was reached", async () => {
    const cards = (from, count) => Array.from({ length: count }, (_, i) => searchCard(`70${from + i}0001`, `Job ${from + i}`)).join("");
    const first = await reader(`<main><small>60 results</small>${cards(1, 25)}</main>`, "https://www.linkedin.com/jobs/search/?f_C=77&start=0")
      .collectJobsPage({ source: "job-search", wait: 0, maxPasses: 6 });
    expect(first).toMatchObject({ state: "ok", hasNext: true, expectedTotal: 60 });
    expect(first.jobs).toHaveLength(25);
    const last = await reader(`<main><small>60 results</small>${cards(51, 10)}</main>`, "https://www.linkedin.com/jobs/search/?f_C=77&start=50")
      .collectJobsPage({ source: "job-search", wait: 0, maxPasses: 6 });
    expect(last.hasNext).toBe(false);
  });
});

describe("one job's page", () => {
  const page = (body) => reader(`<main>${body}</main>`, "https://www.linkedin.com/jobs/view/4010001/");
  const description = `Acme is hiring a Senior Engineer to build the billing platform.\nRequirements\n5+ years of TypeScript experience\nExperience with PostgreSQL and queues\nBenefits\nHealth insurance and a learning budget`;

  it("reads the description, the requirements under their heading, and the facts around it", () => {
    const detail = json(page(`<div class="jobs-unified-top-card"><div class="job-details-jobs-unified-top-card__primary-description"><span>Austin, TX · 3 days ago</span></div>
      <div class="job-details-jobs-unified-top-card__job-insight"><span>Hybrid</span><span>Full-time</span></div><time datetime="2026-11-10T09:00:00.000Z">3 days ago</time></div>
      <div id="job-details">${description.split("\n").map((line) => `<p>${line}</p>`).join("")}</div>
      <section><h3>Job function</h3><span>Engineering</span></section>`).parseJobDetail());
    expect(detail.description).toContain("billing platform");
    expect(detail.requirements).toBe("5+ years of TypeScript experience\nExperience with PostgreSQL and queues");
    expect(detail).toMatchObject({ department: "Engineering", employmentType: "Full-time", workplaceType: "hybrid", postedAt: "2026-11-10T09:00:00.000Z" });
  });

  it("reports no requirements when the posting has no such section, and nothing when there is no description", () => {
    const detail = json(page(`<div id="job-details"><p>Join our team and help us grow the company across many exciting areas.</p></div>`).parseJobDetail());
    expect(detail.description).toBeTruthy();
    expect(detail.requirements).toBeUndefined();
    expect(json(page(`<p>Loading</p>`).parseJobDetail()).description).toBeUndefined();
  });

  it("reads the lines under a heading only until the next heading", () => {
    const { requirementsFrom } = reader(`<main></main>`);
    expect(requirementsFrom("What you'll need:\nTypeScript\nPostgres\nAbout us\nWe are Acme.")).toBe("TypeScript\nPostgres");
    expect(requirementsFrom("Nothing relevant here at all")).toBeUndefined();
    expect(requirementsFrom(undefined)).toBeUndefined();
  });

  it("expands the description's See more once, then reads it", async () => {
    const window = load(`<main><div id="job-details"><p>Short intro to the role.</p><button aria-label="See more">See more</button></div></main>`, "https://www.linkedin.com/jobs/view/4010001/");
    const doc = window.document;
    doc.querySelector("button").addEventListener("click", () => doc.getElementById("job-details").insertAdjacentHTML("beforeend", "<p>Requirements</p><p>Five years of experience building and operating production systems</p>"));
    const result = await window.SkoutCompanyJobs.collectJobDetail({ readyAttempts: 1 });
    expect(result.state).toBe("ok");
    expect(result.detail.requirements).toContain("Five years of experience");
  });
});
