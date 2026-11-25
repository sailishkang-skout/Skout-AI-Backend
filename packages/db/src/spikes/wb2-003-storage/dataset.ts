/**
 * WB2-003 storage spike: a deterministic, production-data-free workbook of N rows x 20 columns.
 *
 * Generation runs inside Postgres (INSERT ... SELECT over generate_series) so a 100k x 20 workbook
 * (2M cells) loads in about a minute. Every value is a pure function of (row position, column index,
 * seed salt), so a re-run produces the same workbook. Ids are md5-derived uuids for the same reason.
 */
import { type Variant, tables } from "./variants.js";

export const COLUMN_COUNT = 20;

export interface ColumnSpec {
  index: number;
  name: string;
  type: "input" | "enrichment" | "ai" | "formula" | "action";
  operation: string | null;
  config: Record<string, unknown>;
  width: number;
  frozen: boolean;
}

export const COLUMN_SPECS: readonly ColumnSpec[] = [
  { index: 0, name: "First name", type: "input", operation: null, config: { mapped_from: "first_name" }, width: 140, frozen: true },
  { index: 1, name: "Last name", type: "input", operation: null, config: { mapped_from: "last_name" }, width: 140, frozen: false },
  { index: 2, name: "Company", type: "input", operation: null, config: { mapped_from: "company" }, width: 180, frozen: false },
  { index: 3, name: "Domain", type: "input", operation: null, config: { mapped_from: "domain" }, width: 160, frozen: false },
  { index: 4, name: "Job title", type: "input", operation: null, config: { mapped_from: "title" }, width: 200, frozen: false },
  { index: 5, name: "LinkedIn URL", type: "input", operation: null, config: { mapped_from: "linkedin_url" }, width: 240, frozen: false },
  { index: 6, name: "Location", type: "input", operation: null, config: { mapped_from: "location" }, width: 160, frozen: false },
  { index: 7, name: "Work email", type: "enrichment", operation: "find_email", config: { inputs: ["First name", "Last name", "Domain"], waterfall: { order: ["skout"], stop_on_first: true }, max_credits: 1 }, width: 220, frozen: false },
  { index: 8, name: "Email status", type: "enrichment", operation: "verify_email", config: { inputs: ["Work email"], waterfall: { order: ["skout"] } }, width: 140, frozen: false },
  { index: 9, name: "Phone", type: "enrichment", operation: "find_phone", config: { inputs: ["LinkedIn URL"], waterfall: { order: ["skout"] }, max_credits: 5 }, width: 160, frozen: false },
  { index: 10, name: "Seniority", type: "enrichment", operation: "enrich_person", config: { inputs: ["LinkedIn URL"] }, width: 120, frozen: false },
  { index: 11, name: "Company size", type: "enrichment", operation: "company_data", config: { inputs: ["Domain"] }, width: 120, frozen: false },
  { index: 12, name: "Industry", type: "enrichment", operation: "company_data", config: { inputs: ["Domain"] }, width: 160, frozen: false },
  { index: 13, name: "Revenue band", type: "enrichment", operation: "company_data", config: { inputs: ["Domain"] }, width: 140, frozen: false },
  { index: 14, name: "HQ country", type: "enrichment", operation: "company_data", config: { inputs: ["Domain"] }, width: 100, frozen: false },
  { index: 15, name: "Lead score", type: "formula", operation: null, config: { formula: "score(Seniority, Company size)" }, width: 100, frozen: false },
  { index: 16, name: "Full name", type: "formula", operation: null, config: { formula: "{First name} {Last name}" }, width: 160, frozen: false },
  { index: 17, name: "AI summary", type: "ai", operation: "ai_summary", config: { prompt: "Summarise this lead in two sentences", model: "default" }, width: 320, frozen: false },
  { index: 18, name: "Icebreaker", type: "ai", operation: "ai_icebreaker", config: { prompt: "One-line opener", model: "default" }, width: 280, frozen: false },
  { index: 19, name: "CRM push", type: "action", operation: "push_to_crm", config: { target: "contacts" }, width: 120, frozen: false },
];

