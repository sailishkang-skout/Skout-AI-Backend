import { describe, expect, it } from "vitest";
import { loadCapturePage } from "./helpers/capture-dom.js";

const FILES = ["capture/extract-common.js", "capture/company-sections.js", "capture/page-extract.js", "capture/restriction-detect.js", "capture/capture-ui.js", "capture/capture-verify.js", "capture/company-capture.js"];
const ROOT = "https://www.linkedin.com/company/acme/";
const HTML = `<main><h1>Acme</h1><a href="/search/results/people/?currentCompany=%5B%221441%22%5D">1,141 associated members</a></main>`;
const people = (n, from = 1) => Array.from({ length: n }, (_, i) => ({ publicId: `p-${from + i}`, sourceUrl: `https://www.linkedin.com/in/p-${from + i}/`, fullName: `Person ${from + i}`, associationSource: "company-people-page" }));
const scan = (extra = {}) => ({ clientScanId: "scan-12345678", status: "completed", passes: [{ pass: 1, found: 2, complete: true }, { pass: 2, found: 2, complete: true }], jobs: [{ title: "Engineer" }, { title: "Designer" }], notes: [], ...extra });

/** Runs a company capture where each message the capture sends is answered by `answers[type]`. */
async function capture(answers, options = { includeCompany: true, includePeople: true }, html = HTML) {
  const sent = [];
  const chrome = {
    runtime: {
      id: "t", lastError: undefined, onMessage: { addListener() {} },
      sendMessage(message, callback) {
        sent.push(message);
        const answer = answers[message.type];
        const result = typeof answer === "function" ? answer(message, sent.filter((entry) => entry.type === message.type).length) : answer;
        if (result instanceof Error) return callback({ ok: false, error: result.message });
        return callback(result ?? { ok: true });
      },
    },
  };
  const window = loadCapturePage({ url: ROOT, html, chrome, files: FILES });
  window.setTimeout = (callback) => { callback(); return 0; };
  await window.SkoutCompanyCapture.start(options);
  const review = sent.find((entry) => entry.type === "SKOUT_CAPTURE_REVIEW");
  return { sent, review, data: review?.data, notes: review?.notes || [] };
}
const page = (data = {}) => ({ ok: true, data: { publicId: "acme", name: "Acme", sourceUrl: ROOT, industry: "Software", headquarter: "Austin, TX", size: "51-200", website: "https://acme.example", overview: "Acme builds things.", ...data }, links: [], warnings: [] });
const base = {
  READ_COMPANY_PAGE: () => page(),
  GET_SAVED_PEOPLE_SEARCH: { ok: true, url: undefined },
  GET_CAPTURED_COMPANY_PROFILE_IDS: { ok: true, data: { publicIds: [] } },
  SCAN_COMPANY_JOBS: { ok: true, scan: scan() },
  READ_COMPANY_PEOPLE_DIRECTORY: { ok: true, peopleProfiles: [], warnings: [] },
  READ_COMPANY_PEOPLE_SEARCH: { ok: true, peopleProfiles: [], complete: true, warnings: [] },
};
const count = (sent, type) => sent.filter((entry) => entry.type === type).length;

