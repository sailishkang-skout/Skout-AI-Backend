import { eq, sql } from "drizzle-orm";
import { schema, type Db } from "@skout/db";

/**
 * What every kind of workbook import (CSV, list, smart list, search) shares: its counts, how a chunk is recorded
 * exactly once, and how failures are described.
 */
const { workbookImports } = schema;

export const IMPORT_SOURCE_TYPES = ["csv", "list", "smart_list", "search"] as const;
export type ImportSourceType = (typeof IMPORT_SOURCE_TYPES)[number];

export interface ImportCounts {
  total: number;
  processed: number;
  imported: number;
  duplicates: number;
  skipped: number;
  failed: number;
}

export function countsOf(stored: Record<string, number> | null | undefined): ImportCounts {
  const n = (key: keyof ImportCounts) => stored?.[key] ?? 0;
  return { total: n("total"), processed: n("processed"), imported: n("imported"), duplicates: n("duplicates"), skipped: n("skipped"), failed: n("failed") };
}

/** Something retrying cannot fix. */
export class ImportStopped extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ImportStopped";
  }
}

/** Another worker moved this import on, or it finished: this attempt has nothing left to do. */
export class Superseded extends Error {}

/**
 * What may be logged about a failure: its kind and code only. A database error's own text quotes the statement and its
 * values, which here are the rows of someone's file, and a file error's text names where files are kept.
 */
export function describeFailure(error: unknown): string {
  const e = (error ?? {}) as { name?: unknown; code?: unknown; cause?: { code?: unknown; constraint_name?: unknown } };
  return [e.name, e.cause?.code ?? e.code, e.cause?.constraint_name].filter((part) => typeof part === "string" && part).join(" ") || "unknown error";
}

/** An unexpected failure with nothing from the original error but what `describeFailure` allows. */
export class ImportFailure extends Error {
  readonly code?: string;
  constructor(what: string, error: unknown) {
    super(`${what} (${describeFailure(error)})`);
    this.name = "ImportFailure";
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === "string") this.code = code;
  }
}

export const lockImport = async (tx: Db, importId: string) => (await tx.select().from(workbookImports).where(eq(workbookImports.id, importId)).limit(1).for("no key update"))[0];

export type Issue = { record: number; line: number; kind: (typeof schema.WORKBOOK_IMPORT_ISSUE_KINDS)[number]; reason: string; values: string[] };

/** Inside a chunk's transaction: stores the rows it did not add and moves the import past the chunk. */
export async function recordChunk(tx: Db, importId: string, counts: ImportCounts, chunk: { processed: number; imported: number }, issues: Issue[]): Promise<void> {
  if (issues.length) {
    await tx.execute(sql`
      INSERT INTO workbook_import_issues (import_id, record, line, kind, reason, "values")
      SELECT ${importId}::uuid, x.record, x.line, x.kind, x.reason, x."values"
      FROM jsonb_to_recordset(${JSON.stringify(issues)}::text::jsonb) AS x (record int, line int, kind text, reason text, "values" jsonb)`);
  }
  const duplicates = issues.filter((i) => i.kind === "duplicate").length;
  const skipped = issues.filter((i) => i.kind === "skipped").length;
  const next: ImportCounts = {
    total: counts.total,
    processed: counts.processed + chunk.processed,
    imported: counts.imported + chunk.imported,
    duplicates: counts.duplicates + duplicates,
    skipped: counts.skipped + skipped,
    failed: counts.failed + issues.length - duplicates - skipped,
  };
  await tx.update(workbookImports).set({ counts: { ...next }, updatedAt: sql`now()` }).where(eq(workbookImports.id, importId));
}