/** Column indexes the benchmarks sort and filter on. */
export const COL = {
  firstName: 0,
  lastName: 1,
  company: 2,
  domain: 3,
  workEmail: 7,
  emailStatus: 8,
  phone: 9,
  leadScore: 15,
  aiSummary: 17,
} as const;

/** Target share of each state in an enrichment column, per mille. Used by the verification step. */
export const ENRICHMENT_STATE_PER_MILLE = { found: 580, not_found: 140, queued: 80, running: 10, error: 60, skipped: 90, needs_input: 40 } as const;

const DICT: Record<string, string[]> = {
  first: ["Aarav", "Olivia", "Liam", "Sofia", "Noah", "Mei", "Lucas", "Amara", "Ethan", "Priya", "Mateo", "Hannah", "Kenji", "Zara", "Omar", "Isla", "Diego", "Anya", "Felix", "Nadia", "Jonas", "Leila", "Marco", "Chloe", "Ravi", "Elena", "Tariq", "Grace", "Hugo", "Yuki", "Samir", "Freya", "Andre", "Mina", "Victor", "Aisha", "Carlos", "Ingrid", "Dev", "Naomi", "Pavel", "Rosa", "Theo", "Ananya", "Bruno", "Camila", "Idris", "Julia", "Kofi", "Lena", "Mohan", "Nora", "Oscar", "Petra", "Quinn", "Rhea", "Stefan", "Tara", "Umar", "Vera", "Wes", "Xena", "Yara", "Zane", "Alma", "Boris", "Clara", "Dario", "Esme", "Farid", "Gita", "Hans", "Ivy", "Jorge", "Kira", "Leo", "Maya", "Nico", "Opal", "Paolo", "Rita"],
  last: ["Sharma", "Johnson", "Garcia", "Nguyen", "Muller", "Rossi", "Kim", "Silva", "Patel", "Brown", "Ivanov", "Khan", "Lopez", "Tanaka", "Dubois", "Andersson", "Okafor", "Costa", "Novak", "Haddad", "Fischer", "Moreau", "Santos", "Cohen", "Reyes", "Larsen", "Mehta", "Wagner", "Ali", "Chen", "Singh", "Martin", "Walker", "Young", "Hall", "Allen", "King", "Wright", "Scott", "Green", "Baker", "Adams", "Nelson", "Hill", "Campbell", "Mitchell", "Roberts", "Carter", "Phillips", "Evans", "Turner", "Torres", "Parker", "Collins", "Edwards", "Stewart", "Flores", "Morris", "Murphy", "Rivera", "Cook", "Rogers", "Morgan", "Peterson", "Cooper", "Reed", "Bailey", "Bell", "Gomez", "Kelly", "Howard", "Ward", "Cox", "Diaz", "Richardson", "Wood", "Watson", "Brooks"],
  cpre: ["Acme", "Blue", "Cobalt", "Delta", "Echo", "Falcon", "Granite", "Harbor", "Iron", "Juniper", "Keystone", "Lumen", "Meridian", "Nimbus", "Orbit", "Pinnacle", "Quartz", "Redwood", "Summit", "Tidal", "Umbra", "Vertex", "Willow", "Xenon", "Yonder", "Zenith", "Apex", "Beacon", "Crest", "Dynamo", "Ember", "Fusion", "Glacier", "Horizon", "Ion", "Jade", "Kinetic", "Lattice", "Mosaic", "North", "Onyx", "Prism", "Quill", "Ridge", "Stellar", "Terra", "Unity", "Vector", "Wave", "Axiom", "Bright", "Clear", "Direct", "Elite", "First", "Grand", "Hyper", "Inner", "Joint", "Key"],
  csuf: ["Systems", "Labs", "Technologies", "Partners", "Group", "Holdings", "Solutions", "Networks", "Analytics", "Robotics", "Logistics", "Health", "Capital", "Media", "Energy", "Software", "Dynamics", "Works", "Industries", "Ventures", "Cloud", "Data", "Security", "Payments", "Bio", "Mobility", "Foods", "Retail", "Studios", "Consulting", "Insurance", "Education", "Materials", "Devices", "Travel", "Realty", "Pharma", "Apps", "AI", "Commerce", "Telecom", "Marine", "Aero", "Agri", "Legal", "Design", "Power", "Water", "Steel", "Textiles", "Motors", "Games", "Sports", "Fashion", "Finance", "Platforms", "Services", "Supply", "Research", "Interactive"],
  tld: ["com", "io", "co", "net", "ai", "org"],
  title: ["VP Sales", "Head of Growth", "Director of Marketing", "Account Executive", "CEO", "CTO", "CFO", "COO", "Sales Development Representative", "Marketing Manager", "Product Manager", "Engineering Manager", "Software Engineer", "Data Scientist", "Revenue Operations Lead", "Customer Success Manager", "Chief Revenue Officer", "Founder", "Co-Founder", "Operations Director", "Business Development Manager", "Demand Generation Manager", "Talent Acquisition Lead", "HR Director", "IT Manager", "Procurement Manager", "Finance Director", "General Manager", "Partnerships Lead", "Brand Manager", "Solutions Architect", "Security Analyst", "UX Designer", "Content Strategist", "Regional Sales Manager", "Enterprise Account Manager", "VP Engineering", "VP Product", "Chief of Staff", "Managing Director"],
  city: ["Austin, US", "London, GB", "Berlin, DE", "Bengaluru, IN", "Singapore, SG", "Toronto, CA", "Sydney, AU", "Paris, FR", "Amsterdam, NL", "Dubai, AE", "Sao Paulo, BR", "Mumbai, IN", "New York, US", "San Francisco, US", "Chicago, US", "Boston, US", "Seattle, US", "Denver, US", "Atlanta, US", "Dublin, IE", "Stockholm, SE", "Madrid, ES", "Milan, IT", "Zurich, CH", "Tel Aviv, IL", "Tokyo, JP", "Seoul, KR", "Hong Kong, HK", "Jakarta, ID", "Lagos, NG", "Nairobi, KE", "Cape Town, ZA", "Mexico City, MX", "Bogota, CO", "Santiago, CL", "Warsaw, PL", "Prague, CZ", "Vienna, AT", "Copenhagen, DK", "Oslo, NO", "Helsinki, FI", "Lisbon, PT", "Brussels, BE", "Munich, DE", "Hyderabad, IN", "Pune, IN", "Delhi, IN", "Manila, PH", "Bangkok, TH", "Kuala Lumpur, MY", "Hanoi, VN", "Melbourne, AU", "Vancouver, CA", "Montreal, CA", "Los Angeles, US", "Miami, US", "Dallas, US", "Houston, US", "Phoenix, US", "Philadelphia, US"],
  seniority: ["Entry", "Senior", "Manager", "Director", "VP", "C-level", "Owner", "Partner"],
  size: ["1-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000", "5001-10000", "10000+"],
  industry: ["Software", "Financial Services", "Healthcare", "Manufacturing", "Retail", "Logistics", "Education", "Energy", "Media", "Telecommunications", "Real Estate", "Insurance", "Automotive", "Consulting", "Hospitality", "Biotechnology", "Construction", "Agriculture", "Aerospace", "Legal Services", "Nonprofit", "Public Sector", "Gaming", "E-commerce", "Cybersecurity"],
  revenue: ["<1M", "1-5M", "5-10M", "10-50M", "50-100M", "100-500M", "500M-1B", "1B+"],
  country: ["US", "GB", "DE", "IN", "SG", "CA", "AU", "FR", "NL", "AE", "BR", "ES", "IT", "CH", "IL", "JP", "KR", "HK", "ID", "NG", "KE", "ZA", "MX", "CO", "CL", "PL", "CZ", "AT", "DK", "SE"],
  err: ["provider_unavailable", "rate_limited", "invalid_input", "timeout", "no_credits", "internal_error"],
  s1: ["Leads a team focused on", "Responsible for growing", "Owns the strategy for", "Recently joined to scale", "Has built a career around", "Drives decisions on", "Manages budget for", "Is evaluating tools for", "Spearheads initiatives in", "Reports directly on"],
  s2: ["revenue operations and pipeline quality", "outbound programs across North America", "partner-led growth and channel sales", "data infrastructure and analytics tooling", "customer onboarding and retention", "enterprise accounts in regulated industries", "product-led growth experiments", "go-to-market planning for new regions", "vendor consolidation and cost control", "talent and team expansion plans"],
  s3: ["The company raised a new round last year.", "Headcount has grown steadily over twelve months.", "They recently announced a platform migration.", "Public hiring posts suggest expansion into new markets.", "A leadership change was reported last quarter.", "They sponsor several industry events each year.", "Their website highlights an upcoming product launch.", "The team publishes regularly on its engineering blog.", "Customer reviews mention strong support responsiveness.", "A recent partnership widens their distribution."],
  ice: ["Saw your recent post on scaling outbound - curious how you handle data quality.", "Congrats on the new role - teams in your position often tell us pipeline visibility is the first gap.", "Noticed the company is hiring several SDRs, which usually means list building is a bottleneck.", "Your talk on revenue operations stuck with me, especially the part about enrichment costs.", "Looks like you expanded into a new region recently - happy to share how peers staffed it.", "Impressed by the product launch - are you still sourcing contacts manually?", "Your team has grown fast this year, and onboarding research tends to slow down at that point.", "Saw the funding news - most teams reassess their data stack right after a round."],
};

