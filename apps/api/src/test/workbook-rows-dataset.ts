/**
 * A realistic, repeatable workbook for the rows benchmark (WB2-012): 20 columns (7 typed inputs, 13 enrichment,
 * formula, AI and action) and one cell per row and column. Generated inside Postgres; every value is a fixed function
 * of (row number, column number), so two runs hold the same data. No production data.
 */
import { randomUUID } from "node:crypto";
import type { createDb } from "@skout/db";

type Sql = ReturnType<typeof createDb>["sql"];

export interface BenchColumn {
  key: string;
  name: string;
  type: "input" | "enrichment" | "ai" | "formula" | "action";
  dataType?: string;
}

export const BENCH_COLUMNS: BenchColumn[] = [
  { key: "firstName", name: "First name", type: "input", dataType: "text" },
  { key: "lastName", name: "Last name", type: "input", dataType: "text" },
  { key: "company", name: "Company", type: "input", dataType: "text" },
  { key: "domain", name: "Domain", type: "input", dataType: "domain" },
  { key: "employees", name: "Employees", type: "input", dataType: "number" },
  { key: "linkedin", name: "LinkedIn URL", type: "input", dataType: "linkedin_url" },
  { key: "location", name: "Location", type: "input", dataType: "text" },
  { key: "workEmail", name: "Work email", type: "enrichment" },
  { key: "emailStatus", name: "Email status", type: "enrichment" },
  { key: "phone", name: "Phone", type: "enrichment" },
  { key: "seniority", name: "Seniority", type: "enrichment" },
  { key: "companySize", name: "Company size", type: "enrichment" },
  { key: "industry", name: "Industry", type: "enrichment" },
  { key: "revenue", name: "Revenue band", type: "enrichment" },
  { key: "country", name: "HQ country", type: "enrichment" },
  { key: "score", name: "Lead score", type: "formula" },
  { key: "fullName", name: "Full name", type: "formula" },
  { key: "summary", name: "AI summary", type: "ai" },
  { key: "icebreaker", name: "Icebreaker", type: "ai" },
  { key: "crmPush", name: "CRM push", type: "action" },
];

const pick = (array: string[], expr: string) => `(ARRAY[${array.map((v) => `'${v}'`).join(",")}])[(${expr}) % ${array.length} + 1]`;
/** A well-spread, repeatable integer for (row g, salt). */
const h = (salt: number) => `abs(hashtextextended(g::text, ${salt}))`;

const FIRST = ["Aarav", "Olivia", "Liam", "Sofia", "Noah", "Mei", "Lucas", "Amara", "Ethan", "Priya", "Mateo", "Hannah", "Kenji", "Zara", "Omar", "Isla", "Diego", "Anya", "Felix", "Nadia", "Jonas", "Leila", "Marco", "Chloe", "Ravi", "Elena", "Tariq", "Grace", "Hugo", "Yuki"];
const LAST = ["Sharma", "Johnson", "Garcia", "Nguyen", "Muller", "Rossi", "Kim", "Silva", "Patel", "Brown", "Ivanov", "Khan", "Lopez", "Tanaka", "Dubois", "Okafor", "Costa", "Novak", "Haddad", "Fischer", "Moreau", "Santos", "Cohen", "Reyes", "Larsen", "Mehta", "Wagner", "Ali", "Chen", "Singh"];
const PRE = ["Acme", "Blue", "Cobalt", "Delta", "Echo", "Falcon", "Granite", "Harbor", "Iron", "Juniper", "Keystone", "Lumen", "Meridian", "Nimbus", "Orbit", "Pinnacle", "Quartz", "Redwood", "Summit", "Tidal", "Vertex", "Willow", "Zenith", "Apex", "Beacon", "Crest", "Ember", "Fusion", "Glacier", "Horizon"];
const SUF = ["Systems", "Labs", "Technologies", "Partners", "Group", "Holdings", "Solutions", "Networks", "Analytics", "Robotics", "Logistics", "Health", "Capital", "Media", "Energy", "Software", "Dynamics", "Works", "Industries", "Ventures"];
const CITY = ["Austin, US", "London, GB", "Berlin, DE", "Bengaluru, IN", "Singapore, SG", "Toronto, CA", "Sydney, AU", "Paris, FR", "Amsterdam, NL", "Dubai, AE", "Mumbai, IN", "New York, US", "Chicago, US", "Dublin, IE", "Madrid, ES", "Zurich, CH", "Tokyo, JP", "Lagos, NG", "Warsaw, PL", "Lisbon, PT"];

