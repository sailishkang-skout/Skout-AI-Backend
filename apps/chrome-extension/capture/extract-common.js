// lib/extract-common.js
//
// Pure DOM-reading helpers. Nothing here makes network requests, clicks
// anything, scrolls, or navigates — it only reads text/attributes that
// are already rendered in the page the human has open.
//
// LinkedIn's class names are auto-generated and change periodically.
// These selectors are written defensively (multiple fallback selectors
// per field) but will need occasional maintenance — see README.md
// "Keeping selectors up to date".

window.SkoutCaptureExtract = (function () {
  function text(el) {
    return el ? el.textContent.trim().replace(/\s+/g, ' ') : undefined;
  }

  function firstMatch(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return undefined;
  }

  function allMatches(selectors) {
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      if (els.length) return Array.from(els);
    }
    return [];
  }

  function metaContent(name) {
    const el =
      document.querySelector(`meta[property="${name}"]`) ||
      document.querySelector(`meta[name="${name}"]`);
    return el ? el.getAttribute('content') || undefined : undefined;
  }

  /** Pulls the LinkedIn publicId (the /in/xxxxx or /company/xxxxx slug) from the URL. */
  function publicIdFromUrl(kind) {
    const path = window.location.pathname; // e.g. /in/jane-doe-3b2a1/ or /company/acme-corp/
    const marker = kind === 'person' ? '/in/' : '/company/';
    const idx = path.indexOf(marker);
    if (idx === -1) return undefined;
    const rest = path.slice(idx + marker.length);
    return rest.split('/')[0] || undefined;
  }

  /**
   * Like text(), but preserves <br> line breaks instead of collapsing
   * them into a single space. Needed for feed post bodies, which use
   * literal <br> tags between paragraphs rather than nested block
   * elements.
   */
  function textMultiline(el) {
    if (!el) return undefined;
    const clone = el.cloneNode(true);
    clone.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
    const raw = clone.textContent || '';
    return raw
      .replace(/\r/g, '')
      .split('\n')
      .map((line) => line.trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim() || undefined;
  }

  /** Best-effort integer parse from strings like "1,204 followers" or "500+ connections". */
  function parseCount(str) {
    if (!str) return undefined;
    const cleaned = str.replace(/,/g, '').match(/[\d.]+([KkMm])?/);
    if (!cleaned) return undefined;
    let [num, suffix] = [parseFloat(cleaned[0]), cleaned[1]];
    if (suffix && /k/i.test(suffix)) num *= 1000;
    if (suffix && /m/i.test(suffix)) num *= 1000000;
    return Math.round(num);
  }

  /**
   * A website link a person or company published, or undefined. LinkedIn wraps outbound links in
   * /redir/redirect?url=..., which is unwrapped; only http(s) addresses outside LinkedIn are kept,
   * with tracking parameters and fragments removed.
   */
  function cleanWebsite(value, base) {
    if (!value || typeof value !== 'string') return undefined;
    const raw = value.trim();
    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw);
    let url;
    let rewritten = false;
    try {
      // A root-relative link ("/redir/redirect?url=...") belongs to the page; a bare "ey.com" is a host.
      url = new URL(hasScheme || raw.startsWith('/') ? raw : `https://${raw}`, base || window.location.href);
      if (/(^|\.)linkedin\.com$/i.test(url.hostname) && /^\/redir\/redirect\/?$/i.test(url.pathname)) {
        url = new URL(url.searchParams.get('url') || '');
        rewritten = true;
      }
    } catch { return undefined; }
    const host = url.hostname.toLowerCase();
    if (!/^https?:$/.test(url.protocol) || !host.includes('.') || /\s/.test(host)) return undefined;
    if (/(^|\.)(linkedin\.com|lnkd\.in|licdn\.com)$/.test(host)) return undefined;
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|trk|trackingid|refid|originalsubdomain)/i.test(key)) { url.searchParams.delete(key); rewritten = true; }
    }
    if (url.hash) { url.hash = ''; rewritten = true; }
    // An address that needed no cleaning is kept exactly as LinkedIn showed it.
    const clean = rewritten ? url.toString() : hasScheme ? raw : `https://${raw}`;
    return clean.length <= 2000 ? clean : undefined;
  }


  // ── Country from a place ("Bengaluru, Karnataka", "Austin, TX", "London") ──
  const COUNTRIES = ['Afghanistan','Albania','Algeria','Andorra','Angola','Argentina','Armenia','Australia','Austria','Azerbaijan','Bahamas','Bahrain','Bangladesh','Barbados','Belarus','Belgium','Belize','Benin','Bhutan','Bolivia','Bosnia and Herzegovina','Botswana','Brazil','Brunei','Bulgaria','Burkina Faso','Burundi','Cambodia','Cameroon','Canada','Cape Verde','Chad','Chile','China','Colombia','Costa Rica','Croatia','Cuba','Cyprus','Czechia','Denmark','Djibouti','Dominican Republic','Ecuador','Egypt','El Salvador','Estonia','Eswatini','Ethiopia','Fiji','Finland','France','Gabon','Gambia','Georgia','Germany','Ghana','Greece','Guatemala','Guinea','Guyana','Haiti','Honduras','Hong Kong','Hungary','Iceland','India','Indonesia','Iran','Iraq','Ireland','Israel','Italy','Jamaica','Japan','Jordan','Kazakhstan','Kenya','Kosovo','Kuwait','Kyrgyzstan','Laos','Latvia','Lebanon','Lesotho','Liberia','Libya','Liechtenstein','Lithuania','Luxembourg','Macau','Madagascar','Malawi','Malaysia','Maldives','Mali','Malta','Mauritania','Mauritius','Mexico','Moldova','Monaco','Mongolia','Montenegro','Morocco','Mozambique','Myanmar','Namibia','Nepal','Netherlands','New Zealand','Nicaragua','Niger','Nigeria','North Macedonia','Norway','Oman','Pakistan','Panama','Papua New Guinea','Paraguay','Peru','Philippines','Poland','Portugal','Puerto Rico','Qatar','Romania','Russia','Rwanda','Saudi Arabia','Senegal','Serbia','Seychelles','Sierra Leone','Singapore','Slovakia','Slovenia','Somalia','South Africa','South Korea','Spain','Sri Lanka','Sudan','Suriname','Sweden','Switzerland','Syria','Taiwan','Tajikistan','Tanzania','Thailand','Togo','Trinidad and Tobago','Tunisia','Turkey','Turkmenistan','Uganda','Ukraine','United Arab Emirates','United Kingdom','United States','Uruguay','Uzbekistan','Venezuela','Vietnam','Yemen','Zambia','Zimbabwe'];
  const COUNTRY_ALIASES = {
    'usa': 'United States', 'us': 'United States', 'u.s.': 'United States', 'u.s.a.': 'United States', 'united states of america': 'United States', 'america': 'United States',
    'uk': 'United Kingdom', 'u.k.': 'United Kingdom', 'great britain': 'United Kingdom', 'britain': 'United Kingdom', 'england': 'United Kingdom', 'scotland': 'United Kingdom', 'wales': 'United Kingdom', 'northern ireland': 'United Kingdom',
    'uae': 'United Arab Emirates', 'u.a.e.': 'United Arab Emirates', 'emirates': 'United Arab Emirates',
    'czech republic': 'Czechia', 'korea': 'South Korea', 'republic of korea': 'South Korea', 'türkiye': 'Turkey', 'turkiye': 'Turkey',
    'holland': 'Netherlands', 'the netherlands': 'Netherlands', 'russian federation': 'Russia', 'viet nam': 'Vietnam',
    'deutschland': 'Germany', 'españa': 'Spain', 'brasil': 'Brazil', 'méxico': 'Mexico', 'ksa': 'Saudi Arabia', 'prc': 'China', 'mainland china': 'China',
  };
  const US_STATES = {AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',DC:'District of Columbia',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming'};
  const REGIONS = [
    ['Canada', ['Alberta','British Columbia','Manitoba','New Brunswick','Newfoundland and Labrador','Nova Scotia','Ontario','Prince Edward Island','Quebec','Québec','Saskatchewan','Yukon','Nunavut','Northwest Territories'], ['AB','BC','MB','NB','NL','NS','ON','PE','QC','SK','YT','NU','NT']],
    ['India', ['Andhra Pradesh','Arunachal Pradesh','Assam','Bihar','Chhattisgarh','Goa','Gujarat','Haryana','Himachal Pradesh','Jharkhand','Karnataka','Kerala','Madhya Pradesh','Maharashtra','Manipur','Meghalaya','Mizoram','Nagaland','Odisha','Punjab','Rajasthan','Sikkim','Tamil Nadu','Telangana','Tripura','Uttar Pradesh','Uttarakhand','West Bengal','Delhi','National Capital Territory of Delhi','Jammu and Kashmir','Ladakh','Puducherry','Chandigarh'], []],
    ['Australia', ['New South Wales','Victoria','Queensland','Western Australia','South Australia','Tasmania','Australian Capital Territory','Northern Territory'], ['NSW','VIC','QLD','WA','SA','TAS','ACT','NT']],
    ['China', ['Guangdong','Zhejiang','Jiangsu','Shandong','Sichuan','Fujian','Hubei','Hunan'], []],
    ['Germany', ['Bavaria','Bayern','Baden-Württemberg','Berlin','Hesse','Hessen','North Rhine-Westphalia','Nordrhein-Westfalen','Lower Saxony','Niedersachsen','Saxony','Sachsen'], []],
  ];
  const CITIES = {
    'United States': ['New York City','San Francisco','Los Angeles','Chicago','Seattle','Boston','Austin','Atlanta','Dallas','Houston','Miami','Denver','San Jose','San Diego','Palo Alto','Mountain View','Menlo Park','Sunnyvale','Redmond','Cupertino','Phoenix','Philadelphia','Washington DC'],
    'India': ['Bengaluru','Bangalore','Mumbai','Bombay','New Delhi','Gurugram','Gurgaon','Noida','Hyderabad','Pune','Chennai','Kolkata','Ahmedabad','Jaipur','Kochi','Chandigarh','Indore','Mohali'],
    'United Kingdom': ['London','Manchester','Birmingham','Edinburgh','Glasgow','Leeds','Bristol','Cambridge','Oxford','Belfast','Cardiff'],
    'Canada': ['Toronto','Vancouver','Montreal','Montréal','Calgary','Ottawa','Waterloo'],
    'Germany': ['Munich','München','Hamburg','Frankfurt','Cologne','Köln','Stuttgart','Düsseldorf'],
    'France': ['Paris','Lyon','Marseille','Toulouse','Nice'],
    'Netherlands': ['Amsterdam','Rotterdam','The Hague','Utrecht','Eindhoven'],
    'United Arab Emirates': ['Dubai','Abu Dhabi','Sharjah'],
    'Australia': ['Sydney','Melbourne','Brisbane','Perth','Adelaide','Canberra'],
    'China': ['Beijing','Shanghai','Shenzhen','Guangzhou','Hangzhou'],
    'Japan': ['Tokyo','Osaka','Kyoto','Yokohama'],
    'Ireland': ['Dublin','Cork'],
    'Spain': ['Madrid','Barcelona','Valencia'],
    'Italy': ['Milan','Milano','Rome','Roma','Turin'],
    'Switzerland': ['Zurich','Zürich','Geneva','Basel','Zug'],
    'Sweden': ['Stockholm','Gothenburg'],
    'Israel': ['Tel Aviv','Tel Aviv-Yafo','Jerusalem','Haifa'],
    'Brazil': ['São Paulo','Sao Paulo','Rio de Janeiro'],
    'South Korea': ['Seoul','Busan'],
    'Saudi Arabia': ['Riyadh','Jeddah'],
    'Pakistan': ['Karachi','Lahore','Islamabad'],
    'Bangladesh': ['Dhaka'],
    'Nigeria': ['Lagos','Abuja'],
    'Kenya': ['Nairobi'],
    'Egypt': ['Cairo'],
    'Mexico': ['Mexico City','Guadalajara','Monterrey'],
    'Indonesia': ['Jakarta'],
    'Philippines': ['Manila','Makati','Taguig'],
    'Vietnam': ['Ho Chi Minh City','Hanoi'],
    'Malaysia': ['Kuala Lumpur'],
    'Thailand': ['Bangkok'],
    'Poland': ['Warsaw','Kraków','Krakow','Wrocław'],
  };
  const PLACE_INDEX = (() => {
    const index = new Map();
    const add = (key, country) => { if (!index.has(key.toLowerCase())) index.set(key.toLowerCase(), country); };
    for (const country of COUNTRIES) add(country, country);
    for (const [alias, country] of Object.entries(COUNTRY_ALIASES)) add(alias, country);
    for (const state of Object.values(US_STATES)) add(state, 'United States');
    for (const [country, names] of REGIONS) for (const name of names) add(name, country);
    for (const [country, names] of Object.entries(CITIES)) for (const name of names) add(name, country);
    return index;
  })();
  // US state codes win a clash ("Seattle, WA" is Washington, not Western Australia).
  const REGION_CODES = new Map(Object.keys(US_STATES).map((code) => [code, 'United States']));
  for (const [country, , codes] of REGIONS) for (const code of codes) if (!REGION_CODES.has(code)) REGION_CODES.set(code, country);
  // City names that exist in several countries. On their own they are not enough to name a country, so
  // they are left unresolved rather than guessed ("Cambridge" is not always England). With a state,
  // province or country after them ("Cambridge, MA", "London, Ontario") the place is clear.
  const AMBIGUOUS_CITIES = new Set(['cambridge','birmingham','manchester','perth','victoria','georgia','washington','valencia','richmond','portland','hyderabad','columbia','alexandria','newcastle','lancaster','springfield','naples','hamilton','kingston','granada','santiago','san jose','la paz','córdoba','cordoba','salem','durham','dover','plymouth']);
  const ISO_CODES = {US:'United States',GB:'United Kingdom',UK:'United Kingdom',IN:'India',CA:'Canada',AU:'Australia',DE:'Germany',FR:'France',NL:'Netherlands',IE:'Ireland',ES:'Spain',IT:'Italy',CH:'Switzerland',SE:'Sweden',NO:'Norway',DK:'Denmark',FI:'Finland',SG:'Singapore',JP:'Japan',CN:'China',HK:'Hong Kong',BR:'Brazil',MX:'Mexico',AE:'United Arab Emirates',SA:'Saudi Arabia',IL:'Israel',ZA:'South Africa',NG:'Nigeria',KE:'Kenya',EG:'Egypt',PK:'Pakistan',BD:'Bangladesh',ID:'Indonesia',PH:'Philippines',VN:'Vietnam',MY:'Malaysia',TH:'Thailand',PL:'Poland',PT:'Portugal',BE:'Belgium',AT:'Austria',NZ:'New Zealand',KR:'South Korea',TR:'Turkey',RU:'Russia',UA:'Ukraine',AR:'Argentina',CL:'Chile',CO:'Colombia',PE:'Peru',TW:'Taiwan',LK:'Sri Lanka',NP:'Nepal',QA:'Qatar',KW:'Kuwait',LU:'Luxembourg',CZ:'Czechia',RO:'Romania',HU:'Hungary',GR:'Greece'};
  // Names that are both a US state and a country: after a city they are the state.
  const US_STATE_FIRST = new Set(['georgia']);

  /**
   * The country of a place as LinkedIn writes it: the country itself ("…, India"), a state or
   * province ("Austin, Texas", "Austin, TX", "Pune, Maharashtra"), or a well-known city
   * ("London"). Undefined when it cannot be told. Only the last parts are trusted, so a company
   * named after a place ("Delhi Foods, Toronto") resolves from its location, not its name.
   */
  function countryFromPlace(value) {
    if (!value || typeof value !== 'string' || value.length > 300) return undefined;
    const parts = value.split(/[,·|]/).map((part) => part.replace(/\s+/g, ' ').replace(/\barea\b|\bmetropolitan\b|\bgreater\b|\bregion\b/gi, '').trim()).filter(Boolean);
    for (let index = parts.length - 1; index >= 0; index--) {
      const part = parts[index];
      // Two-letter codes only after a city ("Austin, TX"), never on their own.
      if (index > 0 && /^[A-Z]{2,3}$/.test(part) && REGION_CODES.has(part)) return REGION_CODES.get(part);
      if (index > 0 && US_STATE_FIRST.has(part.toLowerCase())) return 'United States';
      const known = PLACE_INDEX.get(part.toLowerCase());
      if (known) {
        if (parts.length === 1 && AMBIGUOUS_CITIES.has(part.toLowerCase())) return undefined;
        return known;
      }
      // "San Francisco Bay Area" and "Greater Bengaluru Area" were trimmed above; try the leading words.
      const words = part.split(' ');
      for (let length = Math.min(4, words.length - 1); length >= 1; length--) {
        const head = PLACE_INDEX.get(words.slice(0, length).join(' ').toLowerCase());
        if (head) return head;
      }
    }
    return undefined;
  }

  const UNAVAILABLE = /this page doesn.?t exist|page not found|this linkedin page isn.?t available|profile is not available|this profile is unavailable|content isn.?t available|no longer available/i;

  /** A reason when LinkedIn is showing a "not found" or "not available" page instead of the profile or company. */
  function pageUnavailable(root = document) {
    const node = root.querySelector('main') || root.body;
    const text = (node?.innerText ?? node?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 1500);
    return UNAVAILABLE.test(text) && text.length < 1200 ? 'LinkedIn says this page is not available (it may have been removed, or you may not have access).' : undefined;
  }

  /**
   * Waits for LinkedIn to finish drawing the page before anything is read from it: a page opened a moment
   * ago, or reached by LinkedIn's own in-page navigation, can show only a skeleton. Resolves ok as soon as
   * `ready()` is true; not ok with a reason when LinkedIn shows a not-available page; or with timedOut when
   * the page never finished (the caller decides whether to go on and say so).
   */
  async function waitForPageReady({ ready, timeoutMs = 12000, intervalMs = 400, onWait } = {}) {
    const started = Date.now();
    for (;;) {
      if (ready()) return { ok: true };
      const unavailable = pageUnavailable();
      if (unavailable) return { ok: false, reason: unavailable, unavailable: true };
      if (Date.now() - started >= timeoutMs) return { ok: false, timedOut: true, reason: 'The page had not finished loading.' };
      onWait?.();
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  /** The country a place names outright ("Dublin, Ireland", "Toronto, ON, Canada"): its last part is a country, nothing inferred. */
  function explicitCountry(value) {
    if (!value || typeof value !== 'string' || value.length > 300) return undefined;
    const parts = value.split(/[,·|]/).map((part) => part.replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (parts.length < 2) return undefined;
    const last = parts[parts.length - 1].toLowerCase();
    return COUNTRIES.find((country) => country.toLowerCase() === last) || COUNTRY_ALIASES[last];
  }

  /** A country from an ISO 3166 two-letter code ("US"), or from a country written out; undefined for anything else. */
  function countryFromCode(value) {
    const raw = String(value || '').trim();
    if (!raw) return undefined;
    if (/^[A-Za-z]{2}$/.test(raw)) return ISO_CODES[raw.toUpperCase()];
    return COUNTRIES.find((country) => country.toLowerCase() === raw.toLowerCase()) || COUNTRY_ALIASES[raw.toLowerCase()];
  }

  /**
   * A company's country and where it came from. First what the page states itself (structured data, or a
   * headquarters line that ends in a country); then the country its headquarters city or state belongs
   * to. An ambiguous place is left unresolved: no country is better than a guessed one.
   */
  function resolveCompanyCountry({ structured, headquarter } = {}) {
    const direct = countryFromCode(structured) || explicitCountry(headquarter);
    if (direct) return { country: direct, source: 'linkedin_page' };
    const inferred = countryFromPlace(headquarter);
    return inferred ? { country: inferred, source: 'headquarters' } : { country: undefined, source: undefined };
  }

  return { text, firstMatch, allMatches, metaContent, publicIdFromUrl, parseCount, textMultiline, cleanWebsite, countryFromPlace, explicitCountry, countryFromCode, resolveCompanyCountry, pageUnavailable, waitForPageReady };
})();