export function dictionaryRows(): Array<{ kind: string; idx: number; val: string }> {
  return Object.entries(DICT).flatMap(([kind, vals]) => vals.map((val, idx) => ({ kind, idx, val })));
}

export const GEN_SCHEMA = "wbs_gen";

/** One-off helper objects shared by every variant: the hash function and the value dictionaries. */
export function setupGeneratorDdl(): string[] {
  return [
    `CREATE SCHEMA IF NOT EXISTS ${GEN_SCHEMA}`,
    // Integer hash: xor the inputs, multiply (31-bit masks keep every product inside bigint), then fold the high
    // bits down. A plain multiplicative congruential hash is correlated across rows and columns and skews the
    // state mix, so the fold matters.
    `CREATE OR REPLACE FUNCTION ${GEN_SCHEMA}.h(a bigint, b int, salt int) RETURNS bigint LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
     $$ SELECT ((((a * 1000003 # b::bigint * 998244353 # salt::bigint * 12582917) & 2147483647) * 1274126177) & 2147483647)
              # (((((a * 1000003 # b::bigint * 998244353 # salt::bigint * 12582917) & 2147483647) * 1274126177) & 2147483647) >> 15) $$`,
    `DROP TABLE IF EXISTS ${GEN_SCHEMA}.dict`,
    `CREATE TABLE ${GEN_SCHEMA}.dict (kind text NOT NULL, idx int NOT NULL, val text NOT NULL, PRIMARY KEY (kind, idx))`,
  ];
}

