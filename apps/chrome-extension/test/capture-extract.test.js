import { describe, expect, it } from "vitest";
import { loadCapturePage } from "./helpers/capture-dom.js";

const EXTRACT_FILES = ["capture/extract-common.js", "capture/company-sections.js", "capture/page-extract.js"];

const PROFILE_HTML = `
<main>
  <section id="ProfileTopcard" data-view-name="profile-topcard">
    <h1>Jane Doe</h1>
    <p>VP Sales at Acme Robotics</p>
    <p>Acme Robotics · University of Texas</p>
    <p>Austin, Texas, United States</p>
    <p>Contact info</p>
    <p>1,204 followers</p>
    <p>500+ connections</p>
    <p><span>2nd</span></p>
  </section>
  <section componentkey="profile.AboutTopLevelSection">
    <span data-testid="expandable-text-box">Builds revenue teams.<button>…more</button></span>
  </section>
  <div componentkey="profile.ExperienceTopLevelSection">
    <div componentkey="entity-collection-item-1">
      <a href="/company/acme-robotics/"></a>
      <p>VP Sales</p><p>Acme Robotics · Full-time</p><p>Jan 2023 - Present · 2 yrs</p><p>Austin, Texas · Hybrid</p>
    </div>
    <div componentkey="entity-collection-item-2">
      <p>Sales Director</p><p>Globex · Full-time</p><p>2019 - 2022 · 3 yrs</p>
    </div>
    <div componentkey="entity-collection-item-3"><p>Ad Options</p><p>Why am I seeing this ad?</p></div>
  </div>
  <div componentkey="profile.EducationTopLevelSection">
    <ul><li><a href="/school/ut-austin/"></a><p>University of Texas</p><p>BBA, Marketing</p></li></ul>
  </div>
  <div componentkey="profile.SkillsTopLevelSection">
    <h2>Skills</h2>
    <ul>
      <li><p>Enterprise Sales</p><a href="/in/jane-doe/details/skills/x/">12 endorsements</a></li>
      <li><p>Endorsed by 3 colleagues at Globex</p></li>
      <li><p>Negotiation</p></li>
    </ul>
  </div>
  <aside>
    <h2>People you may know</h2>
    <a href="/in/stranger-person/"><p>Stranger Person</p><p>Recruiter at Elsewhere</p></a>
  </aside>
</main>`;

describe("person profile extraction", () => {
  const window = loadCapturePage({ url: "https://www.linkedin.com/in/jane-doe/", html: PROFILE_HTML, files: EXTRACT_FILES });
  const person = window.SkoutCapturePage.extractPerson();

  it("reads the visible header, About and source URL", () => {
    expect(person).toMatchObject({
      publicId: "jane-doe",
      sourceUrl: "https://www.linkedin.com/in/jane-doe/",
      fullName: "Jane Doe",
      headline: "VP Sales at Acme Robotics",
      locationName: "Austin, Texas, United States",
      summary: "Builds revenue teams.",
      followersCount: 1204,
      connectionsCount: 500,
    });
    expect(person.relationshipContext).toMatchObject({ degree: 2, isDirectConnection: false });
  });

  it("reads current and past experience, education and skills", () => {
    expect(person.currentCompanies).toEqual([
      expect.objectContaining({ name: "Acme Robotics", title: "VP Sales", companyPublicId: "acme-robotics", employmentType: "Full-time", location: "Austin, Texas" }),
    ]);
    expect(person.currentCompanyPublicId).toBe("acme-robotics");
    expect(person.previousCompanies).toEqual([expect.objectContaining({ name: "Globex", title: "Sales Director" })]);
    expect(person.educations).toEqual([expect.objectContaining({ school: "University of Texas", degree: "BBA, Marketing" })]);
    expect(person.skills).toEqual([{ name: "Enterprise Sales", endorsements: 12 }, { name: "Negotiation", endorsements: undefined }]);
  });

  it("keeps ads, suggestions and endorsement helper text out of profile facts", () => {
    const serialized = JSON.stringify(person);
    for (const chrome of ["Stranger", "People you may know", "Ad Options", "Why am I seeing", "Endorsed by"]) {
      expect(serialized).not.toContain(chrome);
    }
  });
});

