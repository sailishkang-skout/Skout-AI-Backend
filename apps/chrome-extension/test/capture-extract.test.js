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

  it("reads email and phone only from a visible, already-open Contact Info dialog", () => {
    const visible = loadCapturePage({
      url: "https://www.linkedin.com/in/jane-doe/",
      html: '<main><h1>Jane Doe</h1><section aria-label="Contact Info"><a href="mailto:jane@example.com">jane@example.com</a><a href="tel:+15550100">+1 555 0100</a></section></main>',
      files: EXTRACT_FILES,
    });
    expect(visible.SkoutCapturePage.extractPerson()._contactInfo).toMatchObject({
      email: "jane@example.com",
      phone: "+15550100",
    });

    const hidden = loadCapturePage({
      url: "https://www.linkedin.com/in/jane-doe/",
      html: '<main><h1>Jane Doe</h1><section aria-label="Contact Info" aria-hidden="true"><a href="mailto:jane@example.com">jane@example.com</a></section></main>',
      files: EXTRACT_FILES,
    });
    expect(hidden.SkoutCapturePage.extractPerson()._contactInfo).toBeUndefined();
  });

  it("keeps school-only education entries and captures a full connection-degree label", () => {
    const window = loadCapturePage({
      url: "https://www.linkedin.com/in/jane-doe/",
      html: `
        <main>
          <section id="ProfileTopcard" data-view-name="profile-topcard">
            <h1>Jane Doe</h1>
            <p>1st degree connection</p>
          </section>
          <div componentkey="profile.EducationTopLevelSection">
            <ul><li><a href="/school/ut-austin/"></a><p>University of Texas</p></li></ul>
          </div>
          <div componentkey="profile.SkillsTopLevelSection">
            <ul><li><div><div>Discovery Sales</div><div><span>Endorsed by 3 colleagues</span></div></div></li></ul>
          </div>
        </main>
      `,
      files: EXTRACT_FILES,
    });
    const person = window.SkoutCapturePage.extractPerson();

    expect(person.educations).toEqual([{ school: "University of Texas", degree: undefined, activities: undefined, description: undefined }]);
    expect(person.skills).toEqual([{ name: "Discovery Sales", endorsements: undefined }]);
    expect(person.relationshipContext).toMatchObject({ degree: 1, isDirectConnection: true });
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

const CURRENT_SDUI_COMPANY_HTML = `
<main>
  <div id="pages.topCard.company.69007278">
    <h2>Drata</h2>
    <p>Drata is the Agentic Trust Management Platform.</p>
    <img src="https://media.licdn.com/company-logo/drata" alt="Drata logo">
    <div>
      <p>Software Development</p><p>·</p>
      <p><a href="/products/?productCategory=payroll">Payroll Software</a></p><p>·</p>
      <p>San Francisco, California</p><p>·</p><p>101K followers</p><p>·</p><p>501-1K employees</p>
    </div>
    <a aria-label="Search more employees" href="https://www.linkedin.com/search/results/people/?currentCompany=%5B%2269007278%22%5D">Search more employees</a>
  </div>
  <section>
    <div><h2>Overview</h2><p>Drata provides the trust network that enables businesses to operate, scale, and partner with confidence.</p></div>
    <div>
      <div><div><p>Website</p></div><div><p><a href="https://drata.com">https://drata.com</a></p></div></div>
      <div><div><p>Industry</p></div><div><p>Software Development</p></div></div>
      <div><div><p>Company size</p></div><div><p>501-1,000 employees</p></div></div>
      <div><div><p>Headquarters</p></div><div><p>San Francisco, California</p></div></div>
      <div><div><p>Founded</p></div><div><p>2020</p></div></div>
      <div><div><p>Specialties</p></div><div><p>compliance, cybersecurity, SOC 2</p></div></div>
    </div>
  </section>
</main>`;

describe("company page extraction", () => {
  it("extracts current SDUI company top-card and About label/value rows", () => {
    const window = loadCapturePage({
      url: "https://www.linkedin.com/company/drata/about/",
      html: CURRENT_SDUI_COMPANY_HTML,
      files: EXTRACT_FILES,
    });
    const company = window.SkoutCapturePage.extractCompany();

    expect(company).toMatchObject({
      publicId: "drata",
      name: "Drata",
      tagline: "Drata is the Agentic Trust Management Platform.",
      industry: "Software Development",
      headquarter: "San Francisco, California",
      followers: 101000,
      size: "501-1,000",
      logoUrl: "https://media.licdn.com/company-logo/drata",
      website: "https://drata.com",
      domain: "drata.com",
      foundedAt: "2020",
      specialties: ["compliance", "cybersecurity", "SOC 2"],
    });
    expect(company._peopleSearchUrl).toContain("currentCompany=");
    expect(company.sectionCaptures.about.text).toContain("Company size: 501-1,000 employees");
  });

  it("collects a current SDUI About page through the full-page reader", async () => {
    let listener;
    const window = loadCapturePage({
      url: "https://www.linkedin.com/company/drata/about/",
      html: CURRENT_SDUI_COMPANY_HTML,
      chrome: {
        runtime: {
          id: "test-extension",
          onMessage: { addListener(callback) { listener = callback; } },
          sendMessage: async () => undefined,
        },
      },
      files: [...EXTRACT_FILES, "capture/company-capture.js"],
    });
    const result = await new Promise((resolve) => {
      const asyncResponse = listener(
        { type: "COLLECT_COMPANY_PAGE", companyId: "drata", url: "https://www.linkedin.com/company/drata/about/" },
        { id: "test-extension" },
        resolve,
      );
      expect(asyncResponse).toBe(true);
    });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      name: "Drata",
      website: "https://drata.com",
      sectionCaptures: {
        about: expect.objectContaining({ method: "rendered-dom", sourceUrl: "https://www.linkedin.com/company/drata/about/" }),
      },
    });
    expect(result.data.sectionCaptures.about.text).toContain("Specialties: compliance, cybersecurity, SOC 2");
  });

  it("captures visible company information from the canonical /home/ page", () => {
    const window = loadCapturePage({
      url: "https://www.linkedin.com/company/acme-robotics/home/",
      html: "<main><h1>Acme Robotics</h1><p>Robotics Engineering</p><p>Austin, Texas</p></main>",
      files: EXTRACT_FILES,
    });
    const company = window.SkoutCapturePage.extractCompany();
    expect(company.name).toBe("Acme Robotics");
    expect(company.sectionCaptures.home.text).toContain("Acme Robotics");
  });

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

  it("normalizes LinkedIn's /home/ company route to the canonical company root", () => {
    const window = loadCapturePage({
      url: "https://www.linkedin.com/company/acme-robotics/home/",
      html: "<main><h1>Acme Robotics</h1></main>",
      files: [...EXTRACT_FILES, "capture/company-capture.js"],
    });
    expect(window.SkoutCompanyCapture.pageUrl(window.location.href, "acme-robotics"))
      .toBe("https://www.linkedin.com/company/acme-robotics/");
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
      "https://www.linkedin.com/in/jane-doe/details/experience/",
      "https://www.linkedin.com/in/jane-doe/details/education/",
      "https://www.linkedin.com/in/jane-doe/details/skills/",
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
