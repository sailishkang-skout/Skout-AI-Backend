/**
 * A company's country, and where it came from. The Chrome extension reads the page; when the page did
 * not give a country, this derives it from the headquarters' state, province or city so every company
 * (including ones captured before this existed) gets one, and it says which it was. A place that could
 * mean several countries ("Cambridge") is left unresolved, never guessed.
 *
 * The place tables match the extension's (apps/chrome-extension/capture/extract-common.js).
 */

// ── Country from a place ("Bengaluru, Karnataka", "Austin, TX", "London") ──
const COUNTRIES: string[] = ['Afghanistan','Albania','Algeria','Andorra','Angola','Argentina','Armenia','Australia','Austria','Azerbaijan','Bahamas','Bahrain','Bangladesh','Barbados','Belarus','Belgium','Belize','Benin','Bhutan','Bolivia','Bosnia and Herzegovina','Botswana','Brazil','Brunei','Bulgaria','Burkina Faso','Burundi','Cambodia','Cameroon','Canada','Cape Verde','Chad','Chile','China','Colombia','Costa Rica','Croatia','Cuba','Cyprus','Czechia','Denmark','Djibouti','Dominican Republic','Ecuador','Egypt','El Salvador','Estonia','Eswatini','Ethiopia','Fiji','Finland','France','Gabon','Gambia','Georgia','Germany','Ghana','Greece','Guatemala','Guinea','Guyana','Haiti','Honduras','Hong Kong','Hungary','Iceland','India','Indonesia','Iran','Iraq','Ireland','Israel','Italy','Jamaica','Japan','Jordan','Kazakhstan','Kenya','Kosovo','Kuwait','Kyrgyzstan','Laos','Latvia','Lebanon','Lesotho','Liberia','Libya','Liechtenstein','Lithuania','Luxembourg','Macau','Madagascar','Malawi','Malaysia','Maldives','Mali','Malta','Mauritania','Mauritius','Mexico','Moldova','Monaco','Mongolia','Montenegro','Morocco','Mozambique','Myanmar','Namibia','Nepal','Netherlands','New Zealand','Nicaragua','Niger','Nigeria','North Macedonia','Norway','Oman','Pakistan','Panama','Papua New Guinea','Paraguay','Peru','Philippines','Poland','Portugal','Puerto Rico','Qatar','Romania','Russia','Rwanda','Saudi Arabia','Senegal','Serbia','Seychelles','Sierra Leone','Singapore','Slovakia','Slovenia','Somalia','South Africa','South Korea','Spain','Sri Lanka','Sudan','Suriname','Sweden','Switzerland','Syria','Taiwan','Tajikistan','Tanzania','Thailand','Togo','Trinidad and Tobago','Tunisia','Turkey','Turkmenistan','Uganda','Ukraine','United Arab Emirates','United Kingdom','United States','Uruguay','Uzbekistan','Venezuela','Vietnam','Yemen','Zambia','Zimbabwe'];
const COUNTRY_ALIASES: Record<string, string> = {
  'usa': 'United States', 'us': 'United States', 'u.s.': 'United States', 'u.s.a.': 'United States', 'united states of america': 'United States', 'america': 'United States',
  'uk': 'United Kingdom', 'u.k.': 'United Kingdom', 'great britain': 'United Kingdom', 'britain': 'United Kingdom', 'england': 'United Kingdom', 'scotland': 'United Kingdom', 'wales': 'United Kingdom', 'northern ireland': 'United Kingdom',
  'uae': 'United Arab Emirates', 'u.a.e.': 'United Arab Emirates', 'emirates': 'United Arab Emirates',
  'czech republic': 'Czechia', 'korea': 'South Korea', 'republic of korea': 'South Korea', 'türkiye': 'Turkey', 'turkiye': 'Turkey',
  'holland': 'Netherlands', 'the netherlands': 'Netherlands', 'russian federation': 'Russia', 'viet nam': 'Vietnam',
  'deutschland': 'Germany', 'españa': 'Spain', 'brasil': 'Brazil', 'méxico': 'Mexico', 'ksa': 'Saudi Arabia', 'prc': 'China', 'mainland china': 'China',
};
const US_STATES: Record<string, string> = {AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',DC:'District of Columbia',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming'};
const REGIONS: Array<[string, string[], string[]]> = [
  ['Canada', ['Alberta','British Columbia','Manitoba','New Brunswick','Newfoundland and Labrador','Nova Scotia','Ontario','Prince Edward Island','Quebec','Québec','Saskatchewan','Yukon','Nunavut','Northwest Territories'], ['AB','BC','MB','NB','NL','NS','ON','PE','QC','SK','YT','NU','NT']],
  ['India', ['Andhra Pradesh','Arunachal Pradesh','Assam','Bihar','Chhattisgarh','Goa','Gujarat','Haryana','Himachal Pradesh','Jharkhand','Karnataka','Kerala','Madhya Pradesh','Maharashtra','Manipur','Meghalaya','Mizoram','Nagaland','Odisha','Punjab','Rajasthan','Sikkim','Tamil Nadu','Telangana','Tripura','Uttar Pradesh','Uttarakhand','West Bengal','Delhi','National Capital Territory of Delhi','Jammu and Kashmir','Ladakh','Puducherry','Chandigarh'], []],
  ['Australia', ['New South Wales','Victoria','Queensland','Western Australia','South Australia','Tasmania','Australian Capital Territory','Northern Territory'], ['NSW','VIC','QLD','WA','SA','TAS','ACT','NT']],
  ['China', ['Guangdong','Zhejiang','Jiangsu','Shandong','Sichuan','Fujian','Hubei','Hunan'], []],
  ['Germany', ['Bavaria','Bayern','Baden-Württemberg','Berlin','Hesse','Hessen','North Rhine-Westphalia','Nordrhein-Westfalen','Lower Saxony','Niedersachsen','Saxony','Sachsen'], []],
];
const CITIES: Record<string, string[]> = {
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
  const index = new Map<string, string>();
  const add = (key: string, country: string) => { if (!index.has(key.toLowerCase())) index.set(key.toLowerCase(), country); };
  for (const country of COUNTRIES) add(country, country);
  for (const [alias, country] of Object.entries(COUNTRY_ALIASES)) add(alias, country);
  for (const state of Object.values(US_STATES)) add(state, 'United States');
  for (const [country, names] of REGIONS) for (const name of names) add(name, country);
  for (const [country, names] of Object.entries(CITIES)) for (const name of names) add(name, country);
  return index;
})();
// US state codes win a clash ("Seattle, WA" is Washington, not Western Australia).
const REGION_CODES = new Map<string, string>(Object.keys(US_STATES).map((code) => [code, 'United States'] as [string, string]));
for (const [country, , codes] of REGIONS) for (const code of codes) if (!REGION_CODES.has(code)) REGION_CODES.set(code, country);
// City names that exist in several countries. On their own they are not enough to name a country, so
// they are left unresolved rather than guessed ("Cambridge" is not always England). With a state,
// province or country after them ("Cambridge, MA", "London, Ontario") the place is clear.
const AMBIGUOUS_CITIES = new Set<string>(['cambridge','birmingham','manchester','perth','victoria','georgia','washington','valencia','richmond','portland','hyderabad','columbia','alexandria','newcastle','lancaster','springfield','naples','hamilton','kingston','granada','santiago','san jose','la paz','córdoba','cordoba','salem','durham','dover','plymouth']);
// Names that are both a US state and a country: after a city they are the state.
const US_STATE_FIRST = new Set<string>(['georgia']);


