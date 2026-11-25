import { describe, expect, it } from "vitest";
import { loadCapturePage } from "./helpers/capture-dom.js";

const FILES = ["capture/extract-common.js", "capture/company-sections.js", "capture/page-extract.js", "capture/capture-verify.js"];
const verify = () => loadCapturePage({ url: "https://www.linkedin.com/in/jane/", html: "<main></main>", files: FILES }).SkoutCaptureVerify;
const json = (value) => JSON.parse(JSON.stringify(value));
const skills = (n) => Array.from({ length: n }, (_, i) => ({ name: `Skill ${i + 1}` }));
const base = { fullName: "Jane", headline: "Engineer", locationName: "Austin, TX", currentCompanies: [{ name: "Acme", title: "Engineer", dates: "2022 - Present" }], email: "j@x.dev", phone: "+1 415 555 0100", website: "https://j.dev" };

describe("what the profile says it has", () => {
  const counts = (html) => loadCapturePage({ url: "https://www.linkedin.com/in/jane/", html: `<main><h1>Jane Doe</h1>${html}</main>`, files: FILES }).SkoutCapturePage.extractPerson();

  it("reads the totals from the Show all links", () => {
    const person = counts(`<a href="/details/skills/"><span>Show all 27 skills</span></a><a href="/details/experience/" aria-label="Show all 6 experiences">Show all</a><button>Show all 3 educations</button>`);
    expect(json(person._expectedCounts)).toEqual({ skills: 27, experience: 6, education: 3 });
    expect(json(person._showAll)).toEqual({ skills: true, experience: true, education: true });
  });

  it("knows a Show all link exists even when it gives no number", () => {
    const person = counts(`<a href="/details/skills/">Show all skills</a>`);
    expect(json(person._showAll)).toEqual({ skills: true });
    expect(json(person._expectedCounts)).toEqual({});
  });

  it("ignores other Show all links", () => {
    expect(json(counts(`<a>Show all 12 posts</a><a>Show all 4 languages</a>`)._expectedCounts)).toEqual({});
  });
});

describe("assessing a capture", () => {
  it("finds a section short of what the page says, however few records it has", () => {
    const { assess } = verify();
    const result = assess({ ...base, skills: skills(3), _expectedCounts: { skills: 27 }, _sections: { skills: "loaded" } });
    expect(result.sections.skills).toEqual({ found: 3, expected: 27, state: "incomplete" });
    expect(result.retry).toContain("skills");
  });

  it("calls 1-4 skills next to a Show all link suspicious even when no total is shown", () => {
    const { assess } = verify();
    expect(assess({ ...base, skills: skills(4), _showAll: { skills: true } }).sections.skills.state).toBe("incomplete");
    expect(assess({ ...base, skills: skills(5), _showAll: { skills: true } }).sections.skills.state).toBe("complete");
    expect(assess({ ...base, skills: skills(4) }).sections.skills.state).toBe("complete");
  });

  it("checks a single education or experience record against what the page says", () => {
    const { assess } = verify();
    const result = assess({ ...base, educations: [{ school: "IIT" }], _expectedCounts: { education: 2 }, _showAll: { education: true } });
    expect(result.sections.education).toEqual({ found: 1, expected: 2, state: "incomplete" });
    expect(assess({ ...base, educations: [{ school: "IIT" }], _showAll: { education: true } }).sections.education.state).toBe("incomplete");
  });

  it("counts each record once: the same skill or role is never counted twice", () => {
    const { countOf } = verify();
    expect(countOf({ skills: [{ name: "SQL" }, { name: "sql" }, { name: " SQL " }, { name: "Go" }] }, "skills")).toBe(2);
    expect(countOf({ currentCompanies: [{ name: "Acme", title: "Eng", dates: "2022" }], previousCompanies: [{ name: "Acme", title: "Eng", dates: "2022" }, { name: "Lyft", title: "Dev" }] }, "experience")).toBe(2);
  });

  it("tells a section that loaded empty from one that never loaded", () => {
    const { assess } = verify();
    expect(assess({ ...base, _sections: { skills: "loaded" } }).sections.skills.state).toBe("none");
    expect(assess({ ...base, _sections: { skills: "not_loaded" } }).sections.skills.state).toBe("not_loaded");
    expect(assess({ ...base }).sections.skills.state).toBe("not_loaded");
  });

  it("names missing fields, and treats a missing name, headline, location or company as core", () => {
    const { assess } = verify();
    const result = assess({ fullName: "Jane" });
    expect(result.missing).toEqual(expect.arrayContaining(["Headline", "Location", "Email", "Phone", "Website / portfolio", "Current company", "Current title"]));
    expect(result.coreMissing).toBe(true);
    expect(assess(base).coreMissing).toBe(false);
  });
});