export interface WorkbookSeed {
  /** Stable text the ids derive from, e.g. "main" or "growth-7". */
  tag: string;
  workbookId: string;
  workspaceId: string;
  userId: string | null;
  name: string;
  rows: number;
  /** Shifts every hash so two workbooks hold different data. */
  salt: number;
  /** First bigint row id minus one (bigint variants only). */
  idBase: number;
}

export const idExpr = (tag: string, kind: "row" | "col", n: string) => `md5('wb2003:${tag}:${kind}:' || ${n})::uuid`;

/** workbooks row + 20 columns. */
export function insertWorkbookAndColumnsSql(v: Variant, s: WorkbookSeed): string[] {
  const t = tables(v);
  const cols = COLUMN_SPECS.map(
    (c) =>
      `(${idExpr(s.tag, "col", String(c.index))}, '${s.workbookId}'::uuid, '${c.name}', '${c.type}', ${c.operation ? `'${c.operation}'` : "NULL"}, '${JSON.stringify(c.config).replace(/'/g, "''")}'::jsonb, ${c.index}, ${c.width}, false, ${c.frozen})`
  ).join(",\n");
  return [
    `INSERT INTO ${t.workbooks} (id, workspace_id, name, row_count, row_limit, created_by) VALUES ('${s.workbookId}', '${s.workspaceId}', '${s.name}', ${s.rows}, 100000, ${s.userId ? `'${s.userId}'` : "NULL"})`,
    `INSERT INTO ${t.columns} (id, workbook_id, name, type, operation, config, position, width, hidden, frozen) VALUES ${cols}`,
  ];
}