export type CountrySource = "linkedin_page" | "headquarters";
export interface ResolvedCountry {
  country: string | null;
  source: CountrySource | null;
}

/** The country of a place as LinkedIn writes it, or undefined when it cannot be told without guessing. */
export function countryFromPlace(value: unknown): string | undefined {
  if (!value || typeof value !== "string" || value.length > 300) return undefined;
  const parts = value
    .split(/[,·|]/)
    .map((part) => part.replace(/\s+/g, " ").replace(/\barea\b|\bmetropolitan\b|\bgreater\b|\bregion\b/gi, "").trim())
    .filter(Boolean);
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index]!;
    // Two-letter codes only after a city ("Austin, TX"), never on their own.
    if (index > 0 && /^[A-Z]{2,3}$/.test(part) && REGION_CODES.has(part)) return REGION_CODES.get(part);
    if (index > 0 && US_STATE_FIRST.has(part.toLowerCase())) return "United States";
    const known = PLACE_INDEX.get(part.toLowerCase());
    if (known) {
      if (parts.length === 1 && AMBIGUOUS_CITIES.has(part.toLowerCase())) return undefined;
      return known;
    }
    const words = part.split(" ");
    for (let length = Math.min(4, words.length - 1); length >= 1; length--) {
      const head = PLACE_INDEX.get(words.slice(0, length).join(" ").toLowerCase());
      if (head) return head;
    }
  }
  return undefined;
}

/** The country a place names outright ("Dublin, Ireland"): its last part is a country, nothing inferred. */
export function explicitCountry(value: unknown): string | undefined {
  if (!value || typeof value !== "string" || value.length > 300) return undefined;
  const parts = value.split(/[,·|]/).map((part) => part.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (parts.length < 2) return undefined;
  const last = parts[parts.length - 1]!.toLowerCase();
  return COUNTRIES.find((country) => country.toLowerCase() === last) ?? COUNTRY_ALIASES[last];
}

/**
 * The country the capture stated, else the country of its headquarters. `captured` is what the
 * extension sent (`locationCountry`, `locationCountrySource`).
 */
export function resolveCompanyCountry(input: { captured?: unknown; capturedSource?: unknown; headquarter?: unknown }): ResolvedCountry {
  const captured = typeof input.captured === "string" && input.captured.trim() ? input.captured.trim() : undefined;
  if (captured) {
    const source = input.capturedSource === "headquarters" ? "headquarters" : "linkedin_page";
    return { country: captured, source };
  }
  const direct = explicitCountry(input.headquarter);
  if (direct) return { country: direct, source: "linkedin_page" };
  const inferred = countryFromPlace(input.headquarter);
  return inferred ? { country: inferred, source: "headquarters" } : { country: null, source: null };
}