describe("what a capture can honestly be called", () => {
  const complete = { ...base, skills: skills(30), educations: [{ school: "IIT" }], previousCompanies: [{ name: "Lyft", title: "Dev" }], _sections: { skills: "loaded", education: "loaded", experience: "loaded" } };

  it("is verified only when every section agrees", () => {
    const { assess, verdict } = verify();
    expect(verdict(assess({ ...complete, _expectedCounts: { skills: 30 } })).status).toBe("verified");
  });

  it("is a partial capture when a section is still short after the second look", () => {
    const { assess, verdict } = verify();
    const result = verdict(assess({ ...complete, skills: skills(12), _expectedCounts: { skills: 30 } }));
    expect(result.status).toBe("partial");
    expect(result.notes.join(" ")).toMatch(/Skills: captured 12 of 30/);
  });

  it("is complete with missing data when everything loaded but some fields are absent", () => {
    const { assess, verdict } = verify();
    const result = verdict(assess({ ...complete, email: undefined, phone: undefined }));
    expect(result.status).toBe("missing_data");
    expect(result.missing).toEqual(["Email", "Phone"]);
  });

  it("needs verification when a section never loaded, and says not loaded when none did", () => {
    const { assess, verdict } = verify();
    expect(verdict(assess({ ...complete, _sections: { skills: "not_loaded", education: "loaded", experience: "loaded" }, skills: undefined })).status).toBe("verification_required");
    expect(verdict(assess({ fullName: "Jane", headline: "Engineer" })).status).toBe("not_loaded");
  });

  it("reports restricted and failed captures as such, never as verified", () => {
    const { assess, verdict } = verify();
    expect(verdict(assess(complete), { restricted: true }).status).toBe("restricted");
    expect(verdict(assess(complete), { failed: true }).status).toBe("failed");
  });

  it("merges what two looks learned: totals never go down, loaded wins", () => {
    const { mergeSignals } = verify();
    const merged = json(mergeSignals(
      { _expectedCounts: { skills: 27 }, _showAll: { skills: true }, _sections: { skills: "loaded" } },
      { _expectedCounts: { skills: 5, education: 2 }, _showAll: { education: true }, _sections: { skills: "not_loaded", education: "loaded" } },
    ));
    expect(merged).toEqual({ _expectedCounts: { skills: 27, education: 2 }, _showAll: { skills: true, education: true }, _sections: { skills: "loaded", education: "loaded" } });
  });
});