describe("company people: sources, fallback and a second scan", () => {
  it("merges the People page and the company people search, and verifies both", async () => {
    const { data, sent } = await capture({ ...base, READ_COMPANY_PEOPLE_DIRECTORY: { ok: true, peopleProfiles: people(3), warnings: [] }, READ_COMPANY_PEOPLE_SEARCH: { ok: true, peopleProfiles: people(5, 3), complete: false, warnings: [] } });
    expect(data.peopleProfiles).toHaveLength(7);
    expect(data.verification.sections.people).toEqual({ found: 7, state: "complete" });
    expect(count(sent, "READ_COMPANY_PEOPLE_SEARCH")).toBe(1);
  });

  it("falls back to the company people search when the People page has no employee cards, and says so", async () => {
    const { data, notes } = await capture({ ...base, READ_COMPANY_PEOPLE_SEARCH: { ok: true, peopleProfiles: people(10), complete: false, warnings: [] } });
    expect(data.peopleProfiles).toHaveLength(10);
    expect(notes.join(" ")).toMatch(/People page showed no employee cards/);
    expect(data.verification.sections.people).toMatchObject({ found: 10, state: "complete" });
  });

  it("looks again before concluding there are no people, and then confirms it", async () => {
    const { data, sent } = await capture(base);
    // First scan: the People page and the search. Second scan: the search again, then the People page deeper.
    expect(count(sent, "READ_COMPANY_PEOPLE_SEARCH")).toBe(2);
    expect(sent.filter((entry) => entry.type === "READ_COMPANY_PEOPLE_DIRECTORY").map((entry) => entry.deep)).toEqual([false, true]);
    expect(data.verification.sections.people).toEqual({ found: 0, state: "none" });
    expect(data.verification.notes.join(" ")).toMatch(/after a second scan/);
  });

  it("finds people on the second scan that the first scan missed", async () => {
    const { data } = await capture({ ...base, READ_COMPANY_PEOPLE_SEARCH: (_message, call) => ({ ok: true, peopleProfiles: call === 1 ? [] : people(12), complete: false, warnings: [] }) });
    expect(data.peopleProfiles).toHaveLength(12);
    expect(data.verification.sections.people.state).toBe("complete");
  });

  it("never reports a failed fallback as 'no people'", async () => {
    const { data, notes } = await capture({ ...base, READ_COMPANY_PEOPLE_DIRECTORY: new Error("Page did not become readable."), READ_COMPANY_PEOPLE_SEARCH: new Error("LinkedIn did not render readable cards on this results page.") });
    expect(data.verification.sections.people.state).toBe("failed");
    expect(data.verification.status).not.toBe("verified");
    expect(notes.join(" ")).toMatch(/Could not read associated people/);
  });

  it("does not confirm 'no people' when LinkedIn gave no people search to check", async () => {
    const { data } = await capture(base, { includeCompany: true, includePeople: true }, `<main><h1>Acme</h1></main>`);
    expect(data.verification.sections.people.state).toBe("not_loaded");
    expect(data.verification.notes.join(" ")).toMatch(/did not give a people search link/);
    expect(data.verification.status).toBe("verification_required");
  });

  it("stops and says restricted when LinkedIn shows a warning", async () => {
    const { data, sent } = await capture({ ...base, READ_COMPANY_PEOPLE_SEARCH: new Error("LinkedIn asked to verify it's you (restricted).") });
    expect(data.verification.sections.people.state).toBe("restricted");
    expect(data.verification.status).toBe("restricted");
    expect(count(sent, "READ_COMPANY_PEOPLE_SEARCH")).toBe(1);
  });

  it("does not repeat the second scan for a continued batch", async () => {
    const { sent } = await capture(base, { includeCompany: false, includePeople: true, resume: true });
    expect(count(sent, "READ_COMPANY_PEOPLE_SEARCH")).toBe(1);
  });
});

describe("company details: a second look at what was missing", () => {
  it("reads the About page again, deeper, for a missing field and merges what it finds", async () => {
    const { data, sent } = await capture({
      ...base,
      READ_COMPANY_PAGE: (message) => (message.deep ? page({ industry: "Software Development" }) : page({ industry: undefined })),
    }, { includeCompany: true, includePeople: false });
    const deep = sent.filter((entry) => entry.type === "READ_COMPANY_PAGE" && entry.deep);
    expect(deep).toHaveLength(1);
    expect(deep[0].url).toBe(`${ROOT}about/`);
    expect(data.industry).toBe("Software Development");
    expect(data.verification.missing).toBeUndefined();
    expect(data.verification.status).toBe("verified");
  });

  it("names what is still missing after the second look, as complete with missing data", async () => {
    const { data } = await capture({ ...base, READ_COMPANY_PAGE: () => page({ website: undefined, industry: undefined }) }, { includeCompany: true, includePeople: false });
    expect(data.verification.missing).toEqual(["Industry", "Website"]);
    expect(data.verification.status).toBe("missing_data");
  });

  it("does not look again when nothing is missing", async () => {
    const { sent } = await capture(base, { includeCompany: true, includePeople: false });
    expect(sent.filter((entry) => entry.type === "READ_COMPANY_PAGE" && entry.deep)).toHaveLength(0);
  });

  it("says the About page could not be read, rather than calling it verified", async () => {
    const { data } = await capture({ ...base, READ_COMPANY_PAGE: new Error("Page did not become readable.") }, { includeCompany: true, includePeople: false });
    expect(data.verification.sections.about.state).toBe("not_loaded");
    expect(data.verification.status).not.toBe("verified");
  });
});