const dictArrays = `d AS (
  SELECT
    array_agg(val ORDER BY idx) FILTER (WHERE kind='first') AS first, array_agg(val ORDER BY idx) FILTER (WHERE kind='last') AS last,
    array_agg(val ORDER BY idx) FILTER (WHERE kind='cpre') AS cpre, array_agg(val ORDER BY idx) FILTER (WHERE kind='csuf') AS csuf,
    array_agg(val ORDER BY idx) FILTER (WHERE kind='tld') AS tld, array_agg(val ORDER BY idx) FILTER (WHERE kind='title') AS title,
    array_agg(val ORDER BY idx) FILTER (WHERE kind='city') AS city, array_agg(val ORDER BY idx) FILTER (WHERE kind='seniority') AS seniority,
    array_agg(val ORDER BY idx) FILTER (WHERE kind='size') AS size, array_agg(val ORDER BY idx) FILTER (WHERE kind='industry') AS industry,
    array_agg(val ORDER BY idx) FILTER (WHERE kind='revenue') AS revenue, array_agg(val ORDER BY idx) FILTER (WHERE kind='country') AS country,
    array_agg(val ORDER BY idx) FILTER (WHERE kind='err') AS err, array_agg(val ORDER BY idx) FILTER (WHERE kind='s1') AS s1,
    array_agg(val ORDER BY idx) FILTER (WHERE kind='s2') AS s2, array_agg(val ORDER BY idx) FILTER (WHERE kind='s3') AS s3,
    array_agg(val ORDER BY idx) FILTER (WHERE kind='ice') AS ice
  FROM ${GEN_SCHEMA}.dict
)`;

/** Person/company attributes of row i, shared by all of its cells (kept narrow: it is carried through every cell). */
const personCte = (s: WorkbookSeed, from: number, to: number) => `
  ri AS (
    SELECT i, fn, ln, company, tld, lower(regexp_replace(company, '[^A-Za-z0-9]', '', 'g')) || '.' || tld AS domain
    FROM (
      SELECT i,
        d.first[ ${GEN_SCHEMA}.h(i, 0, ${s.salt}+11) % cardinality(d.first) + 1 ] AS fn,
        d.last[ ${GEN_SCHEMA}.h(i, 1, ${s.salt}+12) % cardinality(d.last) + 1 ] AS ln,
        d.cpre[ ${GEN_SCHEMA}.h(i, 2, ${s.salt}+13) % cardinality(d.cpre) + 1 ] || ' ' || d.csuf[ ${GEN_SCHEMA}.h(i, 3, ${s.salt}+14) % cardinality(d.csuf) + 1 ] AS company,
        d.tld[ ${GEN_SCHEMA}.h(i, 3, ${s.salt}+14) % cardinality(d.tld) + 1 ] AS tld
      FROM generate_series(${from}, ${to}) AS i CROSS JOIN d
    ) p
  )`;

