import { describe, expect, it } from "vitest";
import { loadCapturePage } from "./helpers/capture-dom.js";
import {
  NOT_FOUND_PLACEHOLDER,
  fieldCoverage,
  normalizeEmailInput,
  normalizePhoneInput,
  reviewFieldValue,
  roleIndex,
  setRoleField,
} from "../capture-panel.js";

const FILES = ["capture/extract-common.js", "capture/company-sections.js", "capture/page-extract.js"];
const PERSON_FILES = [...FILES, "capture/restriction-detect.js", "capture/capture-ui.js", "capture/person-capture.js"];
const person = (html) => loadCapturePage({ url: "https://www.linkedin.com/in/jane-doe/", html, files: FILES }).SkoutCapturePage.extractPerson();
const top = (extra) => `<main><section id="profile-Topcard"><h1>Jane Doe</h1><p>Software Engineer at Uber</p>${extra}</section></main>`;
const experience = (rows) => `<div componentkey="profile.ExperienceTopLevelSection">${rows.map((lines, index) =>
  `<div componentkey="entity-collection-item-${index}">${lines.map((line) => `<p>${line}</p>`).join("")}</div>`).join("")}</div>`;

describe("followers and connections", () => {
  it("reads counts written inside links and spans", () => {
    const jane = person(top(`<ul><li><a href="/in/jane-doe/recent-activity/"><span>12,345</span> followers</a></li>
      <li><a href="/mynetwork/invite-connect/connections/"><span class="t-bold">500+</span> connections</a></li></ul>`));
    expect(jane.followersCount).toBe(12345);
    expect(jane.connectionsCount).toBe(500);
  });

  it("reads abbreviated counts and number/label split across elements", () => {
    const jane = person(top(`<span><strong>1.2K</strong></span><span>followers</span><div><span>347</span><span>connections</span></div>`));
    expect(jane.followersCount).toBe(1200);
    expect(jane.connectionsCount).toBe(347);
  });

  it("never takes mutual connections as the person's connections", () => {
    const jane = person(top(`<p>12 mutual connections</p><a href="/search/results/people/?facetNetwork=F">Jack and 11 other mutual connections</a>`));
    expect(jane.connectionsCount).toBeUndefined();
  });

  it("keeps a count once found when a later page does not show it", () => {
    const window = loadCapturePage({ url: "https://www.linkedin.com/in/jane-doe/", html: "<main></main>", files: PERSON_FILES });
    const merged = window.SkoutPersonCapture.merge({ followersCount: 900, connectionsCount: 500 }, { followersCount: undefined, connectionsCount: 3 });
    expect(merged.followersCount).toBe(900);
    expect(merged.connectionsCount).toBe(500);
  });
});

describe("current and previous roles", () => {
  it("takes the current company and title from the header when Experience has not loaded", () => {
    const jane = person(top(`<a href="/company/uber/"><span>Uber</span></a><a href="/school/iit/">IIT Delhi</a>`));
    expect(jane.currentCompanies[0]).toMatchObject({ name: "Uber", title: "Software Engineer", companyPublicId: "uber" });
  });

  it("recognises 'Present' in other languages", () => {
    const jane = person(top("").replace("</main>", `${experience([
      ["Ingeniera de software", "Uber · Jornada completa", "ene. 2022 - actualidad"],
      ["Desarrolladora", "Lyft", "2019 - 2021"],
    ])}</main>`));
    expect(jane.currentCompanies.map((role) => role.name)).toEqual(["Uber"]);
    expect(jane.previousCompanies.map((role) => role.name)).toEqual(["Lyft"]);
  });

  it("treats the first role as current when LinkedIn shows no dates", () => {
    const jane = person(top("").replace("</main>", `${experience([["Engineer", "Uber"], ["Developer", "Lyft"]])}</main>`));
    expect(jane.currentCompanies[0]).toMatchObject({ name: "Uber", title: "Engineer" });
    expect(jane.previousCompanies[0]).toMatchObject({ name: "Lyft", title: "Developer" });
  });

  it("shows the most recent past employer, not an earlier title at the current one", () => {
    const data = {
      currentCompanies: [{ name: "Uber", title: "Senior Engineer" }],
      previousCompanies: [{ name: "Uber", title: "Engineer" }, { name: "Lyft", title: "Developer" }],
    };
    expect(roleIndex(data, { list: "previousCompanies" })).toBe(1);
    expect(reviewFieldValue(data, "previousCompany")).toBe("Lyft");
    expect(reviewFieldValue(data, "previousTitle")).toBe("Developer");
    setRoleField(data, { list: "previousCompanies", key: "name" }, "Lyft Inc.");
    expect(data.previousCompanies[1]).toEqual({ name: "Lyft Inc.", title: "Developer" });
    expect(data.previousCompanies[0]).toEqual({ name: "Uber", title: "Engineer" });
  });
});

