// Rendered-DOM extractors for LinkedIn person and company pages (ENR-02), ported from the
// EnrichmentTool prototype. Read-only: no network requests, clicks, scrolling or navigation,
// and no reads of inline page JSON or private APIs.
globalThis.SkoutCapturePage = (() => {
const { text, firstMatch, allMatches, metaContent, publicIdFromUrl, parseCount, textMultiline } =
  window.SkoutCaptureExtract;

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

function extractPerson() {
  const publicId = publicIdFromUrl('person');

  // LinkedIn's class names are randomly hashed per build and carry no
  // meaning — matching them is a dead end. Instead we anchor on the
  // first <h2> on the page (the name is reliably the first heading in
  // the profile's main content) and walk the surrounding structure,
  // which stays far more stable across redesigns than class names do.
  // Anchor on the profile's "Topcard" component specifically, not just
  // "the first h2 on the page" — some profiles render a hidden,
  // accessibility-only heading (e.g. "Feed post") earlier in DOM order
  // than the actual name, even though it's not first visually.
  // LinkedIn's own component ids consistently contain "Topcard"
  // regardless of the specific profile, which makes this a much more
  // reliable scope than raw document order.
  const main = document.querySelector('main') || document.body;
  // Recommendation sidebars also use headings. Only accept the dedicated
  // profile-name node (or legacy h1), never an arbitrary h2 from <main>.
  const isProfileChrome = (value) => /\b(people you may know|ad options?|why am i seeing this ad|manage your ad preferences|hide or report this ad)\b/i.test(value || '') || /^(profile|skills|all activity|activity|experience|education)$/i.test((value || '').trim());
  const visibleHeadings = Array.from(main.querySelectorAll('h1, h2'))
    .filter((el) => {
      const value = text(el);
      const rect = el.getBoundingClientRect();
      return value && !isProfileChrome(value) && rect.width > 0 && rect.height > 0 && rect.left < window.innerWidth * 0.7;
    })
    .sort((a, b) => {
      const score = (el) => {
        const nearby = text(el.closest('section, [id*="Topcard" i], [data-view-name*="profile-topcard" i]') || el.parentElement) || '';
        return (el.tagName === 'H1' ? 20 : 0) + (/open to work|contact info|followers|connections/i.test(nearby) ? 10 : 0) - (/people you may know/i.test(nearby) ? 100 : 0);
      };
      return score(b) - score(a) || a.getBoundingClientRect().top - b.getBoundingClientRect().top;
    });
  const nameHeading = main.querySelector('[data-anonymize="person-name"]') || visibleHeadings[0];
  const metadataName = metaContent('og:title')?.replace(/\s*\|\s*LinkedIn$/i, '').trim();
  const descriptionName = metaContent('description')?.match(/(?:view|see)\s+(.+?)(?:['’]s)?\s+profile\s+on\s+linkedin/i)?.[1]?.trim();
  const nameFromHeader = text(nameHeading);
  const fullName = descriptionName && !isProfileChrome(descriptionName)
    ? descriptionName
    : nameFromHeader && !isProfileChrome(nameFromHeader)
      ? nameFromHeader
      : metadataName && !isProfileChrome(metadataName)
        ? metadataName
      : undefined;
  // Do not use the entire <main> as a fallback. That was letting sidebar
  // recommendations become headline and location values.
  const topcard = nameHeading?.closest('[id*="Topcard" i], [data-view-name*="profile-topcard" i], section') || nameHeading?.parentElement?.parentElement;

  // Rather than walking a fixed number of parent levels from the name
  // (fragile — e.g. a "Verified" badge adds several extra wrapper
  // elements around the heading on some profiles), classify every <p>
  // in the topcard by its text shape and take what's left after
  // filtering out known noise (connection-degree markers, bare "·",
  // "Contact info", raw follower/connection counts). What remains, in
  // document order, is reliably [headline, position line, location].
  const allParagraphTexts = Array.from(topcard?.querySelectorAll('p') || [])
    .map((el) => text(el))
    .filter(Boolean);

  function isNoiseLine(t) {
    if (/^·\s*(1st|2nd|3rd)$/i.test(t)) return true; // connection degree
    if (t === '·') return true; // bare separator dot
    if (/^contact info$/i.test(t)) return true;
    if (/^[\d,]+\+?$/.test(t)) return true; // bare number, e.g. "500+"
    if (/^(followers?|connections?)$/i.test(t)) return true; // bare label
    if (/^[\d,]+\+?\s+(followers?|connections?)$/i.test(t)) return true; // combined count
    if (/^[a-z]{2,6}\/[a-z]{2,6}$/i.test(t)) return true; // pronoun tag, e.g. "He/Him"
    if (/^(ad options?|why am i seeing this ad\??|manage your ad preferences|hide or report this ad)$/i.test(t)) return true;
    return false;
  }

  function findCount(labelPattern) {
    const combinedRe = new RegExp(`^[\\d,]+\\+?\\s+${labelPattern}$`, 'i');
    const combined = allParagraphTexts.find((t) => combinedRe.test(t));
    if (combined) return combined;
    // Some layouts split the number and label into two adjacent
    // paragraphs instead of one combined string.
    const labelRe = new RegExp(`^${labelPattern}$`, 'i');
    const idx = allParagraphTexts.findIndex((t) => labelRe.test(t));
    if (idx > 0 && /^[\d,]+\+?$/.test(allParagraphTexts[idx - 1])) {
      return allParagraphTexts[idx - 1] + ' ' + allParagraphTexts[idx];
    }
    return undefined;
  }

  const contentLines = allParagraphTexts.filter((t) => !isNoiseLine(t) && !isProfileChrome(t) && t.toLocaleLowerCase() !== fullName?.toLocaleLowerCase());
  const headline = contentLines[0];
  const positionLine = contentLines[1]; // e.g. "Align Technology · Tel Aviv University"
  // LinkedIn sometimes gives a surrounding "company · school" container a
  // location-like attribute. That is not a geographic value.
  const isGeographicLocation = (value) => value && value.length < 140 &&
    !/[·|]/.test(value) &&
    !/\b(university|college|school|student| at |mutual connections?|people you may know)\b/i.test(value);
  const labelledLocation = text(
    topcard?.querySelector('[aria-label*="location" i], [data-view-name*="location" i]'),
  );
  // Take the first line that is actually a place: the "Company · School, City" line also has a
  // comma and comes before "City, State, Country".
  let locationName = isGeographicLocation(labelledLocation)
    ? labelledLocation
    : contentLines.find((line, index) => index > 0 && /,/.test(line) && isGeographicLocation(line) && !isProfileChrome(line));

  const followersText = findCount('followers?');
  const connectionsText = findCount('connections?');
  const relationshipContext = extractRelationshipContext(topcard);

  const openToWork = !!topcard?.querySelector('[aria-label*="Open to work" i]');

  // Deeper sections — only present once their part of the page has
  // rendered/scrolled into view; safe to call even if empty (each
  // returns [] / undefined rather than throwing).
  const experience = extractExperience();
  const currentJobs = experience.filter((e) => e.dates && /present/i.test(e.dates));
  const previousJobs = experience.filter((e) => !currentJobs.includes(e));
  // Personal sites and repository URLs can appear as an "organization" in
  // Experience. They are valid work-history text but must never become a
  // company record or current-employer link.
  const isCompanyName = (value) => !!value && !/^(https?:\/\/|www\.)/i.test(value.trim());
  const currentCompanyJobs = currentJobs.filter((job) => isCompanyName(job.company));
  if (!locationName && isGeographicLocation(currentJobs[0]?.location)) locationName = currentJobs[0].location;
  // Used by the backend to link this person to a Company record (see
  // ingest.routes.ts) — sourced from the current job's own company link
  // rather than guessed from the company name text, since names aren't
  // unique but this numeric/slug ID is.
  // Experience lazy-loads as the page scrolls. Until it has, the top card's position line
  // ("EY Technology Solutions · Guru Nanak Dev University") still names the current employer.
  if (!currentCompanyJobs.length) {
    const fromTopcard = topcardCurrentCompany(positionLine, headline);
    if (fromTopcard) currentCompanyJobs.push(fromTopcard);
  }
  const currentCompanyPublicId = currentCompanyJobs.find((j) => j.companyPublicId)?.companyPublicId;
  const roleMetadata = inferRoleMetadata(currentCompanyJobs[0]?.title || currentJobs[0]?.title || headline);
  const educations = extractEducation();
  const skills = extractSkillsSection();
  const recommendations = extractRecommendationsSection();
  const summary = extractAboutSection();
  const certifications = extractCertifications();
  const languages = extractLanguages();
  const volunteerExperiences = extractVolunteerExperience();
  const honors = extractHonors();
  const publications = extractPublications();
  const patents = extractPatents();
  const courses = extractCourses();
  const organizations = extractOrganizations();
  const contactInfo = extractContactInfo();
  const recentActivity = extractRecentActivity();

  return {
    publicId,
    sourceUrl: window.location.href.split('?')[0],
    fullName,
    headline,
    summary,
    locationName,
    connectionsCount: parseCount(connectionsText),
    followersCount: parseCount(followersText),
    relationshipContext,
    seniority: roleMetadata.seniority,
    jobFunction: roleMetadata.jobFunction,
    currentCompanyPublicId,
    currentCompanies: currentCompanyJobs.length
      ? currentCompanyJobs.map((j) => ({ name: j.company, companyPublicId: j.companyPublicId, title: j.title, dates: j.dates, location: j.location, workplaceType: j.workplaceType, employmentType: j.employmentType, description: j.description }))
      : undefined,
    previousCompanies: previousJobs.filter((j) => isCompanyName(j.company)).length
      ? previousJobs.filter((j) => isCompanyName(j.company)).map((j) => ({ name: j.company, companyPublicId: j.companyPublicId, title: j.title, dates: j.dates, location: j.location, workplaceType: j.workplaceType, employmentType: j.employmentType, description: j.description }))
      : undefined,
    educations: educations.length ? educations : undefined,
    skills: skills.length ? skills : undefined,
    recommendations: recommendations.length ? recommendations : undefined,
    certifications: certifications.length ? certifications : undefined,
    languages: languages.length ? languages : undefined,
    volunteerExperiences: volunteerExperiences.length ? volunteerExperiences : undefined,
    honors: honors.length ? honors : undefined,
    publications: publications.length ? publications : undefined,
    patents: patents.length ? patents : undefined,
    courses: courses.length ? courses : undefined,
    organizations: organizations.length ? organizations : undefined,
    // Keep the full contact section local for the review note; only the
    // validated email and phone values are sent to the capture endpoint.
    _contactInfo: contactInfo,
    email: contactInfo?.email,
    phone: contactInfo?.phone,
    _recentActivity: recentActivity.length ? recentActivity : undefined,
    openToWork: openToWork || undefined,
    _fieldsFound: countTruthy({
      fullName, headline, locationName,
      followersText, connectionsText, summary,
      experience: experience.length, educations: educations.length, skills: skills.length,
    }),
  };
}

/**
 * Current employer from the top card when Experience hasn't rendered. The position line lists
 * the current company first and the school second; a school is never taken as an employer. The
 * title comes from a "Title @ Company" / "Title at Company" headline naming the same company.
 */
function topcardCurrentCompany(positionLine, headline) {
  const name = (positionLine || '').split(/\s+·\s+/)[0]?.trim();
  if (!name || name.length > 120) return undefined;
  if (/\b(university|college|school|institute|academy|polytechnic)\b/i.test(name)) return undefined;
  if (/^(https?:\/\/|www\.)/i.test(name) || /\d+\s*(followers?|connections?)/i.test(name)) return undefined;
  const match = (headline || '').match(/^(.+?)\s+(?:@|at)\s+(.+?)(?:\s+[·|•]\s+.*)?$/i);
  const title = match && match[2].trim().toLowerCase() === name.toLowerCase() ? match[1].trim() : undefined;
  return { company: name, title, source: 'topcard' };
}

function inferRoleMetadata(value) {
  const title = (value || '').toLowerCase();
  let seniority;
  if (/\b(chief|c[eo]o|cfo|cto|cmo|coo|founder|owner|president)\b/.test(title)) seniority = 'Executive';
  else if (/\b(vp|vice president|director|head of)\b/.test(title)) seniority = 'Director';
  else if (/\b(manager|lead|principal|staff)\b/.test(title)) seniority = 'Manager';
  else if (/\b(senior|sr\.?|specialist|consultant)\b/.test(title)) seniority = 'Senior';
  else if (/\b(intern|trainee|assistant|junior|jr\.?)\b/.test(title)) seniority = 'Entry';
  let jobFunction;
  if (/\b(front[ -]?end|back[ -]?end|software|developer|engineer|devops|data scientist|technical)\b/.test(title)) jobFunction = 'Engineering';
  // Keep service and collections roles out of Sales just because a profile
  // happens to mention "associate" or customer relationships in its copy.
  // Match these before the commercial-title rules below.
  else if (/\b(customer experience|customer service|customer success|customer support|support specialist|collections?|client services?)\b/.test(title)) jobFunction = 'Customer Success';
  else if (/\b(sales|business development|account executive|sdr|bdr)\b/.test(title)) jobFunction = 'Sales';
  else if (/\b(marketing|growth|content|seo|brand)\b/.test(title)) jobFunction = 'Marketing';
  else if (/\b(hr|human resources|recruit|talent|people)\b/.test(title)) jobFunction = 'Human Resources';
  else if (/\b(finance|accountant|financial|controller)\b/.test(title)) jobFunction = 'Finance';
  else if (/\b(product|ux|ui|design)\b/.test(title)) jobFunction = 'Product';
  return { seniority, jobFunction };
}

// Relationship data is read only from the loaded profile topcard. It is not
// inferred from recommendation cards or the people-you-may-know rail.
function extractRelationshipContext(topcard) {
  if (!topcard) return undefined;
  const nodes = Array.from(topcard.querySelectorAll('p, span, div'));
  const degreeText = nodes.map((node) => text(node)).find((value) =>
    /\b(1st|2nd|3rd)(?:\s*-?\s*degree)?(?:\s+connection)?\b/i.test(value || ''),
  );
  const degreeMatch = degreeText?.match(/\b(1st|2nd|3rd)\b/i);
  const degree = degreeMatch ? Number(degreeMatch[1].charAt(0)) : undefined;
  const mutualNode = nodes.filter((node) => /\bmutual connections?\b/i.test(text(node) || '')).sort((a, b) => (text(a)?.length || 0) - (text(b)?.length || 0))[0];
  const mutualConnectionsText = text(mutualNode);
  const mutualConnections = mutualNode
    ? Array.from(mutualNode.querySelectorAll('a[href*="/in/"]')).map((link) => ({ name: text(link), profileUrl: link.href?.split('?')[0] })).filter((connection) => connection.name && connection.profileUrl)
    : [];
  const sharedCompanyText = nodes.map((node) => text(node)).find((value) =>
    /\b(you both (?:work|worked) at|both (?:work|worked) at|worked together at)\b/i.test(value || ''),
  );
  if (!degree && !mutualConnectionsText && !sharedCompanyText) return undefined;
  return { degree, isDirectConnection: degree === 1, mutualConnections: mutualConnections.length ? mutualConnections : undefined, mutualConnectionsText: mutualConnectionsText || undefined, sharedCompanyText: sharedCompanyText || undefined };
}

function extractCompany() {
  const publicId = publicIdFromUrl('company');
  const sduiTopCard = window.SkoutCompanySections.topCard();

  // Unlike person profiles, company pages use LinkedIn's older,
  // stable BEM-style class names (org-top-card-summary__...) rather
  // than randomly hashed ones — verified against real captured HTML,
  // not guessed.
  // The legacy company layout has org-top-card-summary classes; newer
  // LinkedIn pages render the company name as the main h1 instead.
  const nameEl = document.querySelector('h1.org-top-card-summary__title') ||
    document.querySelector('main [data-anonymize="company-name"]');
  const legacyName = text(nameEl) || nameEl?.getAttribute('title');
  const name = legacyName || sduiTopCard.name || text(document.querySelector('main h1'));

  const tagline = text(document.querySelector('p.org-top-card-summary__tagline')) ||
    text(nameEl?.parentElement?.querySelector('p')) ||
    sduiTopCard.tagline;

  const logoUrl = document
    .querySelector('img.org-top-card-primary-content__logo, img[class*="org-top-card-primary-content__logo"]')
    ?.getAttribute('src') || sduiTopCard.logoUrl;

  // The info-list mixes industry, an optional product-category link,
  // headquarters, followers, and an employee-count link all under the
  // same class — distinguish them by content pattern / link target
  // rather than position, since an optional item (product category)
  // would otherwise shift everything after it.
  const infoItems = Array.from(document.querySelectorAll('.org-top-card-summary-info-list__info-item')).map(
    (el) => {
      const t = text(el);
      const link = el.querySelector('a'); // product-category link is a DESCENDANT of the info-item div
      const isProductCategory = !!link && /productCategory/i.test(link.getAttribute('href') || '');
      return { text: t, isProductCategory };
    },
  );

  const followersItem = infoItems.find((i) => i.text && /followers?$/i.test(i.text));
  const employeesItem = infoItems.find((i) => i.text && /employees?$/i.test(i.text));
  const remaining = infoItems.filter((i) => i !== followersItem && i !== employeesItem && !i.isProductCategory);

  const industry = remaining[0]?.text;
  const headquarter = remaining[1]?.text;
  const followers = parseCount(followersItem?.text || sduiTopCard.followersText);
  const size = employeesItem?.text?.replace(/\s*employees?$/i, '').trim() ||
    sduiTopCard.size?.replace(/\s*employees?$/i, '').trim();

  // Website/overview — best-effort, not yet verified against real captured
  // HTML the way the topcard fields above were.
  const website = Array.from(document.querySelectorAll('.org-top-card-primary-actions a[href]')).find(a => /Visit website/i.test(a.textContent))?.href;
  const overview = window.SkoutCompanySections.clean(document.querySelector('main .org-page-details-module__card-spacing > p, main .org-about-module__description'));

  // About-tab detail list (Website/Industry/Company size/HQ/Founded/
  // Specialties) — LinkedIn's company pages use the older, stable
  // "definition list" pattern (dt label -> dd value) rather than the
  // hashed SDUI system person profiles use, so this is a more reasonable
  // guess than the profile-side selectors were on first try, but it's
  // still unverified against a real /about page capture.
  const detailMap = {};
  document.querySelectorAll('main dt').forEach((dt) => {
    const label = text(dt);
    const dd = dt.nextElementSibling;
    if (label && dd && dd.tagName === 'DD') detailMap[label.toLowerCase()] = text(dd);
  });
  const sduiAbout = window.SkoutCompanySections.aboutDetails();
  const aboutWebsite = detailMap['website'] || sduiAbout.website;
  const companyWebsite = website || aboutWebsite;
  let domain;
  try { domain = new URL(companyWebsite).hostname.replace(/^www\./, ''); } catch {}
  // An About field can have several DDs: the employee count is in the second.
  // Prefer the company-scoped employee-search URL. A generic people-search
  // link can occur in a sidebar or recommendation module and would otherwise
  // make a company capture read unrelated profiles.
  const peopleSearchLinks = Array.from(document.querySelectorAll('a[href*="/search/results/people/"]'));
  // On the newer People layout the member count is the only visible search
  // link and it may sit outside the older <main> module. Prefer that exact,
  // rendered "N associated members" control before any generic people link.
  const associatedMemberLink = peopleSearchLinks.find((link) => /[\d,]+\s+associated members/i.test(text(link) || ''));
  const employeeLink = associatedMemberLink || peopleSearchLinks.find((link) => /[?&]currentCompany=/.test(link.href)) ||
    document.querySelector('main dd a[href*="currentCompany"]') || peopleSearchLinks[0] ||
    (sduiTopCard.employeeSearchUrl ? { href: sduiTopCard.employeeSearchUrl } : undefined);
  // "501-1,000 employees" is LinkedIn's company-size band, not a member
  // count. Only persist an exact rendered employee/associated-member count.
  const employeeLinkText = text(employeeLink);
  const employeesOnLi = /^\s*[\d,]+\s+(?:associated members|employees)\s*$/i.test(employeeLinkText || '')
    ? parseCount(employeeLinkText)
    : undefined;
  const foundedAt = detailMap['founded'] || sduiAbout.foundedAt;
  const specialtiesText = detailMap['specialties'] || sduiAbout.specialties;
  const specialties = specialtiesText ? specialtiesText.split(',').map((s) => s.trim()) : undefined;

  const recentPosts = extractCompanyPosts();
  const openJobs = extractCompanyJobs();
  const products = extractCompanyProducts();
  const life = extractCompanyLife();
  const extractedPeopleStats = extractCompanyPeopleStats();
  // The About tab shows the authoritative associated-member count even when
  // LinkedIn doesn't render the People tab's graph. Preserve it so the
  // bounded paginator can size its run from the actual number (e.g. 1,141).
  const associatedMembersText = text(associatedMemberLink) || Array.from(document.querySelectorAll('main h2, main dd, main p, main span, a'))
    .map((element) => text(element))
    .find((value) => /[\d,]+\s+associated members/i.test(value || ''));
  const peopleStats = extractedPeopleStats || (associatedMembersText ? { totalEmployeesText: associatedMembersText } : undefined);
  const peopleProfiles = window.SkoutCompanySections.peopleProfiles();
  const insights = extractCompanyInsights();

  const company = {
    publicId,
    sourceUrl: window.location.href.split('?')[0],
    name,
    tagline,
    logoUrl,
    industry: detailMap['industry'] || industry || sduiAbout.industry || sduiTopCard.industry,
    headquarter: detailMap['headquarters'] || headquarter || sduiAbout.headquarter || sduiTopCard.headquarter,
    followers,
    size: detailMap['company size']?.replace(/\s*employees?$/i, '').trim() ||
      sduiAbout.size?.replace(/\s*employees?$/i, '').trim() || size,
    website: companyWebsite,
    domain,
    phone: detailMap['phone'],
    employeesOnLi,
    // Used only by the user-triggered company capture to read the rendered
    // associated-members result. It is never saved as company data.
    _peopleSearchUrl: employeeLink?.href,
    overview: overview || sduiAbout.overview,
    foundedAt,
    specialties,
    // Best-effort/unverified (see comments on the extractor functions
    // above) but wired to real backend storage — recentPosts, openJobs,
    // products, life, peopleStats all have matching Company schema
    // fields, unlike the person-side _contactInfo/_recentActivity
    // which remain preview-only for now.
    recentPosts: recentPosts.length ? recentPosts : undefined,
    openJobs: openJobs.length ? openJobs : undefined,
    products: products.length ? products : undefined,
    life: life.length ? life : undefined,
    peopleStats,
    peopleProfiles: peopleProfiles.length ? peopleProfiles : undefined,
    insights,
    _fieldsFound: countTruthy({
      name, tagline, logoUrl, industry: detailMap['industry'] || industry || sduiAbout.industry || sduiTopCard.industry,
      headquarter: detailMap['headquarters'] || headquarter || sduiAbout.headquarter || sduiTopCard.headquarter,
      followers, size, website: companyWebsite, foundedAt,
    }),
  };
  company.sectionCaptures = window.SkoutCompanySections.captures(company);
  return company;
}

function countTruthy(obj) {
  return Object.values(obj).filter((v) => v !== undefined && v !== '' && v !== 0).length;
}

// ---------------------------------------------------------------------------
// Company page sections beyond the topcard/About tab — Posts, Jobs,
// Products, Life, People (aggregate stats only), Insights. NONE of these
// are verified against real captured HTML yet (unlike the topcard fields
// above, which were tested against real MoEngage/RevyOps/Sigma/Salesforce
// captures before shipping). They're built from the same structural
// conventions that have proven reliable elsewhere in this file — reused
// where a near-identical pattern is already proven (Posts reuses the
// person-activity pattern exactly), best-effort guesses elsewhere. Treat
// anything from these functions as "probably right, not confirmed" until
// tested against a real profile that has that section populated.
// ---------------------------------------------------------------------------

/**
 * Company's own posts/updates — this reuses the exact pattern already
 * verified for a person's recent activity (update-card componentkey +
 * expandable-text-box), since LinkedIn shares that component between
 * profile and company activity feeds. Higher confidence than the other
 * new sections below, but still worth confirming on a real /posts page.
 */
/**
 * Recent posts on the company's /posts/ page. Company pages run on
 * LinkedIn's older Ember-based markup (org-top-card__*, update-components__*
 * BEM class names, plain data-urn attributes) — a different system from
 * the hashed componentkey-based SDUI markup that person-profile activity
 * uses, so this deliberately does NOT reuse the "update-card-*"
 * componentkey pattern from extractRecentActivity(). Verified against
 * real captured HTML from a populated company /posts/ page.
 */
function extractCompanyPosts() {
  const cards = document.querySelectorAll('.feed-shared-update-v2[data-urn]');
  const posts = [];
  const seen = new Set();

  cards.forEach((card) => {
    if (card.querySelector('.feed-shared-update-v2[data-urn]')) return; // carousel wrapper contains other posts
    if (posts.length >= 6) return; // "last 6 posts" — matches the Posts tab's default unpaginated view

    const urn = card.getAttribute('data-urn') || '';
    // Promoted/ad cards use urn:li:inAppPromotion:... instead of an
    // activity urn — these aren't real posts, skip them.
    if (!urn.startsWith('urn:li:activity:') || seen.has(urn)) return;

    const textEl = card.querySelector('.update-components-text .break-words');
    const postText = textMultiline(textEl);
    if (!postText) return; // image-only/video-only cards with no body text aren't useful without more work

    const isRepost = /reposted this/i.test(
      text(card.querySelector('.update-components-header__text-view')) || ''
    );

    const timeEl = card.querySelector(
      '.update-components-actor__sub-description span[aria-hidden="true"], ' +
        '.update-components-header .update-components-actor__sub-description span[aria-hidden="true"]'
    );
    const timeRaw = text(timeEl);
    const timeAgo = timeRaw ? timeRaw.split('•')[0].trim() : undefined;

    const imageEl = card.querySelector('.update-components-image__image');
    const imageUrl = imageEl ? imageEl.getAttribute('src') || undefined : undefined;

    const reactions = parseCount(text(card.querySelector('.social-details-social-counts__reactions-count')));

    let comments, reposts;
    card.querySelectorAll('.social-details-social-counts__item button[aria-label], .social-details-social-counts__item a[aria-label]').forEach((btn) => {
      const label = btn.getAttribute('aria-label') || '';
      if (/comments? on/i.test(label)) comments = parseCount(label);
      else if (/reposts? of/i.test(label)) reposts = parseCount(label);
    });

    seen.add(urn);
    const activityId = urn.replace('urn:li:activity:', '');
    posts.push({
      activityId,
      postUrl: `https://www.linkedin.com/feed/update/urn:li:activity:${activityId}/`,
      text: postText,
      isRepost,
      timeAgo,
      imageUrl,
      reactions,
      comments,
      reposts,
    });
  });

  return posts;
}

/**
 * Open job postings — anchored on job-view links (a stable URL pattern),
 * same robust technique used for Experience/Education company/school
 * links elsewhere in this file, rather than guessing card class names.
 */
/**
 * Open job postings — anchored on job-view links (a stable URL pattern
 * LinkedIn hasn't changed across the entire org-page component rewrite
 * history), same technique already proven for Experience/Education
 * company/school links elsewhere in this file, rather than guessing at
 * card class names.
 */
function extractCompanyJobs() {
  const main = document.querySelector('main');
  if (!main) return [];
  const titleSelector = '.job-card-square__title, .org-view-entity-card__title';
  const cardSelector = 'a.job-card-square__link, a[href*="/jobs/view/"], a[href*="/jobs/search-results/"]';
  const jobIdFromLink = (link) => {
    try {
      const url = new URL(link.getAttribute('href'), window.location.origin);
      if (!['www.linkedin.com', 'linkedin.com'].includes(url.hostname)) return undefined;
      const directId = url.pathname.match(/^\/jobs\/view\/(\d+)\/?$/)?.[1];
      if (directId) return directId;
      if (!/^\/jobs\/search-results\/?$/.test(url.pathname)) return undefined;
      const id = url.searchParams.get('currentJobId');
      return /^\d+$/.test(id || '') ? id : undefined;
    } catch { return undefined; }
  };
  const cardText = (el) => {
    if (!el) return undefined;
    const clone = el.cloneNode(true);
    clone.querySelectorAll('.visually-hidden, svg').forEach(node => node.remove());
    return text(clone) || undefined;
  };
  const jobs = new Map();
  // Walk known title markup, including placeholder href="#" carousel cards.
  // Stop at a card boundary before inspecting siblings from another job.
  main.querySelectorAll(titleSelector).forEach(titleEl => {
    let card = titleEl;
    while (card.parentElement && card.parentElement !== main &&
      card.parentElement.querySelectorAll(titleSelector).length === 1) {
      card = card.parentElement;
      if (card.matches('li, .job-card-square, .org-view-entity-card')) break;
    }
    const links = [...(card.matches(cardSelector) ? [card] : []), ...card.querySelectorAll(cardSelector)];
    const jobId = links.map(jobIdFromLink).find(Boolean);
    // Non-job org-view-entity-card entries must not become job records.
    if (!jobId && !links.some(link => link.matches('a.job-card-square__link'))) return;
    const title = cardText(titleEl.querySelector('strong')) || cardText(titleEl);
    if (!title) return;
    const location = cardText(card.querySelector('.job-card-container__metadata-wrapper, .org-view-entity-card__subtitle'));
    const metadata = cardText(card.querySelector('.artdeco-entity-lockup__metadata'));
    const workplaceType = [location, metadata].filter(Boolean).join(' ').match(/\b(remote|hybrid|on-site)\b/i)?.[1];
    const time = card.querySelector('.job-card-container__listed-time time');
    const postedText = cardText(time) || metadata?.match(/\b\d+\s*(?:hour|day|week|month)s?\s*ago\b/i)?.[0];
    const job = { jobId, jobUrl: jobId ? `https://www.linkedin.com/jobs/view/${jobId}/` : undefined,
      title, location, workplaceType, postedText, postedAt: time?.getAttribute('datetime') || undefined,
      companyName: cardText(card.querySelector('.job-card-container__company-name')) };
    const key = jobId || JSON.stringify([title, location]);
    const previous = jobs.get(key) || {};
    jobs.set(key, {...previous, ...Object.fromEntries(Object.entries(job).filter(([, value]) => value !== undefined))});
  });
  return [...jobs.values()];
}

function extractCompanyProducts() {
  return window.SkoutCompanySections.products();
}

/** Company spotlight text verified on Salesforce Life. */
function extractCompanyLife() {
  return window.SkoutCompanySections.life();
}

/** Aggregate totals and loaded bar-chart rows; no employee card extraction. */
function extractCompanyPeopleStats() {
  return window.SkoutCompanySections.people();
}

/** Visible Premium growth summary; full tables are stored in sectionCaptures. */
function extractCompanyInsights() {
  const premium = window.SkoutCompanySections.section(/^Exclusive insights on /);
  const stats = premium?.querySelector('.aiq-premium-insights-module-card__statistics-container');
  const value = window.SkoutCompanySections.clean(stats);
  return value && /\d/.test(value) ? {headcountGrowthText:value} : undefined;
}

// ---------------------------------------------------------------------------
// Deeper profile sections — Experience, Education, Skills, Recommendations,
// About. Each verified against real captured LinkedIn HTML before shipping,
// same as the topcard extractor above.
// ---------------------------------------------------------------------------

function getExpandableText(container) {
  const span = container.querySelector('[data-testid="expandable-text-box"]');
  if (!span) return undefined;
  const clone = span.cloneNode(true);
  clone.querySelectorAll('button').forEach((b) => b.remove());
  return text(clone);
}

// <p> elements that belong to this item's own info (title/company/dates/
// location), excluding ones nested inside a description span or an
// endorsement/skills link — those are handled separately.
function getItemParagraphs(item) {
  return Array.from(item.querySelectorAll('p'))
    .filter((p) => {
      if (p.querySelector('[data-testid="expandable-text-box"]')) return false;
      if (p.querySelector('a[href*="skill-associations-details"]')) return false;
      if (p.querySelector('a[href*="/endorsers/"]')) return false;
      return true;
    })
    .map((p) => text(p))
    .filter(Boolean);
}

const EMPLOYMENT_TYPES = /^(full-time|part-time|self-employed|freelance|contract|internship|apprenticeship|seasonal)$/i;
const WORKPLACE_TYPES = /\b(remote|hybrid|on[- ]site)\b/i;

function companyPublicIdFromEntry(item) {
  const href = item.querySelector('a[href*="/company/"]')?.getAttribute('href');
  if (!href) return undefined;
  const match = href.match(/\/company\/([^/?]+)/);
  return match?.[1];
}

/**
 * The profile preview marks its sections `...TopLevelSection`; the /details/<section>/ pages
 * (opened when LinkedIn shows "Show all") mark them `...DetailsSection`. Without either, fall
 * back to the section under this page's own heading, never outside <main>.
 */
function profileSection(name) {
  const main = document.querySelector('main') || document.body;
  const detailKey = name === 'Skills' ? 'SkillDetails' : `${name}Details`;
  const keyed = main.querySelector(
    `[componentkey*="${name}TopLevelSection" i], [componentkey*="${name}DetailsSection" i], [componentkey*="${detailKey}" i]`,
  );
  if (keyed) return keyed;
  const titleMatch = (node) => new RegExp(`^${name}$`, 'i').test(text(node) || '');
  let heading = Array.from(main.querySelectorAll('h1, h2, h3, [role="heading"]')).find(titleMatch);
  // Current /details/<section>/ pages render the page title as a plain <p>
  // with no section marker. Accept a leaf paragraph title only on that page.
  if (!heading && location.pathname.toLowerCase().includes(`/details/${name.toLowerCase()}/`)) {
    heading = Array.from(main.querySelectorAll('p, span, div, h4'))
      .find((node) => !Array.from(node.children).some((child) => text(child)) && titleMatch(node));
  }
  if (!heading) return undefined;
  const semanticContainer = heading.closest('section, [role="region"], [data-view-name*="profile-component" i]');
  if (semanticContainer) return semanticContainer;

  // Some LinkedIn layouts use only generic divs around a section heading. Walk
  // up while the subtree still belongs to this heading, but never use all of
  // <main> (which also contains recommendations and other people's content).
  let container = heading.parentElement;
  let candidate = container;
  while (container && container !== main) {
    const headings = container.querySelectorAll('h1, h2, h3, [role="heading"]');
    if (headings.length > 1) break;
    // Never pull in sidebars such as "People also viewed".
    if (container.querySelector('aside') || /\bpeople (?:also viewed|you may know)\b/i.test(text(container) || '')) break;
    candidate = container;
    container = container.parentElement;
  }
  return candidate || undefined;
}

function extractExperience() {
  const section = profileSection('Experience');
  if (!section) return [];
  let items = Array.from(section.querySelectorAll('[componentkey^="entity-collection-item"]'));
  if (!items.length) {
    // Rows without component keys: one per company link, scoped to its own list item.
    const rows = new Set();
    section.querySelectorAll('a[href*="/company/"]').forEach((anchor) => {
      const row = anchor.closest('li, [data-view-name*="profile-component-entity" i]');
      if (row && section.contains(row)) rows.add(row);
    });
    items = [...rows];
  }
  const results = [];
  const isExperienceNoise = value => !value || /^(ad options?|why am i seeing this ad\??|manage your ad preferences|hide or report this ad|skills|profile|untitled role)$/i.test(value.trim());
  const addExperience = entry => {
    if (!entry.title || isExperienceNoise(entry.title) || isExperienceNoise(entry.company)) return;
    results.push(entry);
  };

  items.forEach((item) => {
    // Some entries group multiple roles at one company under a shared
    // header, with each role as a separate <li> in a <ul> — verified
    // against a real profile with two roles at the same employer.
    const roleList = item.querySelector('ul');
    const companyPublicId = companyPublicIdFromEntry(item);

    if (roleList) {
      const headerParas = Array.from(item.querySelectorAll('p'))
        .filter((p) => !roleList.contains(p))
        .map((p) => text(p))
        .filter(Boolean);
      const company = headerParas[0];
      const roles = roleList.querySelectorAll(':scope > li');
      roles.forEach((li) => {
        const paras = getItemParagraphs(li);
        const title = paras[0];
        const rest = paras.slice(1);
        const employmentType = rest.find((p) => EMPLOYMENT_TYPES.test(p));
        const dates = rest.find((p) => /\d{4}|present/i.test(p));
        const locationLine = rest.find((p) => p !== employmentType && p !== dates);
        const workplaceType = locationLine?.match(WORKPLACE_TYPES)?.[1]?.replace('-', ' ');
        const location = locationLine?.replace(/\s*[·|]\s*(remote|hybrid|on[- ]site)\s*$/i, '').trim();
        const description = getExpandableText(li);
        addExperience({ title, company, companyPublicId, employmentType, dates, location, workplaceType, description });
      });
    } else {
      const paras = getItemParagraphs(item);
      const title = paras[0];
      const companyAndType = paras[1];
      const [company, employmentType] = (companyAndType || '').split(' · ');
      const dates = paras.find((p, i) => i >= 2 && /\d{4}|present/i.test(p));
      const locationLine = paras.find((p, i) => i >= 2 && p !== dates);
      const workplaceType = locationLine?.match(WORKPLACE_TYPES)?.[1]?.replace('-', ' ');
      const location = locationLine?.replace(/\s*[·|]\s*(remote|hybrid|on[- ]site)\s*$/i, '').trim();
      const description = getExpandableText(item);
      addExperience({ title, company, companyPublicId, employmentType, dates, location, workplaceType, description });
    }
  });

  return results;
}

function extractEducation() {
  const section = profileSection('Education');
  if (!section) return [];
  const seen = new Set();
  const results = [];
  const isBadSchool = (value) => {
    const candidate = (value || '').replace(/\s+/g, ' ').trim();
    return !candidate || /^(?:·\s*)?(?:1st|2nd|3rd|education|profile)$/i.test(candidate) ||
      /^(people you may know|all activity|ad options|hide or report this ad)$/i.test(candidate);
  };
  // Never climb outside the Education section. A loose climb can reach the
  // profile header and turn connection degree, headline, and About text
  // into an education record. Rows come from school links and, on current
  // detail pages, from keyed rows that render a school without a link.
  const containers = [
    ...Array.from(section.querySelectorAll('a[href*="/school/"]'))
      .map((a) => a.closest('[componentkey^="entity-collection-item" i], li') || a.parentElement),
    ...Array.from(section.querySelectorAll('[componentkey^="entity-collection-item" i]')),
    ...Array.from(section.querySelectorAll('[data-view-name*="profile-component-entity" i], li')),
    ...Array.from(section.querySelectorAll('[id]'))
      .filter((node) => /^com\.linkedin\.sdui\.profile\.education\(/i.test(node.id)),
  ];
  // Some profile layouts render education rows as plain nested divs without a
  // school link or LinkedIn component marker. Accept only the innermost groups
  // with multiple text-bearing children so a wrapper containing several rows
  // is never treated as one education record.
  const genericContainers = new Set(
    Array.from(section.querySelectorAll('div')).filter((container) => {
      const textChildren = Array.from(container.children).filter((child) => text(child));
      return textChildren.length >= 2;
    }),
  );
  const genericRows = [...genericContainers].filter((container) => {
    return ![...genericContainers].some((other) => other !== container && container.contains(other));
  });
  containers.push(...genericRows);
  containers.forEach((container) => {
    if (!container || !section.contains(container)) return;
    // A row and an element nested in it are the same entry; read it once.
    if ([...seen].some((done) => done === container || done.contains(container) || container.contains(done))) return;
    seen.add(container);
    const paras = getItemParagraphs(container);
    const schoolLink = container.querySelector('a[href*="/school/"]');
    const labels = Array.from(container.querySelectorAll('a, p, span, h3, h4, div, [aria-label]'))
      .filter((node) => !Array.from(node.children).some((child) => text(child)))
      .map((node) => text(node))
      .filter((value, index, all) => value && all.indexOf(value) === index);
    // The section title bar ("Back", "Education") is not a record.
    if (!schoolLink && labels.some((label) => /^education$/i.test(label))) return;
    const school = text(schoolLink) || paras[0] || labels[0];
    if (isBadSchool(school)) return;
    const detailLines = paras.length ? paras : labels;
    const dates = detailLines.find((p) => p !== school && /\b(?:19|20)\d{2}\b/.test(p));
    const degree = detailLines.find((p) => p !== school && p !== dates && p && !/^\d+(?:st|nd|rd)\b/i.test(p) && !/^activities and societies:/i.test(p));
    const activities = detailLines.find((p) => /^activities and societies:/i.test(p));
    const description = getExpandableText(container);
    results.push({ school, degree, dates, activities, description });
  });
  if (!results.length) {
    const visible = Array.from(section.querySelectorAll('p, span, h3, h4'))
      .map((node) => text(node))
      .filter((value, index, all) => value && all.indexOf(value) === index)
      .filter((value) => !/^education$/i.test(value));
    const school = visible[0];
    if (!isBadSchool(school)) {
      const dates = visible.find((value, index) => index > 0 && /\b(?:19|20)\d{2}\b/.test(value));
      const degree = visible.find((value, index) =>
        index > 0 && value !== dates && !/^activities and societies:/i.test(value),
      );
      const activities = visible.find((value) => /^activities and societies:/i.test(value));
      results.push({ school, degree, dates, activities });
    }
  }
  return results;
}

function extractSkillsSection() {
  // The profile preview and /details/skills/ use different component keys.
  // Scope the fallback to the closest Skills heading so names from sidebars
  // and recommendations cannot be saved as skills.
  const skillsHeading = Array.from((document.querySelector('main') || document).querySelectorAll('h1, h2, h3, [role="heading"]'))
    .find((heading) => /^skills$/i.test(text(heading) || ''));
  const section = profileSection('Skills') || skillsHeading?.closest('section');
  if (!section) return [];
  const explicitItems = [
    ...Array.from(section.querySelectorAll('[id^="com.linkedin.sdui.profile.skill(" i], [componentkey^="entity-collection-item" i], [data-view-name*="profile-component-entity" i]')),
    ...Array.from(section.querySelectorAll('a[href*="/skill-insights/"]'))
      .map((anchor) => anchor.closest('li, [componentkey^="entity-collection-item" i], [data-view-name*="profile-component-entity" i]') || anchor.parentElement),
  ].filter((item, index, all) => item && all.indexOf(item) === index);
  // Detail pages use nested entity components: the innermost component often
  // holds only "Endorsed by…", while its parent holds the actual skill name.
  // Prefer semantic list rows, then a minimal entity that contains a skill
  // insight link. This preserves the label rather than storing the endorsement
  // caption as though it were a skill.
  const listRows = Array.from(section.querySelectorAll('li')).filter((item) =>
    !Array.from(item.querySelectorAll('li')).some((child) => child !== item),
  );
  const insightRows = explicitItems.filter((item) => item.querySelector('a[href*="/skill-insights/"]'));
  const items = listRows.length ? listRows : (insightRows.length ? insightRows : explicitItems);
  const isSkillLabel = (value) => {
    const candidate = (value || '').trim();
    return !!candidate && candidate.length <= 160 &&
      !/^\d+[+,]?\s+endorsement/i.test(candidate) &&
      !/^endorsed by\b/i.test(candidate) &&
      !/^\d+ experiences? at\b/i.test(candidate) &&
      !/^(?:experience|education|skills|all)$/i.test(candidate) &&
      !/^(show all|show more|skills?|top skills?)$/i.test(candidate) &&
      !/^\d+[+,]?$/.test(candidate);
  };
  const skills = items
    .map((item) => {
      // LinkedIn varies between anchors, paragraphs, and plain spans for the
      // skill label. Prefer the shortest meaningful descendant text; the
      // endorsement caption is explicitly excluded above.
      const labelElements = Array.from(item.querySelectorAll('a, p, span, h3, h4, div'))
        .filter((element) => isSkillLabel(text(element)))
        .filter((element) => !Array.from(element.children).some((child) => isSkillLabel(text(child))));
      const labels = labelElements
        .map((element) => text(element))
        .filter((value, index, all) => all.indexOf(value) === index);
      // Each Skills row starts with its name. Later labels describe where the
      // skill was used or who endorsed it, so preserve DOM order here.
      // LinkedIn shows the skill first in the row; the remaining meaningful
      // strings are jobs, schools, or endorsement context. If a nested row
      // did not include a name it is discarded instead of becoming a bogus
      // "Endorsed by…" skill.
      const name = labels[0];
      const endorsementText = Array.from(item.querySelectorAll('a'))
        .map((a) => text(a))
        .find((t) => /^\d+ endorsement/i.test(t || ''));
      const endorsements = endorsementText ? parseInt(endorsementText, 10) : undefined;
      return { name, endorsements };
    })
    .filter((s) => isSkillLabel(s.name));
  // A few layouts render a plain paragraph/span list without semantic rows or
  // skill links. Fall back when structured rows did not yield labels.
  if (!skills.length) {
    skills.push(
      ...Array.from(section.querySelectorAll('p, span, h3, h4, div'))
        .filter((element) => !element.children.length)
        .map((element) => ({ name: text(element), endorsements: undefined }))
        .filter((skill) => isSkillLabel(skill.name)),
    );
  }
  // Current LinkedIn Skills detail pages mix a keyed first skill row with
  // standalone paragraph rows. Include those rendered labels even when one
  // structured row was found, rather than silently dropping the rest.
  skills.push(
    ...Array.from(section.querySelectorAll('p, span, h3, h4'))
      .filter((element) => !element.children.length)
      .map((element) => ({ name: text(element), endorsements: undefined }))
      .filter((skill) => isSkillLabel(skill.name)),
  );
  const unique = new Map();
  for (const skill of skills) {
    const key = skill.name.trim().toLowerCase();
    const existing = unique.get(key);
    if (!existing || (skill.endorsements || 0) > (existing.endorsements || 0)) unique.set(key, skill);
  }
  return [...unique.values()];
}

function extractRecommendationsSection() {
  const section = document.querySelector('[componentkey*="RecommendationsTopLevel" i]');
  if (!section) return [];
  const links = section.querySelectorAll('a[href*="/in/"]');
  return Array.from(links)
    .map((a) => {
      const paras = getItemParagraphs(a);
      const recommenderName = paras[0];
      const recommenderTitle = paras.find(
        (p, i) => i > 0 && !/^·/.test(p) && !/reported to|worked with|managed/i.test(p),
      );
      const context = paras.find((p) => /reported to|worked with|managed/i.test(p));
      const recommendationText = getExpandableText(a);
      return { recommenderName, recommenderTitle, context, text: recommendationText };
    })
    .filter((r) => r.recommenderName);
}

function extractAboutSection() {
  const section = Array.from(document.querySelectorAll('[componentkey]')).find((el) =>
    /About/i.test(el.getAttribute('componentkey') || ''),
  );
  if (!section) return undefined;
  return getExpandableText(section);
}

// ---------------------------------------------------------------------------
// BEST-EFFORT sections below — built from the same structural patterns that
// worked for Experience/Education/Recommendations (componentkey scoping,
// entity-collection-item children, expandable-text-box descriptions), but
// NOT yet verified against real captured HTML the way everything above was.
// LinkedIn's own componentkey naming for each of these was confirmed present
// in real captures (e.g. "...CertificationTopLevel", "...VolunteerExperienceTopLevel")
// even when the section itself was empty for the profiles we captured — so
// the scoping should be right, but the internal field layout is inferred,
// not proven. If a field comes back wrong or empty on a profile that visibly
// has that section filled in, send the real HTML the same way as before and
// it'll get fixed the same way everything above did.
// ---------------------------------------------------------------------------

function extractGenericEntities(componentkeySubstring) {
  const section = document.querySelector(`[componentkey*="${componentkeySubstring}" i]`);
  if (!section) return [];
  const items = section.querySelectorAll('[componentkey^="entity-collection-item"], [id^="com.linkedin.sdui.profile." i]');
  return Array.from(items).map((item) => ({
    paragraphs: getItemParagraphs(item),
    description: getExpandableText(item),
  }));
}

function extractCertifications() {
  return extractGenericEntities('CertificationTopLevel').map(({ paragraphs, description }) => {
    const name = paragraphs[0];
    const issuer = paragraphs[1];
    const dateLine = paragraphs.find((p, i) => i >= 2 && /\d{4}/.test(p));
    const credentialIdLine = paragraphs.find((p) => /credential id/i.test(p));
    return {
      name,
      issuer,
      dates: dateLine,
      credentialId: credentialIdLine?.replace(/credential id:?\s*/i, ''),
      description,
    };
  });
}

function extractLanguages() {
  return extractGenericEntities('LanguageTopLevel').map(({ paragraphs }) => ({
    language: paragraphs[0],
    proficiency: paragraphs[1],
  }));
}

function extractVolunteerExperience() {
  // Volunteer entries follow the same role/org/dates/description shape as
  // Experience, so reuse the same positional logic.
  const section = document.querySelector('[componentkey*="VolunteerExperienceTopLevel" i]');
  if (!section) return [];
  const items = section.querySelectorAll('[componentkey^="entity-collection-item"]');
  return Array.from(items).map((item) => {
    const paras = getItemParagraphs(item);
    const role = paras[0];
    const orgAndCause = paras[1];
    const [organization, cause] = (orgAndCause || '').split(' · ');
    const dates = paras.find((p, i) => i >= 2 && /\d{4}|present/i.test(p));
    const description = getExpandableText(item);
    return { role, organization, cause, dates, description };
  });
}

function extractHonors() {
  return extractGenericEntities('HonorsTopLevel').map(({ paragraphs, description }) => ({
    title: paragraphs[0],
    issuer: paragraphs[1],
    date: paragraphs.find((p, i) => i >= 2 && /\d{4}/.test(p)),
    description,
  }));
}

function extractPublications() {
  return extractGenericEntities('PublicationTopLevelSection').map(({ paragraphs, description }) => ({
    title: paragraphs[0],
    publisher: paragraphs[1],
    date: paragraphs.find((p, i) => i >= 2 && /\d{4}/.test(p)),
    description,
  }));
}

function extractPatents() {
  return extractGenericEntities('Patents').map(({ paragraphs, description }) => ({
    title: paragraphs[0],
    patentOffice: paragraphs[1],
    date: paragraphs.find((p, i) => i >= 2 && /\d{4}/.test(p)),
    description,
  }));
}

function extractCourses() {
  return extractGenericEntities('CourseTopLevelSection').map(({ paragraphs }) => ({
    name: paragraphs[0],
    number: paragraphs[1],
  }));
}

function extractOrganizations() {
  return extractGenericEntities('Organizations').map(({ paragraphs, description }) => ({
    name: paragraphs[0],
    role: paragraphs[1],
    dates: paragraphs.find((p, i) => i >= 2 && /\d{4}|present/i.test(p)),
    description,
  }));
}

/**
 * Contact Info — LinkedIn shows this in a click-to-open modal, not on the
 * base page. We deliberately don't auto-click it. Only a visible modal is
 * read, and its values are sent only after the user reviews and saves capture.
 */
function extractContactInfo() {
  const candidates = [
    ...document.querySelectorAll('[aria-label*="contact info" i], [aria-labelledby*="contact-info" i]'),
    ...Array.from(document.querySelectorAll('[role="dialog"]')).filter((dialog) =>
      Array.from(dialog.querySelectorAll('h1, h2, h3, h4, [role="heading"]'))
        .some((heading) => /^contact info$/i.test(text(heading) || '')),
    ),
  ];
  const modal = [...new Set(candidates)].find((candidate) => {
    const style = window.getComputedStyle(candidate);
    const rect = candidate.getBoundingClientRect();
    return !candidate.closest('[aria-hidden="true"]') &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0" &&
      rect.width > 0 &&
      rect.height > 0;
  });
  if (!modal) return undefined;
  const website = modal.querySelector('a[href^="http"]:not([href*="linkedin.com"])')?.href;
  const emailLink = modal.querySelector('a[href^="mailto:"]')?.getAttribute('href')?.replace(/^mailto:/i, '').split('?')[0];
  const emailMatch = modal.textContent.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  const telLink = modal.querySelector('a[href^="tel:"]');
  let phone;
  if (telLink) {
    const rawPhone = telLink.getAttribute('href').replace(/^tel:/i, '');
    try {
      phone = decodeURIComponent(rawPhone);
    } catch {
      phone = rawPhone;
    }
  } else {
    phone = modal.textContent.match(/\+?\d[\d\s().-]{7,}\d/)?.[0]?.trim();
  }
  return {
    website,
    email: emailLink || emailMatch?.[0],
    phone,
  };
}

/**
 * Recent activity/posts. Verified structurally against real captured HTML
 * (unlike the sections above) — LinkedIn's post cards follow a consistent
 * pattern of componentkey="update-card-..." with the post text inside an
 * expandable-text-box and reaction/comment counts nearby.
 */
function extractRecentActivity() {
  // Update cards elsewhere on a profile page can be recommendations,
  // reposts, or feed modules. Read them only from this person's Activity
  // component; no section means no activity is captured.
  const activitySection = Array.from(document.querySelectorAll('[componentkey]')).find((el) =>
    /RecentActivity|ActivityTopLevel/i.test(el.getAttribute('componentkey') || ''),
  );
  if (!activitySection) return [];
  const posts = activitySection.querySelectorAll('[componentkey^="update-card-"]');
  return Array.from(posts)
    .map((post) => {
      const postText = getExpandableText(post);
      const allText = Array.from(post.querySelectorAll('p')).map((p) => text(p));
      const timeAgo = allText.find((t) => t && /^\d+[hdwmoy]\b/i.test(t));
      const commentsText = allText.find((t) => t && /^\d+\s+comments?$/i.test(t));
      const reactionsText = allText.find((t) => t && /reacted$/i.test(t));
      return {
        text: postText,
        timeAgo,
        comments: commentsText ? parseInt(commentsText, 10) : undefined,
        reactionsSummary: reactionsText,
      };
    })
    .filter((p) => p.text);
}


  return { extractPerson, extractCompany };
})();