export function insertRowsSql(v: Variant, s: WorkbookSeed): string {
  const t = tables(v);
  const bigint = v.idType === "bigint";
  return `INSERT INTO ${t.rows} (${bigint ? "id, " : "id, "}workbook_id, position, source, prospect_id, crm_ref, suppressed, created_at)
    ${bigint ? "OVERRIDING SYSTEM VALUE" : ""}
    SELECT ${bigint ? `${s.idBase} + i + 1` : idExpr(s.tag, "row", "i")}, '${s.workbookId}'::uuid, i,
      CASE ${GEN_SCHEMA}.h(i, 5, ${s.salt}+21) % 20
        WHEN 0 THEN '{"type":"webhook"}'::jsonb WHEN 1 THEN '{"type":"hubspot"}'::jsonb WHEN 2 THEN '{"type":"hubspot"}'::jsonb
        WHEN 3 THEN '{"type":"list","name":"Q3 target accounts"}'::jsonb WHEN 4 THEN '{"type":"list","name":"Q3 target accounts"}'::jsonb WHEN 5 THEN '{"type":"list","name":"Q3 target accounts"}'::jsonb
        ELSE '{"type":"csv","file":"leads-2026-q3.csv"}'::jsonb END,
      NULL,
      CASE WHEN ${GEN_SCHEMA}.h(i, 6, ${s.salt}+22) % 10 = 0 THEN jsonb_build_object('provider','hubspot','id',(${GEN_SCHEMA}.h(i, 7, ${s.salt}+23) % 900000000 + 100000000)::text) END,
      ${GEN_SCHEMA}.h(i, 8, ${s.salt}+24) % 100 = 0,
      timestamptz '2026-11-01 00:00:00+00' + (${GEN_SCHEMA}.h(i, 9, ${s.salt}+25) % 2592000) * interval '1 second'
    FROM generate_series(0, ${s.rows - 1}) AS i`;
}