describe("contact details", () => {
  it("keeps the Contact info read through page merges", () => {
    const window = loadCapturePage({ url: "https://www.linkedin.com/in/jane-doe/", html: "<main></main>", files: PERSON_FILES });
    const { merge } = window.SkoutPersonCapture;
    const merged = merge(merge({}, { _contactInfo: { email: "jane@x.dev" }, email: "jane@x.dev" }), { _contactInfo: {} });
    expect(merged._contactInfo).toEqual({ email: "jane@x.dev" });
    expect(merged.email).toBe("jane@x.dev");
  });

  it("reads email and phone written as plain text under their labels", () => {
    const jane = person(`<main><h1>Jane Doe</h1><div role="dialog"><h2>Contact info</h2>
      <section><h3>Email</h3><div><span>Jane.Doe@Example.com</span></div></section>
      <section><h3>Phone</h3><div><span>+1 415 555 0100</span> <span>(Mobile)</span></div></section></div></main>`);
    expect(jane.email).toBe("jane.doe@example.com");
    expect(jane.phone).toBe("+1 415 555 0100");
  });
});

describe("review dialog: every field, NOT FOUND when missing", () => {
  it("lists what LinkedIn did not show so it can be filled in", () => {
    const coverage = fieldCoverage("person", {
      fullName: "Jane Doe", headline: "Engineer", currentCompanies: [{ name: "Uber", title: "Engineer" }], followersCount: 0,
    });
    expect(coverage.found).toBe(5);
    expect(coverage.missing).toEqual(expect.arrayContaining(["Email", "Phone", "Previous company", "Connections", "Website / portfolio"]));
    expect(coverage.missing).not.toContain("Followers");
    expect(NOT_FOUND_PLACEHOLDER).toMatch(/^NOT FOUND/);
  });

  it("covers the company fields too", () => {
    const coverage = fieldCoverage("company", { name: "Acme", website: "https://acme.example", followers: 10, employeesOnLi: 50 });
    expect(coverage.missing).toEqual(expect.arrayContaining(["Industry", "Headquarters", "Company size", "Phone", "Founded"]));
    expect(coverage.found).toBe(4);
  });

  it("validates typed email and phone", () => {
    expect(normalizeEmailInput(" Jane@Example.COM ")).toEqual({ value: "jane@example.com" });
    expect(normalizeEmailInput("mailto:a@b.io")).toEqual({ value: "a@b.io" });
    expect(normalizeEmailInput("not an email").error).toBeTruthy();
    expect(normalizeEmailInput("")).toEqual({ empty: true });
    expect(normalizePhoneInput("+91 98765 43210")).toEqual({ value: "+91 98765 43210" });
    expect(normalizePhoneInput("(415) 555-0100")).toEqual({ value: "(415) 555-0100" });
    expect(normalizePhoneInput("12345").error).toBeTruthy();
    expect(normalizePhoneInput("call me").error).toBeTruthy();
  });
});
