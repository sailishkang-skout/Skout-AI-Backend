/** Correctness checks for a loaded variant: counts, constraints, isolation, and sort/filter against a JS oracle. */
import { type Sql, columnIdOf, saveResult, workbookIdOf } from "./db.js";
import { COL, COLUMN_COUNT, ENRICHMENT_STATE_PER_MILLE } from "./dataset.js";
import { FILTERS, type FilterKind, WINDOW_SIZE, filteredCountSql, filteredWindowSql, sortedWindowSql, windowSql } from "./queries.js";
import { type Variant, schemaOf, tables } from "./variants.js";

export interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

const ok = (name: string, pass: boolean, detail: string): Check => ({ name, pass, detail });

/** Run a statement that must fail; report the message. Always rolled back. */
async function mustFail(sql: Sql, stmt: string): Promise<string | null> {
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(stmt);
      throw new Error("__rollback__");
    });
    return null;
  } catch (e) {
    const msg = (e as Error).message;
    return msg === "__rollback__" ? null : msg;
  }
}

async function oracleColumn(sql: Sql, v: Variant, col: number) {
  const t = tables(v);
  return sql.unsafe<{ id: string | number; position: number; value: unknown; state: string }[]>(
    `SELECT r.id, r.position, s.value, s.state FROM ${t.rows} r JOIN ${t.cells} s ON s.row_id = r.id AND s.column_id = '${columnIdOf("main", col)}'
     WHERE r.workbook_id = '${workbookIdOf("main")}' ORDER BY r.position`
  );
}