export async function seedBenchWorkbook(sql: Sql, workspaceId: string, createdBy: string | null, rows: number): Promise<{ workbookId: string; columns: Record<string, string> }> {
  const workbookId = randomUUID();
  const columns = Object.fromEntries(BENCH_COLUMNS.map((c) => [c.key, randomUUID()]));
  await sql`insert into workbooks (id, workspace_id, name, created_by, row_count) values (${workbookId}, ${workspaceId}, 'Rows benchmark', ${createdBy}, ${rows})`;
  for (const [position, c] of BENCH_COLUMNS.entries()) {
    await sql`insert into workbook_columns (id, workbook_id, name, type, position, config)
      values (${columns[c.key]!}, ${workbookId}, ${c.name}, ${c.type}, ${position}, ${JSON.stringify(c.dataType ? { dataType: c.dataType } : {})}::text::jsonb)`;
  }
  await sql.unsafe(`
    insert into workbook_rows (workbook_id, position, source)
    select '${workbookId}', g,
      case when ${h(1)} % 100 < 70 then '{"type":"csv","file":"leads-q3.csv"}'
           when ${h(1)} % 100 < 85 then '{"type":"list","name":"Q3 target accounts"}'
           when ${h(1)} % 100 < 95 then '{"type":"hubspot"}'
           else '{"type":"webhook"}' end::jsonb
    from generate_series(0, ${rows - 1}) g`);

  const person = `
    select r.id as row_id, g,
      ${pick(FIRST, h(11))} as first, ${pick(LAST, h(12))} as last,
      ${pick(PRE, h(13))} || ' ' || ${pick(SUF, h(14))} as company,
      lower(${pick(PRE, h(13))} || ${pick(SUF, h(14))}) || '.' || ${pick(["com", "io", "co", "net", "ai", "org"], h(15))} as domain
    from workbook_rows r, lateral (select r.position as g) p
    where r.workbook_id = '${workbookId}'`;
  const value = `case c.position
      when 0 then to_jsonb(first) when 1 then to_jsonb(last) when 2 then to_jsonb(company) when 3 then to_jsonb(domain)
      when 4 then to_jsonb((${h(21)} % 20000 + 1)::int)
      when 5 then to_jsonb('https://www.linkedin.com/in/' || lower(first) || '-' || lower(last) || '-' || g)
      when 6 then to_jsonb(${pick(CITY, h(22))})
      when 7 then to_jsonb(lower(first) || '.' || lower(last) || '@' || domain)
      when 8 then to_jsonb(${pick(["valid", "valid", "valid", "valid", "valid", "valid", "valid", "risky", "invalid", "unknown"], h(23))})
      when 9 then to_jsonb('+1-' || (200 + ${h(24)} % 700) || '-' || (200 + ${h(25)} % 700) || '-' || lpad((${h(26)} % 10000)::text, 4, '0'))
      when 10 then to_jsonb(${pick(["Entry", "Senior", "Manager", "Director", "VP", "C-level", "Owner"], h(27))})
      when 11 then to_jsonb(${pick(["1-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000", "5001+"], h(28))})
      when 12 then to_jsonb(${pick(["Software", "Financial Services", "Healthcare", "Manufacturing", "Retail", "Logistics", "Education", "Energy", "Media", "Telecommunications"], h(29))})
      when 13 then to_jsonb(${pick(["<1M", "1-5M", "5-10M", "10-50M", "50-100M", "100-500M", "1B+"], h(30))})
      when 14 then to_jsonb(${pick(["US", "GB", "DE", "IN", "SG", "CA", "AU", "FR", "NL", "AE"], h(31))})
      when 15 then to_jsonb((${h(32)} % 101)::int)
      when 16 then to_jsonb(first || ' ' || last)
      when 17 then to_jsonb(${pick(["Leads a team focused on", "Responsible for growing", "Owns the strategy for", "Recently joined to scale", "Drives decisions on"], h(33))} || ' ' || ${pick(["revenue operations and pipeline quality", "outbound programs across North America", "partner-led growth and channel sales", "data infrastructure and analytics", "customer onboarding and retention"], h(34))} || ' at ' || company || '.')
      when 18 then to_jsonb('Saw that ' || company || ' is hiring - happy to share how similar teams approached it.')
      else to_jsonb(${pick(["synced", "created"], h(35))}) end`;
  // Input and formula cells always have a value; the others follow the PRD's mix of cell states.
  const bucket = `abs(hashtextextended(g::text || ':' || c.position, 7)) % 100`;
  const state = `case when c.type in ('input', 'formula') then 'found'
      when ${bucket} < 58 then 'found' when ${bucket} < 72 then 'not_found' when ${bucket} < 80 then 'queued' when ${bucket} < 81 then 'running'
      when ${bucket} < 87 then 'error' when ${bucket} < 96 then 'skipped' else 'needs_input' end`;
  await sql.unsafe(`
    with person as (${person}),
    cell as (
      select p.*, c.id as column_id, c.position, ${state} as state from person p join workbook_columns c on c.workbook_id = '${workbookId}'
    )
    insert into workbook_cells (workbook_id, row_id, column_id, value, state, confidence, found_via, internal_provenance, error_code)
    select '${workbookId}', row_id, column_id,
      case when state = 'found' then (select ${value.replace(/\bc\.position\b/g, "cell.position")}) end,
      state,
      case when state = 'found' and position between 7 and 14 then 0.9 end,
      case when state = 'found' and position between 7 and 14 then 'skout' end,
      case when state = 'found' and position between 7 and 14 then '{"provider":"managed_provider_1"}'::jsonb end,
      case when state = 'error' then 'provider_unavailable' end
    from cell order by row_id, position`);
  await sql.unsafe("vacuum (analyze) workbook_rows");
  await sql.unsafe("vacuum (analyze) workbook_cells");
  await sql.unsafe("analyze workbook_columns");
  return { workbookId, columns };
}