describe("the verification scan of a profile", () => {
  const PROFILE = `<main><section id="profile-Topcard"><h1>Jane Doe</h1><p>Engineer at Acme</p><p>Austin, TX</p></section>
    <a href="/in/jane/details/skills/"><span>Show all 27 skills</span></a></main>`;

  /** Runs a person capture where each page answers from `answers`; returns what was opened and the review. */
  async function capture(answers) {
    const opened = [];
    const sent = [];
    const chrome = {
      runtime: {
        id: "t", lastError: undefined, onMessage: { addListener() {} },
        sendMessage(message, callback) {
          sent.push(message);
          if (message.type === "READ_PERSON_PAGE") {
            opened.push({ url: message.url, deep: message.deep === true });
            const answer = answers(message.url, message.deep === true);
            if (answer instanceof Error) return callback({ ok: false, error: answer.message });
            return callback({ ok: true, data: answer.data || {}, links: [], warnings: answer.warnings || [] });
          }
          return callback({ ok: true });
        },
      },
    };
    const window = loadCapturePage({ url: "https://www.linkedin.com/in/jane/", html: PROFILE, chrome, files: [...FILES, "capture/restriction-detect.js", "capture/capture-ui.js", "capture/person-capture.js"] });
    window.setTimeout = (callback) => { callback(); return 0; };
    await window.SkoutPersonCapture.start();
    return { opened, review: sent.find((message) => message.type === "SKOUT_CAPTURE_REVIEW") };
  }
  const detail = (url) => url.replace("https://www.linkedin.com/in/jane/", "");
  const signals = { _expectedCounts: { skills: 27 }, _showAll: { skills: true } };

  it("reads a section again, deeper, when the first read returned only a few of the skills", async () => {
    const { opened, review } = await capture((url, deep) => {
      if (detail(url) === "details/skills/") return { data: { skills: deep ? skills(27) : skills(3), _sections: { skills: "loaded" }, ...signals } };
      if (detail(url) === "") return { data: signals };
      return { data: {} };
    });
    expect(opened.filter((entry) => entry.deep).map((entry) => detail(entry.url))).toContain("details/skills/");
    expect(review.data.skills).toHaveLength(27);
    expect(review.data.verification).toMatchObject({ status: expect.stringMatching(/verified|missing_data|verification_required/), passes: 2 });
    expect(review.data.verification.sections.skills).toEqual({ found: 27, expected: 27, state: "complete" });
  });

  it("reports a partial capture, not a complete one, when the second look finds no more", async () => {
    const { review } = await capture((url) => (detail(url) === "details/skills/" ? { data: { skills: skills(3), _sections: { skills: "loaded" }, ...signals } } : { data: signals }));
    expect(review.data.skills).toHaveLength(3);
    expect(review.data.verification.status).toBe("partial");
    expect(review.data.verification.notes.join(" ")).toMatch(/Skills: captured 3 of 27/);
  });

  it("merges the second look without duplicating or losing anything", async () => {
    const { review } = await capture((url, deep) => (detail(url) === "details/skills/"
      ? { data: { skills: deep ? [...skills(3), ...skills(10).slice(3)] : skills(3), _sections: { skills: "loaded" }, ...signals } }
      : { data: signals }));
    expect(review.data.skills.map((skill) => skill.name)).toEqual(skills(10).map((skill) => skill.name));
  });

  it("never lets a looser second read replace a fuller first one", async () => {
    const { review } = await capture((url, deep) => (detail(url) === "details/skills/"
      ? { data: { skills: deep ? skills(2) : skills(27), _sections: { skills: "loaded" }, ...signals } }
      : { data: signals }));
    expect(review.data.skills).toHaveLength(27);
  });

  it("names a page that failed during verification, and does not call the capture verified", async () => {
    const { review } = await capture((url, deep) => {
      if (deep) return new Error("Profile page took too long to load.");
      return detail(url) === "details/skills/" ? { data: { skills: skills(3), _sections: { skills: "loaded" }, ...signals } } : { data: signals };
    });
    expect(review.data.verification.status).not.toBe("verified");
    expect(review.data.verification.notes.join(" ")).toMatch(/Verification of .*took too long/);
  });

  it("marks restricted when LinkedIn shows a warning during the second look", async () => {
    const { review } = await capture((url, deep) => (deep ? new Error("LinkedIn asked to verify it's you (restricted).") : { data: signals }));
    expect(review.data.verification.status).toBe("restricted");
  });
});