export async function runVerify(sql: Sql, v: Variant, rows: number): Promise<{ variant: string; passed: number; failed: number; checks: Check[] }> {
  const t = tables(v);
  const wb = workbookIdOf("main");
  const iso = workbookIdOf("iso");
  const checks: Check[] = [];

  // --- counts -------------------------------------------------------------------------------------------------
  const cellsOf = (id: string) => (v.workbookIdOnCells ? `workbook_id = '${id}'` : `column_id IN (SELECT id FROM ${t.columns} WHERE workbook_id = '${id}')`);
  const count = async (q: string) => Number((await sql.unsafe<{ n: string }[]>(q))[0]!.n);
  const isoRows = await count(`SELECT count(*)::text AS n FROM ${t.rows} WHERE workbook_id = '${iso}'`);
  checks.push(ok("main workbook has the expected rows", (await count(`SELECT count(*)::text AS n FROM ${t.rows} WHERE workbook_id = '${wb}'`)) === rows, `${rows} rows`));
  checks.push(ok("main workbook has 20 columns", (await count(`SELECT count(*)::text AS n FROM ${t.columns} WHERE workbook_id = '${wb}'`)) === COLUMN_COUNT, "20 columns"));
  const mainCells = await count(`SELECT count(*)::text AS n FROM ${t.cells} WHERE ${cellsOf(wb)}`);
  checks.push(ok("main workbook has rows x 20 cells", mainCells === rows * COLUMN_COUNT, `${mainCells.toLocaleString()} cells`));
  const isoCells = await count(`SELECT count(*)::text AS n FROM ${t.cells} WHERE ${cellsOf(iso)}`);
  checks.push(ok("second workspace's workbook is complete", isoCells === isoRows * COLUMN_COUNT, `${isoRows} rows, ${isoCells} cells`));
  checks.push(ok("no other cells exist", (await count(`SELECT count(*)::text AS n FROM ${t.cells}`)) === mainCells + isoCells, "table total = both workbooks"));

  // --- keys and constraints -----------------------------------------------------------------------------------
  checks.push(ok("no duplicate (row_id, column_id)", (await count(`SELECT count(*)::text AS n FROM (SELECT 1 FROM ${t.cells} GROUP BY row_id, column_id HAVING count(*) > 1) d`)) === 0, "0 duplicates"));
  checks.push(ok("no cell without a row", (await count(`SELECT count(*)::text AS n FROM ${t.cells} c WHERE NOT EXISTS (SELECT 1 FROM ${t.rows} r WHERE r.id = c.row_id)`)) === 0, "0 orphans"));
  checks.push(ok("no cell without a column", (await count(`SELECT count(*)::text AS n FROM ${t.cells} c WHERE NOT EXISTS (SELECT 1 FROM ${t.columns} k WHERE k.id = c.column_id)`)) === 0, "0 orphans"));
  if (v.workbookIdOnCells) {
    checks.push(ok("cell.workbook_id always equals its row's and column's workbook", (await count(`SELECT count(*)::text AS n FROM ${t.cells} c JOIN ${t.rows} r ON r.id = c.row_id JOIN ${t.columns} k ON k.id = c.column_id WHERE c.workbook_id <> r.workbook_id OR c.workbook_id <> k.workbook_id`)) === 0, "0 mismatches"));
  }

  const sampleRow = (await sql.unsafe<{ id: string | number }[]>(`SELECT id FROM ${t.rows} WHERE workbook_id = '${wb}' AND position = 0`))[0]!.id;
  const isoCol = columnIdOf("iso", 0);
  const orphanInsert = v.idType === "uuid" ? "'00000000-0000-4000-8000-000000000000'" : "-1";
  const wbCol = v.workbookIdOnCells ? `'${wb}', ` : "";
  const cols = v.workbookIdOnCells ? "workbook_id, row_id, column_id, state" : "row_id, column_id, state";
  const fkErr = await mustFail(sql, `INSERT INTO ${t.cells} (${cols}) VALUES (${wbCol}${orphanInsert}, '${columnIdOf("main", 0)}', 'found')`);
  checks.push(ok("foreign key rejects a cell for a missing row", !!fkErr, fkErr ?? "NOT REJECTED"));
  const checkErr = await mustFail(sql, `UPDATE ${t.cells} SET state = 'bogus' WHERE row_id = '${sampleRow}' AND column_id = '${columnIdOf("main", 0)}'`);
  checks.push(ok("state CHECK rejects an unknown state", !!checkErr, checkErr ?? "NOT REJECTED"));

  // A row of workbook A linked to a column of workbook B. The composite foreign keys exist to refuse this.
  const crossErr = await mustFail(sql, `INSERT INTO ${t.cells} (${cols}) VALUES (${wbCol}'${sampleRow}', '${isoCol}', 'found') ON CONFLICT DO NOTHING`);
  if (v.workbookIdOnCells) checks.push(ok("a cell cannot join a row of one workbook to a column of another", !!crossErr, crossErr ?? "NOT REJECTED"));
  else checks.push({ name: "INFO (not a pass/fail): can a cell join a row of workbook A to a column of workbook B?", pass: true, detail: crossErr ? `refused: ${crossErr}` : "YES, ALLOWED. The PRD-literal schema has no way to stop it (see decision doc)" });

  // --- state mix of the enrichment columns --------------------------------------------------------------------
  const dist = await sql.unsafe<{ state: string; n: string }[]>(
    `SELECT state, count(*)::text AS n FROM ${t.cells} c JOIN ${t.columns} k ON k.id = c.column_id WHERE k.workbook_id = '${wb}' AND k.position BETWEEN 7 AND 14 GROUP BY state`
  );
  const total = dist.reduce((a, d) => a + Number(d.n), 0);
  const deviations = Object.entries(ENRICHMENT_STATE_PER_MILLE).map(([state, target]) => {
    const got = (Number(dist.find((d) => d.state === state)?.n ?? 0) / total) * 1000;
    // +-0.8 pp at 100k rows; wider on a small test dataset, where sampling noise alone exceeds it (4 standard errors).
    const p = target / 1000;
    const tolerance = Math.max(8, 4 * Math.sqrt((p * (1 - p)) / total) * 1000);
    return { state, target, got: Math.round(got), within: Math.abs(got - target) <= tolerance };
  });
  checks.push(ok("enrichment state mix matches the dataset spec (+-0.8 pp at 100k rows)", deviations.every((d) => d.within), deviations.map((d) => `${d.state} ${(d.got / 10).toFixed(1)}% (target ${d.target / 10}%)`).join(", ")));

  const prov = await count(`SELECT count(*)::text AS n FROM ${t.cells} WHERE (found_via = 'skout') <> (internal_provenance IS NOT NULL)`);
  checks.push(ok("internal_provenance is set exactly for found_via = skout", prov === 0, `${prov} exceptions`));

  // --- isolation ----------------------------------------------------------------------------------------------
  const windowRes = await sql.unsafe<Record<string, unknown>[]>(windowSql(v), [wb, Math.min(5000, rows - WINDOW_SIZE)]);
  const ids = [...new Set(windowRes.map((r) => r.row_id as string | number))];
  const foreign = await count(`SELECT count(*)::text AS n FROM ${t.rows} WHERE id = ANY('{${ids.join(",")}}'::${v.idType}[]) AND workbook_id <> '${wb}'`);
  checks.push(ok("a window of workbook A returns only workbook A's rows", ids.length === WINDOW_SIZE && foreign === 0, `${ids.length} rows, ${foreign} from another workbook`));
  checks.push(ok("window response carries no internal_provenance", windowRes.length > 0 && windowRes.every((r) => !("internal_provenance" in r)) && !windowSql(v).includes("internal_provenance"), `${windowRes.length} cell rows, columns: ${Object.keys(windowRes[0]!).join(",")}`));
  const isoWin = await sql.unsafe<Record<string, unknown>[]>(windowSql(v), [iso, 0]);
  const isoIds = new Set(isoWin.map((r) => String(r.row_id)));
  const leaked = (await sql.unsafe<{ id: string | number }[]>(`SELECT id FROM ${t.rows} WHERE workbook_id = '${wb}' AND id = ANY('{${[...isoIds].join(",")}}'::${v.idType}[])`)).length;
  checks.push(ok("a window of workbook B returns only workbook B's rows", leaked === 0 && isoIds.size === WINDOW_SIZE, `${isoIds.size} rows, ${leaked} from workbook A`));
  const crossSort = await sql.unsafe<{ value: unknown }[]>(sortedWindowSql(v), [wb, isoCol, 0]);
  checks.push(ok("sorting workbook A by a column of workbook B exposes none of B's values", crossSort.every((r) => r.value == null || ((r as Record<string, unknown>).column_id !== isoCol)), `${crossSort.length} cell rows, none from the foreign column`));
  const wsRows = await sql.unsafe<{ id: string }[]>(`SELECT w.id FROM ${t.workbooks} w JOIN public.workspaces s ON s.id = w.workspace_id WHERE s.slug = 'wb2003-spike-b'`);
  checks.push(ok("workspace B owns only its own workbook", wsRows.length === 1 && wsRows[0]!.id === iso, `${wsRows.length} workbook(s)`));

  // Erasing a workspace must remove its workbook, rows and cells and nothing of workspace A (rolled back).
  let cascade = "";
  let cascadeOk = false;
  try {
    await sql.begin(async (tx) => {
      const t0 = performance.now();
      await tx.unsafe(`DELETE FROM public.workspaces WHERE slug = 'wb2003-spike-b'`);
      const ms = Math.round(performance.now() - t0);
      const left = Number((await tx.unsafe<{ n: string }[]>(`SELECT count(*)::text AS n FROM ${t.cells} WHERE ${cellsOf(iso)}`))[0]!.n);
      const main = Number((await tx.unsafe<{ n: string }[]>(`SELECT count(*)::text AS n FROM ${t.cells} WHERE ${cellsOf(wb)}`))[0]!.n);
      cascadeOk = left === 0 && main === mainCells;
      cascade = `deleting workspace B removed its ${isoCells} cells in ${ms} ms; workspace A still has ${main.toLocaleString()}`;
      throw new Error("__rollback__");
    });
  } catch (e) {
    if ((e as Error).message !== "__rollback__") throw e;
  }
  checks.push(ok("deleting a workspace cascades to its workbooks, rows and cells only", cascadeOk, cascade));

  // --- sort correctness (the database sorts; the oracle sorts independently in JS) ---------------------------
  const company = await oracleColumn(sql, v, COL.company);
  const byteCompare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const expectedCompany = [...company].sort((a, b) => {
    const av = a.value == null ? null : String(a.value);
    const bv = b.value == null ? null : String(b.value);
    if (av === null || bv === null) return av === bv ? a.position - b.position : av === null ? 1 : -1;
    return byteCompare(av, bv) || a.position - b.position;
  });
  const dbCompany = await sql.unsafe<{ id: string | number }[]>(
    `SELECT r.id FROM ${t.rows} r LEFT JOIN ${t.cells} s ON s.row_id = r.id AND s.column_id = '${columnIdOf("main", COL.company)}'
     WHERE r.workbook_id = '${wb}' ORDER BY (s.value #>> '{}') COLLATE "C" NULLS LAST, r.position`
  );
  const sameCompany = dbCompany.length === expectedCompany.length && dbCompany.every((r, i) => String(r.id) === String(expectedCompany[i]!.id));
  checks.push(ok("sorting all 100k rows by a text column matches an independent JS sort", sameCompany, `${dbCompany.length} rows compared end to end`));

  const score = await oracleColumn(sql, v, COL.leadScore);
  const expectedScore = [...score].sort((a, b) => {
    const av = typeof a.value === "number" ? a.value : null;
    const bv = typeof b.value === "number" ? b.value : null;
    if (av === null || bv === null) return av === bv ? a.position - b.position : av === null ? 1 : -1;
    return bv - av || a.position - b.position;
  });
  // Lead score has ~1,000 tied rows per value at 100k rows, so a window inside one tie group is ordered by position
  // whatever the sort does. Offsets that straddle a group boundary are the ones that prove the order.
  const boundaryNear = (from: number) => {
    for (let i = Math.max(1, from); i < expectedScore.length; i++) if (expectedScore[i]!.value !== expectedScore[i - 1]!.value) return Math.max(0, i - WINDOW_SIZE / 2);
    return 0;
  };
  const sortOffsets = [...new Set([0, boundaryNear(Math.floor(rows * 0.3)), boundaryNear(Math.floor(rows * 0.6)), boundaryNear(Math.floor(rows * 0.9)), Math.max(0, rows - WINDOW_SIZE)])];
  for (const off of sortOffsets) {
    const res = await sql.unsafe<{ row_id: string | number; position: number }[]>(sortedWindowSql(v, "DESC"), [wb, columnIdOf("main", COL.leadScore), off]);
    const gotIds = [...new Map(res.map((r) => [String(r.row_id), r.position])).keys()];
    const want = expectedScore.slice(off, off + WINDOW_SIZE).map((r) => String(r.id));
    // The window is ordered by (score desc, position); compare as an ordered list of row ids.
    const ordered = res.filter((r, i, a) => a.findIndex((x) => x.row_id === r.row_id) === i).map((r) => String(r.row_id));
    checks.push(ok(`numeric sort (jsonb order) window at offset ${off} matches the JS sort`, ordered.length === want.length && ordered.every((id, i) => id === want[i]) && gotIds.length === want.length, `${want.length} rows`));
  }

  const plan = await sql.unsafe<{ "QUERY PLAN": unknown }[]>(`EXPLAIN (FORMAT JSON) ${sortedWindowSql(v)}`, [wb, columnIdOf("main", COL.company), 0] as never[]);
  const planText = JSON.stringify(plan[0]!["QUERY PLAN"]);
  const sortRes = await sql.unsafe(sortedWindowSql(v), [wb, columnIdOf("main", COL.company), 0] as never[]);
  checks.push(ok("sorting happens in the database and returns one window", /"Node Type":\s*"(Sort|Incremental Sort|Index Scan|Index Only Scan)"/.test(planText) && /"Node Type":\s*"Limit"/.test(planText) && sortRes.length <= WINDOW_SIZE * COLUMN_COUNT, `plan has a Sort/index-ordered node and a Limit; the client received ${sortRes.length} cell rows, not 100k`));

  // --- filter correctness -------------------------------------------------------------------------------------
  const oracle: Record<FilterKind, (r: { value: unknown; state: string }) => boolean> = {
    state_error: (r) => r.state === "error",
    value_equals: (r) => r.value === "valid",
    text_contains: (r) => typeof r.value === "string" && r.value.toLowerCase().endsWith(".io"),
    numeric_gt: (r) => typeof r.value === "number" && r.value > 80,
    is_empty: (r) => r.value === null || r.value === undefined,
  };
  for (const kind of Object.keys(FILTERS) as FilterKind[]) {
    const f = FILTERS[kind];
    const data = await oracleColumn(sql, v, f.column);
    const want = data.filter((r) => oracle[kind](r));
    const got = Number((await sql.unsafe<{ n: number }[]>(filteredCountSql(v, f), [wb, columnIdOf("main", f.column)] as never[]))[0]!.n);
    const win = await sql.unsafe<{ row_id: string | number }[]>(filteredWindowSql(v, f), [wb, columnIdOf("main", f.column), 0] as never[]);
    const winIds = [...new Set(win.map((r) => String(r.row_id)))];
    const wantIds = want.slice(0, WINDOW_SIZE).map((r) => String(r.id));
    checks.push(ok(`filter ${kind}: count and first window match the oracle (${f.description})`, got === want.length && winIds.length === wantIds.length && winIds.every((id, i) => id === wantIds[i]), `db ${got.toLocaleString()} vs oracle ${want.length.toLocaleString()} rows across all ${rows.toLocaleString()}`));
  }

  const passed = checks.filter((c) => c.pass).length;
  const result = { variant: v.key, schema: schemaOf(v), passed, failed: checks.length - passed, checks };
  saveResult(`verify.${v.key}`, result);
  return result;
}

/** A raw btree over jsonb refuses long values; document the limit with a real failure. Variant independent. */
export async function btreeLimitProbe(sql: Sql): Promise<string> {
  // Index entries are compressed first, so the probe needs text that does not compress (hex of md5 hashes).
  const err = await mustFail(
    sql,
    `CREATE TEMP TABLE probe (c uuid, v jsonb); CREATE INDEX ON probe (c, v);
     INSERT INTO probe SELECT gen_random_uuid(), to_jsonb((SELECT string_agg(md5(i::text), '') FROM generate_series(1, 100) i))`
  );
  return err ?? "no error (unexpected)";
}