/** All cells of a workbook, row-major (the order an import writes them). */
export function insertCellsSql(v: Variant, s: WorkbookSeed): string {
  const t = tables(v);
  const bigint = v.idType === "bigint";
  const H = (i: string, k: string, n: number) => `${GEN_SCHEMA}.h(${i}, ${k}, ${s.salt}+${n})`;
  const rowIdExpr = bigint ? `(${s.idBase} + g.i + 1)` : idExpr(s.tag, "row", "g.i");
  // g.k is the column index; b (per mille bucket) decides the state.
  return `INSERT INTO ${t.cells} (${v.workbookIdOnCells ? "workbook_id, " : ""}row_id, column_id, value, state, confidence, credits_charged, found_via, internal_provenance, error_code, updated_at)
  WITH ${dictArrays},
  ${personCte(s, 0, s.rows - 1)},
  g AS (
    SELECT ri.*, k, ${H("ri.i", "k", 1)} AS h1, ${H("ri.i", "k", 2)} AS h2, ${H("ri.i", "k", 3)} AS h3, ${H("ri.i", "k", 4)} % 1000 AS b
    FROM ri CROSS JOIN generate_series(0, ${COLUMN_COUNT - 1}) AS k
  ),
  st AS (
    SELECT g.*,
      CASE
        WHEN k <= 6 THEN 'found'
        WHEN k IN (15, 16) THEN CASE WHEN b < 940 THEN 'found' ELSE 'needs_input' END
        WHEN k = 19 THEN CASE WHEN b < 500 THEN 'found' WHEN b < 700 THEN 'skipped' WHEN b < 780 THEN 'error' WHEN b < 900 THEN 'queued' ELSE 'needs_input' END
        ELSE CASE WHEN b < 580 THEN 'found' WHEN b < 720 THEN 'not_found' WHEN b < 800 THEN 'queued' WHEN b < 810 THEN 'running'
                  WHEN b < 870 THEN 'error' WHEN b < 960 THEN 'skipped' ELSE 'needs_input' END
      END AS state
    FROM g
  ),
  v AS (
    SELECT st.*,
      CASE WHEN state = 'found' AND k >= 7 AND k NOT IN (15, 16, 19) THEN
        CASE WHEN h3 % 100 < 60 THEN 'skout' WHEN h3 % 100 < 75 THEN 'own_key:hunter' WHEN h3 % 100 < 85 THEN 'own_key:zerobounce' ELSE 'cache' END
      END AS via
    FROM st
  )
  SELECT ${v.workbookIdOnCells ? `'${s.workbookId}'::uuid, ` : ""}${rowIdExpr}, ${idExpr(s.tag, "col", "g.k")},
    CASE WHEN state = 'found' THEN
      CASE k
        WHEN 0 THEN to_jsonb(fn) WHEN 1 THEN to_jsonb(ln) WHEN 2 THEN to_jsonb(company) WHEN 3 THEN to_jsonb(domain)
        WHEN 4 THEN to_jsonb(d.title[h1 % cardinality(d.title) + 1])
        WHEN 5 THEN to_jsonb('https://www.linkedin.com/in/' || lower(fn) || '-' || lower(ln) || '-' || (1000 + h2 % 9000))
        WHEN 6 THEN to_jsonb(d.city[h1 % cardinality(d.city) + 1])
        WHEN 7 THEN to_jsonb(lower(fn) || '.' || lower(ln) || '@' || domain)
        WHEN 8 THEN to_jsonb(CASE WHEN h2 % 100 < 70 THEN 'valid' WHEN h2 % 100 < 85 THEN 'risky' WHEN h2 % 100 < 95 THEN 'invalid' ELSE 'unknown' END)
        WHEN 9 THEN to_jsonb('+1-' || (200 + h2 % 700) || '-' || (200 + h3 % 700) || '-' || lpad((h1 % 10000)::text, 4, '0'))
        WHEN 10 THEN to_jsonb(d.seniority[h1 % cardinality(d.seniority) + 1])
        WHEN 11 THEN to_jsonb(d.size[h1 % cardinality(d.size) + 1])
        WHEN 12 THEN to_jsonb(d.industry[h1 % cardinality(d.industry) + 1])
        WHEN 13 THEN to_jsonb(d.revenue[h1 % cardinality(d.revenue) + 1])
        WHEN 14 THEN to_jsonb(d.country[h1 % cardinality(d.country) + 1])
        WHEN 15 THEN to_jsonb((h2 % 101)::int)
        WHEN 16 THEN to_jsonb(fn || ' ' || ln)
        WHEN 17 THEN to_jsonb(d.s1[h1 % cardinality(d.s1) + 1] || ' ' || d.s2[h2 % cardinality(d.s2) + 1] || '. ' || d.s3[h3 % cardinality(d.s3) + 1])
        WHEN 18 THEN to_jsonb(d.ice[h1 % cardinality(d.ice) + 1])
        WHEN 19 THEN to_jsonb(CASE WHEN h2 % 2 = 0 THEN 'synced' ELSE 'created' END)
      END
    END,
    state,
    CASE WHEN via IS NOT NULL THEN round((0.55 + (h3 % 450) / 1000.0)::numeric, 2)::real END,
    CASE WHEN via = 'skout' THEN CASE k WHEN 9 THEN 5 WHEN 17 THEN 0 WHEN 18 THEN 0 ELSE 1 END ELSE 0 END,
    via,
    CASE WHEN via = 'skout' THEN jsonb_build_object('provider', 'managed_provider_' || (h2 % 5 + 1), 'retrieved_at', '2026-11-' || lpad((1 + h1 % 28)::text, 2, '0'), 'request_cost_micros', 120 + h3 % 400) END,
    CASE state WHEN 'error' THEN d.err[h2 % cardinality(d.err) + 1] WHEN 'skipped' THEN 'condition_not_met' END,
    timestamptz '2026-11-01 00:00:00+00' + (h1 % 2592000) * interval '1 second'
  FROM v AS g CROSS JOIN d`;
}