const COMPANY_ABOUT_HTML = `
<main>
  <h1 class="org-top-card-summary__title">Acme Robotics</h1>
  <p class="org-top-card-summary__tagline">Robots that work.</p>
  <div class="org-top-card-summary-info-list__info-item">Robotics</div>
  <div class="org-top-card-summary-info-list__info-item">Austin, Texas</div>
  <div class="org-top-card-summary-info-list__info-item">12,400 followers</div>
  <div class="org-top-card-summary-info-list__info-item">501-1,000 employees</div>
  <section class="org-page-details-module__card-spacing">
    <h2>Overview</h2>
    <p>Acme builds warehouse robots.</p>
    <dl>
      <dt>Website</dt><dd>https://www.acmerobotics.example/</dd>
      <dt>Industry</dt><dd>Robotics Engineering</dd>
      <dt>Company size</dt><dd>501-1,000 employees</dd>
      <dt>Headquarters</dt><dd>Austin, Texas</dd>
      <dt>Founded</dt><dd>2014</dd>
      <dt>Specialties</dt><dd>Robotics, Automation</dd>
    </dl>
  </section>
  <a href="https://www.linkedin.com/search/results/people/?currentCompany=%5B%22424242%22%5D">1,141 associated members</a>
</main>`;

const COMPANY_PEOPLE_HTML = `
<main>
  <h2>1,141 associated members</h2>
  <div class="org-people-profile-card">
    <a id="org-people-profile-card__profile-image-0" href="/in/sam-lee/">Sam Lee</a><p>Sam Lee</p><p>Engineer at Acme Robotics</p>
  </div>
  <div class="org-people-profile-card">
    <a id="org-people-profile-card__profile-image-1" href="/in/ana-ruiz/">Ana Ruiz</a><p>Ana Ruiz</p><p>Sales lead</p>
  </div>
  <a href="/in/header-link/">12 mutual connections</a>
</main>`;

describe("company page extraction", () => {
  it("reads the About tab and the exact visible member count", () => {
    const window = loadCapturePage({ url: "https://www.linkedin.com/company/acme-robotics/about/", html: COMPANY_ABOUT_HTML, files: EXTRACT_FILES });
    const company = window.SkoutCapturePage.extractCompany();
    expect(company).toMatchObject({
      publicId: "acme-robotics",
      sourceUrl: "https://www.linkedin.com/company/acme-robotics/about/",
      name: "Acme Robotics",
      tagline: "Robots that work.",
      industry: "Robotics Engineering",
      headquarter: "Austin, Texas",
      size: "501-1,000",
      followers: 12400,
      website: "https://www.acmerobotics.example/",
      domain: "acmerobotics.example",
      foundedAt: "2014",
      specialties: ["Robotics", "Automation"],
      // The size band is not a member count; only the rendered exact figure is.
      employeesOnLi: 1141,
    });
    expect(company._peopleSearchUrl).toContain("currentCompany=");
    expect(company.sectionCaptures.about).toMatchObject({ method: "rendered-dom", sourceUrl: "https://www.linkedin.com/company/acme-robotics/about/" });
    expect(company.sectionCaptures.about.text).toContain("Acme builds warehouse robots.");
  });

  it("reads member cards from the People tab and nothing from other links", () => {
    const window = loadCapturePage({ url: "https://www.linkedin.com/company/acme-robotics/people/", html: COMPANY_PEOPLE_HTML, files: EXTRACT_FILES });
    const company = window.SkoutCapturePage.extractCompany();
    expect(company.peopleStats.totalEmployeesText).toBe("1,141 associated members");
    expect(company.peopleProfiles).toEqual([
      { publicId: "sam-lee", sourceUrl: "https://www.linkedin.com/in/sam-lee/", fullName: "Sam Lee", headline: "Engineer at Acme Robotics" },
      { publicId: "ana-ruiz", sourceUrl: "https://www.linkedin.com/in/ana-ruiz/", fullName: "Ana Ruiz", headline: "Sales lead" },
    ]);
  });

  it("treats a recommendations rail as no evidence of employment", () => {
    const html = COMPANY_PEOPLE_HTML.replace("<main>", "<main><h2>People you may know</h2>");
    const window = loadCapturePage({ url: "https://www.linkedin.com/company/acme-robotics/people/", html, files: EXTRACT_FILES });
    expect(window.SkoutCapturePage.extractCompany().peopleProfiles).toBeUndefined();
  });
});

