/** Shared LinkedIn profile scraper — loaded before bridge + panel scripts. */
(function initLinkedInScraper() {
  function clean(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  function unescapeJsonString(value) {
    try {
      return JSON.parse(`"${value}"`);
    } catch {
      return value.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
  }

  function pickFirstMatch(html, patterns) {
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) return unescapeJsonString(match[1]);
    }
    return "";
  }

  /** Profile-scoped fields from inline JSON — avoid first random companyName on the page. */
  function fieldsFromPageSource(linkedinUrl) {
    const html = document.documentElement.innerHTML;
    const slugMatch = linkedinUrl.match(/linkedin\.com\/(?:in|pub)\/([^/?#]+)/i);
    const publicId = slugMatch ? decodeURIComponent(slugMatch[1]).replace(/\/$/, "") : "";

    const firstNames = [...html.matchAll(/"firstName"\s*:\s*"((?:\\.|[^"\\])*)"/g)].map((m) =>
      unescapeJsonString(m[1])
    );
    const lastNames = [...html.matchAll(/"lastName"\s*:\s*"((?:\\.|[^"\\])*)"/g)].map((m) =>
      unescapeJsonString(m[1])
    );

    let fullName = "";
    const pairs = Math.max(firstNames.length, lastNames.length);
    for (let i = 0; i < pairs; i += 1) {
      const candidate = [firstNames[i], lastNames[i]].filter(Boolean).join(" ").trim();
      if (candidate.length > fullName.length) fullName = candidate;
    }

    let headline = "";
    if (publicId) {
      const escaped = publicId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const block = html.match(
        new RegExp(`"publicIdentifier"\\s*:\\s*"${escaped}"[\\s\\S]{0,8000}?"headline"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`)
      );
      if (block?.[1]) headline = unescapeJsonString(block[1]);
    }
    if (!headline) {
      headline = pickFirstMatch(html, [
        /"headline"\s*:\s*"((?:\\.|[^"\\])*)"/,
        /"occupation"\s*:\s*"((?:\\.|[^"\\])*)"/,
      ]);
    }

    let companyName = "";
    if (publicId) {
      const escaped = publicId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const block = html.match(
        new RegExp(
          `"publicIdentifier"\\s*:\\s*"${escaped}"[\\s\\S]{0,12000}?"companyName"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`
        )
      );
      if (block?.[1]) companyName = unescapeJsonString(block[1]);
    }

    const location = pickFirstMatch(html, [
      /"geoLocationName"\s*:\s*"((?:\\.|[^"\\])*)"/,
      /"locationName"\s*:\s*"((?:\\.|[^"\\])*)"/,
      /"defaultLocalizedName"\s*:\s*"((?:\\.|[^"\\])*)"/,
    ]);

    let about = "";
    if (publicId) {
      const escaped = publicId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const block = html.match(
        new RegExp(`"publicIdentifier"\\s*:\\s*"${escaped}"[\\s\\S]{0,12000}?"summary"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`)
      );
      if (block?.[1]) about = unescapeJsonString(block[1]);
    }
    if (!about) {
      about = pickFirstMatch(html, [/"summary"\s*:\s*"((?:\\.|[^"\\])*)"/]);
    }

    return { fullName, headline, companyName, location, about };
  }

  function nameFromDocumentTitle() {
    const part = (document.title || "").split("|")[0]?.trim() || "";
    if (!part || /linkedin/i.test(part)) return "";
    const namePart = part.split(" - ")[0]?.split(" – ")[0]?.trim() || part;
    if (namePart.length > 1 && namePart.length < 80) return clean(namePart);
    return "";
  }

  function nameFromUrlVanity(url) {
    const match = url.match(/linkedin\.com\/(?:in|pub)\/([^/?#]+)/i);
    if (!match) return "";
    const slug = decodeURIComponent(match[1]).replace(/\/$/, "");
    if (!slug || slug.includes("/")) return "";
    const word = slug.replace(/-[a-f0-9]{6,}$/i, "").replace(/-\d+$/, "");
    if (!word || word.includes("-")) return "";
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }

  function topCardRoot() {
    const selectors = [
      '[data-view-name="profile-top-card"]',
      "main section.artdeco-card:has(h1)",
      "main section:first-of-type:has(h1)",
    ];
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el?.querySelector("h1")) return el;
    }
    const main = document.querySelector("main");
    return main?.querySelector("section") || main;
  }

  function profileHeaderScope(card) {
    const h1 = card?.querySelector("h1");
    if (!h1) return card;
    let scope = h1.parentElement;
    for (let depth = 0; depth < 5 && scope && scope !== card; depth += 1) {
      if (scope.querySelector('button[aria-label*="company" i], a[href*="/company/"]')) {
        return scope;
      }
      scope = scope.parentElement;
    }
    return h1.parentElement || card;
  }

  function nameFromUrl(url) {
    const match = url.match(/linkedin\.com\/(?:in|pub)\/([^/?#]+)/i);
    if (!match) return "";
    const slug = decodeURIComponent(match[1]).replace(/\/$/, "");
    const words = slug
      .replace(/-[a-f0-9]{6,}$/i, "")
      .replace(/-\d+$/, "")
      .split("-")
      .filter(Boolean);
    if (words.length === 0) return "";
    // Single-word vanity slugs (e.g. winforthegipper) are often not real names.
    if (words.length === 1 && words[0].length < 20) return "";
    return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
  }

  function nameFromJsonLd() {
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(script.textContent || "");
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          if (item?.["@type"] === "Person" && item.name) return clean(item.name);
          if (item?.author?.name) return clean(item.author.name);
        }
      } catch {
        // ignore malformed JSON-LD
      }
    }
    return "";
  }

  function nameFromOg() {
    const og =
      document.querySelector('meta[property="og:title"]')?.getAttribute("content") ||
      document.querySelector('meta[name="twitter:title"]')?.getAttribute("content") ||
      "";
    const part = og.split("|")[0]?.trim() || "";
    if (!part || /linkedin/i.test(part)) return "";
    // "Jane Doe - VP Sales at Acme" → take segment before role separator
    const namePart = part.split(" - ")[0]?.split(" – ")[0]?.trim() || part;
    if (namePart.length > 1 && namePart.length < 80) return clean(namePart);
    return "";
  }

  function nameFromDom() {
    const card = topCardRoot();
    const scopes = card ? [card] : [document.querySelector("main")].filter(Boolean);

    const selectors = [
      "h1.text-heading-xlarge",
      "h1.text-heading-large",
      "h1.inline.t-24",
      "h1.t-24",
      "h1[class*='heading']",
      "h1",
    ];

    for (const scope of scopes) {
      for (const sel of selectors) {
        const text = clean(scope.querySelector(sel)?.textContent);
        if (text && text.length > 1 && text.length < 80 && !/linkedin|notification/i.test(text)) {
          return text;
        }
      }
    }
    return "";
  }

  function headlineFromDom() {
    const card = topCardRoot();
    if (!card) return "";

    const h1 = card.querySelector("h1");
    if (h1) {
      let sibling = h1.nextElementSibling;
      while (sibling) {
        const text = clean(sibling.textContent);
        if (
          sibling.matches?.(
            ".text-body-medium, [class*='text-body-medium'], div[data-generated-suggestion-target]"
          ) &&
          text &&
          text.length < 300
        ) {
          return text;
        }
        sibling = sibling.nextElementSibling;
      }
    }

    for (const sel of [
      ".text-body-medium.break-words",
      "div[data-generated-suggestion-target]",
      ".text-body-medium",
    ]) {
      const el = card.querySelector(sel);
      const text = clean(el?.textContent);
      if (text && text.length < 300 && !el?.closest("ul, li")) return text;
    }
    return "";
  }

  function parseHeadline(headline) {
    const value = clean(headline);
    if (!value) return { title: "", companyName: "" };

    const atMatch = value.match(/^(.+?)\s+(?:at|@)\s+(.+)$/i);
    if (atMatch) {
      const title = clean(atMatch[1]);
      const companyName = clean(atMatch[2].split(/[·|•]/)[0]);
      if (title.length > 1 && companyName.length > 1) {
        return { title, companyName };
      }
    }

    return { title: value, companyName: "" };
  }

  function normalizeCompanyName(name) {
    return clean(name)
      .replace(/\s*·.*$/, "")
      .replace(/\s*\|.*$/, "")
      .trim();
  }

  function companiesMatch(a, b) {
    if (!a || !b) return false;
    const left = a.toLowerCase();
    const right = b.toLowerCase();
    return left === right || left.includes(right) || right.includes(left);
  }

  function isValidCompanyLabel(text) {
    if (!text || text.length < 2 || text.length > 120) return false;
    return !/followers|employees|\bpresent\b|\b\d+\s*(mo|yr)s?\b|full-time|part-time|contract/i.test(text);
  }

  function resolveCompanyName({ headline, parsed, topCard, experience, embedded }) {
    const fromHeadline = normalizeCompanyName(parsed.companyName);
    const fromExp = normalizeCompanyName(experience);
    const fromTop = normalizeCompanyName(topCard);
    const fromEmbed = normalizeCompanyName(embedded);

    if (fromHeadline && /\s(?:at|@)\s/i.test(headline)) return fromHeadline;

    // Current role: first entry under Experience (most reliable after headline).
    if (fromExp) return fromExp;

    if (fromTop && fromEmbed && companiesMatch(fromTop, fromEmbed)) return fromTop;
    if (fromTop) return fromTop;
    if (fromEmbed) return fromEmbed;
    if (fromHeadline) return fromHeadline;

    return "";
  }

  function companyFromTopCard() {
    const card = topCardRoot();
    if (!card) return "";
    const scope = profileHeaderScope(card);

    const companyButton = scope.querySelector(
      'button[aria-label*="Current company" i], button[aria-label*="company" i], a[aria-label*="company" i]'
    );
    if (companyButton) {
      const label = companyButton.getAttribute("aria-label") || "";
      const fromLabel = label.match(/(?:Current company|company|at)\s*:?\s*(.+)$/i)?.[1];
      if (fromLabel) return normalizeCompanyName(fromLabel);
      const text = clean(companyButton.textContent);
      if (text && text.length < 120) return normalizeCompanyName(text);
    }

    const links = [...scope.querySelectorAll('a[href*="/company/"]')].filter(
      (link) => !link.closest("ul, li.pvs-list__paged-list-item, [data-view-name*='browsemap']")
    );
    for (const link of links) {
      const text = normalizeCompanyName(link.textContent);
      if (text && text.length > 1 && text.length < 120 && !/followers|employees/i.test(text)) {
        return text;
      }
    }
    return "";
  }

  function experienceSection() {
    const byAnchor = document.querySelector('#experience, [id*="experience-education"]');
    if (byAnchor) return byAnchor.closest("section") || byAnchor;

    const byView = document.querySelector('[data-view-name*="experience" i]');
    if (byView) return byView.closest("section") || byView;

    for (const heading of document.querySelectorAll("main h2, main h3, main span")) {
      if (!/^experience$/i.test(clean(heading.textContent))) continue;
      return heading.closest("section") || heading.parentElement?.parentElement?.parentElement;
    }

    for (const section of document.querySelectorAll("main section, main div.pvs-list__outer-container")) {
      const heading = section.querySelector("h2, h3");
      if (heading && /^experience$/i.test(clean(heading.textContent))) return section;
    }
    return null;
  }

  function isLikelyJobTitle(text) {
    if (!text) return false;
    return !/full-time|part-time|contract|internship|self-employed|freelance/i.test(text);
  }

  function splitMergedTitleCompany(value) {
    const text = clean(value);
    // e.g. FounderOpenChat → Founder + OpenChat
    const match = text.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*?)([A-Z][A-Za-z0-9][a-zA-Z0-9]*)$/);
    if (!match) return null;
    const title = clean(match[1]);
    const companyName = clean(match[2]);
    if (title.length < 2 || companyName.length < 2) return null;
    return { title, companyName };
  }

  function firstExperienceItem() {
    const section = experienceSection();
    if (!section) return null;
    return (
      section.querySelector("li.pvs-list__paged-list-item") ||
      section.querySelector("li.artdeco-list__item") ||
      section.querySelector("ul.pvs-list > li") ||
      section.querySelector("ul > li")
    );
  }

  /** Parse title + company separately from the top Experience entry. */
  function parseTopExperience() {
    const item = firstExperienceItem();
    if (!item) return { title: "", companyName: "" };

    let companyName = "";
    let title = "";

    const companyLink = item.querySelector('a[href*="/company/"]');
    if (companyLink) {
      companyName = normalizeCompanyName(companyLink.textContent);
    }

    const boldCandidates = [
      ...item.querySelectorAll(
        '.t-bold span[aria-hidden="true"], .hoverable-link-text.t-bold span[aria-hidden="true"], .mr1 span[aria-hidden="true"]'
      ),
    ];
    for (const node of boldCandidates) {
      const text = clean(node.textContent);
      if (!text || !isLikelyJobTitle(text)) continue;
      if (companyName && text.toLowerCase() === companyName.toLowerCase()) continue;
      if (!title) title = text.split(/[·•]/)[0].trim();
    }

    for (const span of item.querySelectorAll('span[aria-hidden="true"]')) {
      const raw = clean(span.textContent);
      if (!raw) continue;

      if (!companyName && raw.includes("·")) {
        const parts = raw.split(/[·•]/).map((part) => normalizeCompanyName(part));
        for (const part of parts) {
          if (isValidCompanyLabel(part) && part.toLowerCase() !== title.toLowerCase()) {
            companyName = part;
            break;
          }
        }
      }

      if (!title && isLikelyJobTitle(raw) && !raw.includes("·")) {
        const candidate = normalizeCompanyName(raw);
        if (candidate.toLowerCase() !== companyName.toLowerCase()) {
          title = candidate;
        }
      }
    }

    if (!companyName || !title) {
      for (const el of item.querySelectorAll(
        ".t-14.t-normal, .t-14.t-black--light, .text-body-small, [class*='body-small']"
      )) {
        const raw = clean(el.textContent);
        if (!raw) continue;
        if (!companyName && companyLink && el.contains(companyLink)) continue;

        if (raw.includes("·")) {
          const parts = raw.split(/[·•]/).map((part) => normalizeCompanyName(part));
          if (!companyName) {
            for (const part of parts) {
              if (isValidCompanyLabel(part) && part.toLowerCase() !== title.toLowerCase()) {
                companyName = part;
                break;
              }
            }
          }
          continue;
        }

        if (!title && isLikelyJobTitle(raw) && raw.toLowerCase() !== companyName.toLowerCase()) {
          title = normalizeCompanyName(raw);
        } else if (!companyName && isValidCompanyLabel(raw) && raw.toLowerCase() !== title.toLowerCase()) {
          companyName = normalizeCompanyName(raw);
        }
      }
    }

    const merged = splitMergedTitleCompany(companyName || title);
    if (merged) {
      if (!title || title === merged.title + merged.companyName) title = merged.title;
      if (!companyName || companyName === merged.title + merged.companyName) {
        companyName = merged.companyName;
      }
    }

    if (title && companyName && title.toLowerCase().endsWith(companyName.toLowerCase())) {
      title = clean(title.slice(0, title.length - companyName.length));
    }
    if (companyName && title && companyName.toLowerCase().startsWith(title.toLowerCase())) {
      companyName = clean(companyName.slice(title.length));
    }

    return { title: clean(title), companyName: clean(companyName) };
  }

  function companyFromExperience() {
    return parseTopExperience().companyName;
  }

  function looksLikeLocation(text) {
    if (!text || text.length < 2 || text.length > 100) return false;
    if (/connection|follower|contact info|·|\bat\b|@/i.test(text)) return false;
    // Locations are place names: letters, commas, spaces, hyphens, periods only.
    return /^[\p{L} .,'\-()]+$/u.test(text);
  }

  function locationFromDom() {
    const card = topCardRoot();
    if (!card) return "";
    const scope = profileHeaderScope(card);
    const candidates = [
      ...scope.querySelectorAll(
        ".text-body-small.inline.t-black--light.break-words, span.text-body-small.t-black--light, .pv-text-details__left-panel .text-body-small"
      ),
    ];
    for (const el of candidates) {
      if (el.closest("ul, li")) continue;
      const text = clean(el.textContent);
      if (looksLikeLocation(text)) return text;
    }
    return "";
  }

  function splitLocation(location) {
    const value = clean(location);
    if (!value) return { city: "", state: "", country: "" };
    const parts = value.split(",").map((p) => clean(p)).filter(Boolean);
    if (parts.length >= 3) {
      return { city: parts[0], state: parts[1], country: parts[parts.length - 1] };
    }
    if (parts.length === 2) {
      return { city: parts[0], state: "", country: parts[1] };
    }
    // Single token like "San Francisco Bay Area" — keep as city/region.
    return { city: parts[0] || "", state: "", country: "" };
  }

  function statFromDom(regex) {
    const scope = document.querySelector("main") || document.body;
    if (!scope) return "";
    for (const el of scope.querySelectorAll("span, a, li, p")) {
      if (el.children.length > 2) continue;
      const match = clean(el.textContent).match(regex);
      if (match?.[1]) return match[1];
    }
    return "";
  }

  function connectionsFromDom() {
    return statFromDom(/([\d,]+\+?)\s+connections?/i);
  }

  function followersFromDom() {
    return statFromDom(/([\d,]+\+?)\s+followers?/i);
  }

  function aboutFromDom() {
    const anchor = document.querySelector("#about");
    const section = anchor?.closest("section") || anchor?.parentElement?.parentElement;
    if (!section) return "";
    const el = section.querySelector(
      ".inline-show-more-text span[aria-hidden='true'], .display-flex.full-width span[aria-hidden='true'], .pv-shared-text-with-see-more span[aria-hidden='true']"
    );
    const text = clean(el?.textContent);
    if (text && text.length > 2) return text.slice(0, 2000);
    return "";
  }

  function photoFromDom() {
    const card = topCardRoot();
    const img =
      card?.querySelector("img.pv-top-card-profile-picture__image, img[class*='profile-picture'], img[class*='profile-photo']") ||
      document.querySelector("img.pv-top-card-profile-picture__image");
    const src = img?.getAttribute("src") || "";
    return /^https?:\/\//.test(src) ? src : "";
  }

  function scrapeLinkedInProfile() {
    const linkedinUrl = location.href.split("?")[0].split("#")[0];
    const isProfile =
      /linkedin\.com\/in\//i.test(linkedinUrl) || /linkedin\.com\/pub\//i.test(linkedinUrl);

    if (!isProfile) {
      return { error: "not_a_profile", linkedinUrl };
    }

    const embedded = fieldsFromPageSource(linkedinUrl);
    const fullName =
      nameFromDom() ||
      embedded.fullName ||
      nameFromJsonLd() ||
      nameFromOg() ||
      nameFromDocumentTitle() ||
      nameFromUrl(linkedinUrl) ||
      nameFromUrlVanity(linkedinUrl) ||
      "";

    const headline = headlineFromDom() || embedded.headline || "";
    const parsed = parseHeadline(headline);
    const experience = parseTopExperience();

    let title =
      parsed.title ||
      experience.title ||
      (/\s(?:at|@)\s/i.test(headline) ? "" : headline);

    let companyName = resolveCompanyName({
      headline,
      parsed,
      topCard: companyFromTopCard(),
      experience: experience.companyName,
      embedded: embedded.companyName,
    });

    if (!title && experience.title) title = experience.title;
    if (companyName && title && companyName.toLowerCase() === title.toLowerCase()) {
      companyName = experience.companyName || "";
    }

    const merged = splitMergedTitleCompany(companyName);
    if (merged) {
      if (!title) title = merged.title;
      companyName = merged.companyName;
    }

    const profileLocation = locationFromDom() || clean(embedded.location);
    const { city, state, country } = splitLocation(profileLocation);
    const about = aboutFromDom() || clean(embedded.about);
    const connections = connectionsFromDom();
    const followers = followersFromDom();
    const photoUrl = photoFromDom();

    return {
      fullName,
      title: clean(title),
      companyName: clean(companyName),
      linkedinUrl,
      headline: clean(headline),
      location: profileLocation,
      city,
      state,
      country,
      about,
      connections,
      followers,
      photoUrl,
    };
  }

  // ── Company page scraper ────────────────────────────────────────────────────

  function domTextNear(labelPattern) {
    const re = new RegExp(labelPattern, "i");
    for (const el of document.querySelectorAll("dt, th, span, div")) {
      if (el.children.length > 0) continue;
      if (!re.test(clean(el.textContent))) continue;
      const sibling = el.nextElementSibling || el.parentElement?.nextElementSibling;
      const text = clean(sibling?.textContent);
      if (text && text.length > 0 && text.length < 200) return text;
    }
    return "";
  }

  function scrapeLinkedInCompany() {
    const linkedinUrl = location.href.split("?")[0].split("#")[0];
    if (!/linkedin\.com\/company\//i.test(linkedinUrl)) {
      return { error: "not_a_company_page", linkedinUrl };
    }

    const html = document.documentElement.innerHTML;
    const slugMatch = linkedinUrl.match(/linkedin\.com\/company\/([^/?#]+)/i);
    const slug = slugMatch ? decodeURIComponent(slugMatch[1]).replace(/\/$/, "") : "";

    const nameEl = document.querySelector(
      "h1.org-top-card-summary__title, h1[class*='org-top'], main h1"
    );
    const name =
      clean(nameEl?.textContent) ||
      pickFirstMatch(html, [
        /"localizedName"\s*:\s*"((?:\\.|[^"\\])*)"/,
        /"name"\s*:\s*"((?:\\.|[^"\\])*)"/,
      ]) ||
      clean(document.title.split("|")[0]?.split(":")[0]) ||
      "";

    const websiteAnchor = document.querySelector(
      'a[data-tracking-control-name*="website"]'
    );
    let website =
      clean(websiteAnchor?.getAttribute("href") || websiteAnchor?.textContent) ||
      pickFirstMatch(html, [/"websiteUrl"\s*:\s*"((?:\\.|[^"\\])*)"/]);
    let domain = "";
    try {
      if (website) {
        const u = new URL(website.startsWith("http") ? website : `https://${website}`);
        domain = u.hostname.replace(/^www\./, "");
      }
    } catch {}

    const industry =
      pickFirstMatch(html, [
        /"localizedIndustryName"\s*:\s*"((?:\\.|[^"\\])*)"/,
        /"industryName"\s*:\s*"((?:\\.|[^"\\])*)"/,
      ]) ||
      domTextNear("industry") ||
      "";

    let employeeCount = "";
    const staffRangeMatch = html.match(/"staffCountRange"\s*:\s*\{\s*"start"\s*:\s*(\d+)[^}]*"end"\s*:\s*(\d+)/);
    if (staffRangeMatch) {
      employeeCount = `${staffRangeMatch[1]}-${staffRangeMatch[2]}`;
    } else {
      employeeCount =
        pickFirstMatch(html, [/"staffCount"\s*:\s*"?([\d,]+)"?/]) ||
        domTextNear("employees") ||
        "";
    }

    const description =
      pickFirstMatch(html, [/"description"\s*:\s*"((?:\\.|[^"\\])*)"/]) ||
      clean(document.querySelector(
        ".org-about-us-organization-description__text, .break-words.whitespace-pre-wrap"
      )?.textContent) ||
      "";

    const followers = statFromDom(/([\d,]+\+?)\s+followers?/i);

    return {
      pageType: "company",
      fullName: name,
      companyName: name,
      title: industry,
      domain,
      industry,
      employeeCount,
      description: clean(description).slice(0, 2000),
      followers,
      linkedinUrl,
      slug,
    };
  }

  // ── Post / feed author scraper ───────────────────────────────────────────────

  function scrapePostAuthor() {
    const linkedinUrl = location.href.split("?")[0].split("#")[0];

    const authorSelectors = [
      '.feed-shared-actor__container a[href*="/in/"]',
      '.update-components-actor a[href*="/in/"]',
      '.feed-shared-actor a[href*="/in/"]',
      'a.app-aware-link[href*="/in/"]:not([href*="company"])',
    ];

    let authorEl = null;
    for (const sel of authorSelectors) {
      authorEl = document.querySelector(sel);
      if (authorEl) break;
    }

    if (!authorEl) return { error: "author_not_found", linkedinUrl };

    const profileUrl = (authorEl.href || "").split("?")[0].split("#")[0];
    if (!profileUrl || !/\/in\//i.test(profileUrl)) {
      return { error: "author_not_found", linkedinUrl };
    }

    const actorContainer = authorEl.closest(
      '[class*="actor"], [class*="author"], .feed-shared-actor__container, .update-components-actor'
    );
    const nameEl = actorContainer?.querySelector(
      '[class*="actor__name"] span[aria-hidden="true"], h3 span[aria-hidden="true"], span.visually-hidden'
    );
    const fullName = clean(nameEl?.textContent) || nameFromUrl(profileUrl) || "";

    const subtitleEl = actorContainer?.querySelector(
      '[class*="actor__description"] span[aria-hidden="true"], [class*="actor__sub"] span[aria-hidden="true"]'
    );
    const subtitle = clean(subtitleEl?.textContent);
    const parsed = parseHeadline(subtitle);

    return {
      pageType: "post_author",
      fullName,
      title: parsed.title || "",
      companyName: parsed.companyName || "",
      linkedinUrl: profileUrl,
      postUrl: linkedinUrl,
      headline: subtitle,
    };
  }

  globalThis.__SKOUT_SCRAPE_LINKEDIN__ = scrapeLinkedInProfile;
  globalThis.__SKOUT_SCRAPE_LINKEDIN_COMPANY__ = scrapeLinkedInCompany;
  globalThis.__SKOUT_SCRAPE_POST_AUTHOR__ = scrapePostAuthor;
})();
