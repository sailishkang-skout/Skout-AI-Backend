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
    expect(visible.SkoutCapturePage.extractPerson()).toMatchObject({
      email: "jane@example.com",
      phone: "+15550100",
    });

    const headingModal = loadCapturePage({
      url: "https://www.linkedin.com/in/jane-doe/",
      html: '<main><h1>Jane Doe</h1><div role="dialog"><h2>Contact info</h2><a href="mailto:jane@example.com?subject=Profile">Email</a><a href="tel:%2B15550100">Phone</a></div></main>',
      files: EXTRACT_FILES,
    });
    expect(headingModal.SkoutCapturePage.extractPerson()).toMatchObject({
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

  it("extracts Education from a detail page whose title is a plain paragraph", () => {
    const window = loadCapturePage({
      url: "https://www.linkedin.com/in/jane-doe/details/education/",
      html: `
        <main>
          <div>
            <div><p>Education</p></div>
            <div>
              <div><div><p>Stanford University</p><p>BS, Computer Science</p><p>2010 - 2014</p></div></div>
              <div><div><p>Lincoln High School</p><p>2006 - 2010</p></div></div>
            </div>
          </div>
          <aside><p>People also viewed</p><div><p>Someone Else</p><p>2015</p></div></aside>
        </main>
      `,
      files: EXTRACT_FILES,
    });
    const schools = window.SkoutCapturePage.extractPerson().educations.map((e) => e.school);
    expect(schools).toEqual(["Stanford University", "Lincoln High School"]);
  });

  it("extracts Education when the detail page title is a span inside a div", () => {
    const window = loadCapturePage({
      url: "https://www.linkedin.com/in/jane-doe/details/education/",
      html: `
        <main>
          <div><div><a href="/in/jane-doe/">Back</a><span>Education</span></div>
            <div><div><a href="/school/mit/"><span>MIT</span></a><span>MBA</span><span>2018 - 2020</span></div></div>
          </div>
          <aside><p>People you may know</p></aside>
        </main>
      `,
      files: EXTRACT_FILES,
    });
    expect(window.SkoutCapturePage.extractPerson().educations).toMatchObject([{ school: "MIT", degree: "MBA", dates: "2018 - 2020" }]);
  });

  it("never uses a date like Present as a location and falls back to the current job, contact info, then bio", () => {
    const load = (html) => loadCapturePage({ url: "https://www.linkedin.com/in/jane-doe/", html, files: EXTRACT_FILES })
      .SkoutCapturePage.extractPerson();
    const experience = (lines) => `<div componentkey="profile.ExperienceTopLevelSection"><ul><li componentkey="entity-collection-item-1">${lines.map((l) => `<p>${l}</p>`).join("")}</li></ul></div>`;
    const top = `<section data-view-name="profile-topcard"><h1>Jane Doe</h1><p>Head of Sales</p></section>`;

    // "Present" split from the date range is not a place.
    const split = load(`<main>${top}${experience(["Head of Sales", "Acme · Full-time", "Jan 2022 -", "Present", "3 yrs 2 mos"])}</main>`);
    expect(split.locationName).toBeUndefined();
    expect(split.currentCompanies?.[0]?.location).toBeUndefined();

    const job = load(`<main>${top}${experience(["Head of Sales", "Acme · Full-time", "Jan 2022 - Present", "Berlin, Germany · Hybrid"])}</main>`);
    expect(job.locationName).toBe("Berlin, Germany");

    const contact = load(`<main>${top}${experience(["Head of Sales", "Acme · Full-time", "Jan 2022 - Present", "Berlin, Germany"])}
      <div role="dialog"><h2>Contact info</h2><h3>Email</h3><a href="mailto:jane@acme.example">jane@acme.example</a><h3>Phone</h3><span>+49 30 1234567</span><h3>Address</h3><p>Munich, Bavaria</p></div></main>`);
    expect(contact).toMatchObject({ locationName: "Munich, Bavaria", email: "jane@acme.example", phone: "+49 30 1234567" });

    const bio = load(`<main>${top}<div componentkey="profile.AboutTopLevelSection"><span data-testid="expandable-text-box">Sales leader based in Austin, Texas. Ex-Oracle.</span></div></main>`);
    expect(bio.locationName).toBe("Austin, Texas");

    const header = load(`<main><section data-view-name="profile-topcard"><h1>Jane Doe</h1><p>Head of Sales</p><p>Acme</p><p>London, England, United Kingdom</p></section>${experience(["Head of Sales", "Acme", "2022 - Present", "Berlin, Germany"])}</main>`);
    expect(header.locationName).toBe("London, England, United Kingdom");
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

    expect(person.educations).toEqual([{ school: "University of Texas", degree: undefined, dates: undefined, activities: undefined, description: undefined }]);
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
  async function collectAfterSectionLoads(sectionName, detailPath, sectionMarkup, onScroll = () => {}) {
    let reader;
    const chrome = {
      runtime: {
        id: "test-extension",
        onMessage: { addListener(listener) { reader = listener; } },
      },
    };
    const window = loadCapturePage({
      url: `https://www.linkedin.com/in/jane-doe/${detailPath}/`,
      html: "<main><h1>Jane Doe</h1></main>",
      chrome,
      files: [...EXTRACT_FILES, "capture/person-capture.js"],
    });
    window.scrollTo = () => {};
    window.scrollBy = (...args) => onScroll(window, ...args);
    window.setTimeout(() => {
      const section = window.document.createElement("div");
      section.innerHTML = sectionMarkup;
      window.document.querySelector("main").append(section);
    }, 650);

    try {
      return await new Promise((resolve, reject) => {
        reader(
          {
            type: "COLLECT_PERSON_PAGE",
            personId: "jane-doe",
            url: `https://www.linkedin.com/in/jane-doe/${detailPath}/`,
          },
          { id: "test-extension" },
          resolve,
        );
        window.setTimeout(() => reject(new Error(`${sectionName} section did not resolve`)), 8_000);
      });
    } finally {
      window.close();
    }
  }

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
    expect(window.SkoutPersonCapture.pageUrl("/in/stranger-person/overlay/contact-info/", "jane-doe")).toBeUndefined();
    expect(window.SkoutPersonCapture.pageUrl("/in/jane-doe/overlay/contact-info/", "jane-doe")).toBe("https://www.linkedin.com/in/jane-doe/overlay/contact-info/");

    await window.SkoutPersonCapture.start();
    expect(opened).toEqual([
      "https://www.linkedin.com/in/jane-doe/",
      "https://www.linkedin.com/in/jane-doe/details/experience/",
      "https://www.linkedin.com/in/jane-doe/details/education/",
      "https://www.linkedin.com/in/jane-doe/details/skills/",
      "https://www.linkedin.com/in/jane-doe/overlay/contact-info/",
    ]);
    const review = sent.find((message) => message.type === "SKOUT_CAPTURE_REVIEW");
    expect(review).toMatchObject({ kind: "person", sourceUrl: "https://www.linkedin.com/in/jane-doe/" });
    expect(review.capturedAt).toBeTruthy();
    expect(review.data).toMatchObject({ publicId: "jane-doe", sourceUrl: "https://www.linkedin.com/in/jane-doe/", fullName: "Jane Doe" });
    // The detail page's higher endorsement count wins; names are not duplicated.
    expect(review.data.skills.map((skill) => `${skill.name}:${skill.endorsements}`).sort()).toEqual(["Forecasting:3", "Negotiation:undefined", "enterprise sales:40"]);
    expect(sent.at(-1)).toMatchObject({ type: "SKOUT_CAPTURE_PROGRESS", active: false });
  });

  it("waits for the Education section to hydrate after the profile shell", async () => {
    const result = await collectAfterSectionLoads(
      "Education",
      "details/education",
      '<div componentkey="profile.EducationDetailsSection"><div id="com.linkedin.sdui.profile.education(1)"><p>IIT Bombay</p><p>B.Tech</p></div></div>',
    );

    expect(result.data.educations).toEqual([
      { school: "IIT Bombay", degree: "B.Tech", activities: undefined, description: undefined },
    ]);
  });

  it("collects education entries that render as the detail page scrolls", async () => {
    let appended = false;
    const result = await collectAfterSectionLoads(
      "Education",
      "details/education",
      '<div componentkey="profile.EducationDetailsSection"><div componentkey="entity-collection-item-1"><p>University of Toronto</p><p>Master of Science</p></div></div>',
      (window) => {
        if (appended) return;
        appended = true;
        const row = window.document.createElement("div");
        row.setAttribute("componentkey", "entity-collection-item-2");
        row.innerHTML = "<p>University of Waterloo</p><p>Bachelor of Mathematics</p>";
        window.document.querySelector('[componentkey="profile.EducationDetailsSection"]').append(row);
      },
    );

    expect(result.data.educations?.map((item) => item.school)).toEqual([
      "University of Toronto",
      "University of Waterloo",
    ]);
  });

  it("waits for the Skills section to hydrate before collecting the rendered list", async () => {
    const result = await collectAfterSectionLoads(
      "Skills",
      "details/skills",
      '<div componentkey="profile.SkillsDetailsSection"><ul><li><p>Revenue Operations</p></li></ul></div>',
    );

    expect(result.data.skills).toEqual([{ name: "Revenue Operations", endorsements: undefined }]);
  });

  it("recognizes the current singular SkillDetails component while collecting", async () => {
    const result = await collectAfterSectionLoads(
      "Skills",
      "details/skills",
      '<div componentkey="com.linkedin.sdui.profile.card.ref123SkillDetails"><p>HR Operations</p><p>Microsoft Office</p></div>',
    );

    expect(result.data.skills?.map((skill) => skill.name)).toEqual(["HR Operations", "Microsoft Office"]);
  });

  it("extracts unlinked education labels and skill-insight links without list rows", () => {
    const window = loadCapturePage({
      url: "https://www.linkedin.com/in/jane-doe/details/education/",
      html: `
        <main>
          <div componentkey="profile.EducationDetailsSection">
            <div data-view-name="profile-component-entity">
              <span>University of Toronto</span><span>Master of Science</span><span>2019 - 2021</span>
            </div>
          </div>
          <div componentkey="profile.SkillsDetailsSection">
            <div><a href="/in/jane-doe/skill-insights/forecasting/">Forecasting</a></div>
          </div>
        </main>
      `,
      files: EXTRACT_FILES,
    });
    const person = window.SkoutCapturePage.extractPerson();

    expect(person.educations).toEqual([
      { school: "University of Toronto", degree: "Master of Science", dates: "2019 - 2021", activities: undefined, description: undefined },
    ]);
    expect(person.skills).toEqual([{ name: "Forecasting", endorsements: undefined }]);
  });

  it("finds education and skills below generic section headings without component keys", () => {
    const window = loadCapturePage({
      url: "https://www.linkedin.com/in/jane-doe/details/education/",
      html: `
        <main>
          <div>
            <div role="heading" aria-level="2">Education</div>
            <div class="education-row"><div>University of Toronto</div><div>Master of Science</div><div>2019 - 2021</div></div>
            <div class="education-row"><div>University of Waterloo</div><div>Bachelor of Mathematics</div><div>2015 - 2019</div></div>
          </div>
          <div>
            <div role="heading" aria-level="2">Skills</div>
            <p>Forecasting</p><p>SQL</p><p>Endorsed by 3 colleagues</p>
          </div>
          <aside><h2>People you may know</h2><p>Suggested contact</p></aside>
        </main>
      `,
      files: EXTRACT_FILES,
    });
    const person = window.SkoutCapturePage.extractPerson();

    expect(person.educations).toHaveLength(2);
    expect(person.educations?.map((item) => item.school)).toEqual(["University of Toronto", "University of Waterloo"]);
    expect(person.skills?.map((skill) => skill.name)).toEqual(["Forecasting", "SQL"]);
    expect(JSON.stringify(person)).not.toContain("Suggested contact");
  });

  it("captures multiple plain education rows and unstructured skill labels", () => {
    const window = loadCapturePage({
      url: "https://www.linkedin.com/in/jane-doe/details/education/",
      html: `
        <main>
          <div componentkey="profile.EducationDetailsSection">
            <div id="com.linkedin.sdui.profile.education(1)">
              <p>University of Toronto</p><p>Master of Science</p><p>2019 - 2021</p>
            </div>
            <div class="plain-education-row">
              <p>University of Waterloo</p><p>Bachelor of Mathematics</p><p>2015 - 2019</p>
            </div>
          </div>
          <div componentkey="profile.SkillsDetailsSection">
            <p>Forecasting</p><p>SQL</p><p>Endorsed by 3 colleagues</p>
          </div>
        </main>
      `,
      files: EXTRACT_FILES,
    });
    const person = window.SkoutCapturePage.extractPerson();

    expect(person.educations).toEqual([
      { school: "University of Toronto", degree: "Master of Science", dates: "2019 - 2021", activities: undefined, description: undefined },
      { school: "University of Waterloo", degree: "Bachelor of Mathematics", dates: "2015 - 2019", activities: undefined, description: undefined },
    ]);
    expect(person.skills).toEqual([
      { name: "Forecasting", endorsements: undefined },
      { name: "SQL", endorsements: undefined },
    ]);
  });

  it("extracts Education and mixed Skills rows from LinkedIn's current detail-page components", () => {
    const window = loadCapturePage({
      url: "https://www.linkedin.com/in/aditya-chauhan-4a3aa2b9/details/education/",
      html: `
        <main>
          <div componentkey="com.linkedin.sdui.profile.card.ref123EducationDetailsSection">
            <div componentkey="education-row-one">
              <a href="/school/9059894/"><figure></figure></a>
              <div><a href="/school/9059894/"><div><div>
                <p>Amity University Gurugram</p>
                <p>Master of Business Administration (M.B.A.), HR &amp; International business</p>
                <p>2013 – 2015</p>
              </div></div></a><p>Grade: A</p></div>
            </div>
            <div componentkey="education-row-two">
              <a href="/school/13191775/"><figure></figure></a>
              <div><a href="/school/13191775/"><div><div>
                <p>Chetana's Institute of Management &amp; Research</p>
                <p>BMS, Business Administration and Management, General</p>
                <p>2009 – 2012</p>
              </div></div></a></div>
            </div>
          </div>
          <div componentkey="com.linkedin.sdui.profile.card.ref123SkillDetails">
            <div><p>Skills</p><nav><button>All</button><button>Industry Knowledge</button><button>Tools &amp; Technologies</button></nav></div>
            <div id="com.linkedin.sdui.profile.skill(profile123, 2141250545)">
              <p>HR Operations</p>
              <ul><li><p>2 experiences at Paytm and 1 other company</p></li></ul>
            </div>
            <p>Microsoft Office</p><p>Management</p><p>Microsoft Excel</p><p>Microsoft Word</p>
            <p>Research</p><p>PowerPoint</p><p>Sales</p><p>Photoshop</p>
          </div>
        </main>
      `,
      files: EXTRACT_FILES,
    });
    const person = window.SkoutCapturePage.extractPerson();

    expect(person.educations).toEqual([
      { school: "Amity University Gurugram", degree: "Master of Business Administration (M.B.A.), HR & International business", dates: "2013 – 2015", activities: undefined, description: undefined },
      { school: "Chetana's Institute of Management & Research", degree: "BMS, Business Administration and Management, General", dates: "2009 – 2012", activities: undefined, description: undefined },
    ]);
    expect(person.skills?.map((skill) => skill.name)).toEqual([
      "HR Operations", "Microsoft Office", "Management", "Microsoft Excel",
      "Microsoft Word", "Research", "PowerPoint", "Sales", "Photoshop",
    ]);
  });

  it("extracts skills rendered as plain div labels on the Skills detail page", () => {
    const window = loadCapturePage({
      url: "https://www.linkedin.com/in/jane-doe/details/skills/",
      html: `
        <main>
          <div componentkey="profile.SkillsDetailsSection">
            <div>Forecasting</div><div>SQL</div><div>Endorsed by 3 colleagues</div>
          </div>
        </main>
      `,
      files: EXTRACT_FILES,
    });

    expect(window.SkoutCapturePage.extractPerson().skills).toEqual([
      { name: "Forecasting", endorsements: undefined },
      { name: "SQL", endorsements: undefined },
    ]);
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