describe("person capture run", () => {
  it("only opens this profile's own allowlisted pages and hands the result over for review", async () => {
    const opened = [];
    const sent = [];
    const chrome = {
      runtime: {
        id: "test-extension",
        lastError: undefined,
        onMessage: { addListener() {} },
        sendMessage(message, callback) {
          sent.push(message);
          if (message.type === "READ_PERSON_PAGE") {
            opened.push(message.url);
            const data = message.url.endsWith("/details/skills/") ? { skills: [{ name: "Forecasting", endorsements: 3 }, { name: "enterprise sales", endorsements: 40 }] } : {};
            const response = { ok: true, data, links: ["https://www.linkedin.com/in/stranger-person/", "https://www.linkedin.com/in/jane-doe/details/education/"] };
            return callback ? callback(response) : Promise.resolve(response);
          }
          return callback ? callback({ ok: true }) : Promise.resolve({ ok: true });
        },
      },
    };
    const window = loadCapturePage({
      url: "https://www.linkedin.com/in/jane-doe/",
      html: PROFILE_HTML,
      chrome,
      files: [...EXTRACT_FILES, "capture/restriction-detect.js", "capture/capture-ui.js", "capture/person-capture.js"],
    });
    window.setTimeout = (callback) => {
      callback();
      return 0;
    };
    expect(window.SkoutPersonCapture.pageUrl("/in/stranger-person/", "jane-doe")).toBeUndefined();
    expect(window.SkoutPersonCapture.pageUrl("/in/jane-doe/overlay/contact-info/", "jane-doe")).toBeUndefined();

    await window.SkoutPersonCapture.start();
    expect(opened).toEqual([
      "https://www.linkedin.com/in/jane-doe/",
      "https://www.linkedin.com/in/jane-doe/details/skills/",
      "https://www.linkedin.com/in/jane-doe/details/education/",
    ]);
    const review = sent.find((message) => message.type === "SKOUT_CAPTURE_REVIEW");
    expect(review).toMatchObject({ kind: "person", sourceUrl: "https://www.linkedin.com/in/jane-doe/" });
    expect(review.capturedAt).toBeTruthy();
    expect(review.data).toMatchObject({ publicId: "jane-doe", sourceUrl: "https://www.linkedin.com/in/jane-doe/", fullName: "Jane Doe" });
    // The detail page's higher endorsement count wins; names are not duplicated.
    expect(review.data.skills.map((skill) => `${skill.name}:${skill.endorsements}`).sort()).toEqual(["Forecasting:3", "Negotiation:undefined", "enterprise sales:40"]);
    expect(sent.at(-1)).toMatchObject({ type: "SKOUT_CAPTURE_PROGRESS", active: false });
  });
});

describe("LinkedIn warning detection", () => {
  const detect = (html, url = "https://www.linkedin.com/in/jane-doe/") =>
    loadCapturePage({ url, html, files: ["capture/restriction-detect.js"] }).SkoutCaptureRestriction.detect();

  it("recognizes LinkedIn's own notices", () => {
    expect(detect('<div role="alert">We noticed unusual activity from your account.</div>')).toMatch(/unusual activity/);
    expect(detect('<div class="artdeco-modal">You’ve reached the commercial use limit on search.</div>')).toMatch(/limit/);
    expect(detect("<main><h1>Your account is temporarily restricted</h1></main>")).toMatch(/restriction/);
    expect(detect("<main></main>", "https://www.linkedin.com/checkpoint/challenge/abc")).toMatch(/verification or restriction page/);
  });

  it("does not react to the same words in ordinary profile content", () => {
    expect(detect(PROFILE_HTML)).toBeNull();
    expect(detect("<main><section><p>I investigate unusual activity and automated behavior for a fraud team.</p></section></main>")).toBeNull();
  });
});