describe("company job roles in the capture", () => {
  it("attaches the two-pass job scan and counts it in the verification", async () => {
    const { data, notes, sent } = await capture(base, { includeCompany: true, includePeople: false });
    expect(data.jobScan.jobs).toHaveLength(2);
    expect(data.verification.sections.jobs).toEqual({ found: 2, state: "complete" });
    expect(notes.join(" ")).toMatch(/Job roles: 2 found by 2 scans, verified/);
    expect(sent.find((entry) => entry.type === "SCAN_COMPANY_JOBS")).toMatchObject({ companyId: "acme", name: "Acme" });
  });

  it("reports a job scan that could not be verified, a restricted one and a failed one as such", async () => {
    const unverified = await capture({ ...base, SCAN_COMPANY_JOBS: { ok: true, scan: scan({ passes: [{ pass: 1, found: 2, complete: true }, { pass: 2, found: 2, complete: false }] }) } }, { includeCompany: true, includePeople: false });
    expect(unverified.data.verification.sections.jobs.state).toBe("incomplete");
    expect(unverified.data.verification.status).toBe("partial");
    expect(unverified.notes.join(" ")).toMatch(/not fully verified/);
    const restricted = await capture({ ...base, SCAN_COMPANY_JOBS: { ok: true, scan: scan({ status: "restricted", error: "LinkedIn asked to verify it's you." }) } }, { includeCompany: true, includePeople: false });
    expect(restricted.data.verification.status).toBe("restricted");
    const failed = await capture({ ...base, SCAN_COMPANY_JOBS: { ok: true, scan: scan({ status: "failed", jobs: [], error: "Timed out" }) } }, { includeCompany: true, includePeople: false });
    expect(failed.data.verification.sections.jobs.state).toBe("failed");
    expect(failed.notes.join(" ")).toMatch(/Job roles: the scan failed \(Timed out\)/);
  });

  it("confirms zero roles only for two complete passes, and never for a page that did not load", async () => {
    const none = await capture({ ...base, SCAN_COMPANY_JOBS: { ok: true, scan: scan({ jobs: [] }) } }, { includeCompany: true, includePeople: false });
    expect(none.data.verification.sections.jobs).toEqual({ found: 0, state: "none" });
    const notLoaded = await capture({ ...base, SCAN_COMPANY_JOBS: { ok: true, scan: scan({ status: "not_loaded", jobs: [], passes: [{ pass: 1, found: 0, complete: false }] }) } }, { includeCompany: true, includePeople: false });
    expect(notLoaded.data.verification.sections.jobs.state).toBe("not_loaded");
    expect(notLoaded.notes.join(" ")).toMatch(/nothing can be said about open roles/);
  });

  it("keeps the capture when the job scan itself throws, and says so", async () => {
    const { data, notes } = await capture({ ...base, SCAN_COMPANY_JOBS: new Error("The jobs page took too long to load.") }, { includeCompany: true, includePeople: false });
    expect(data.jobScan).toBeUndefined();
    expect(data.name).toBe("Acme");
    expect(notes.join(" ")).toMatch(/Could not read job roles: The jobs page took too long/);
  });

  it("skips the job scan when asked, and for a continued people batch", async () => {
    expect(count((await capture(base, { includeCompany: true, includePeople: false, includeJobs: false })).sent, "SCAN_COMPANY_JOBS")).toBe(0);
    expect(count((await capture(base, { includeCompany: false, includePeople: true, resume: true })).sent, "SCAN_COMPANY_JOBS")).toBe(0);
  });
});
