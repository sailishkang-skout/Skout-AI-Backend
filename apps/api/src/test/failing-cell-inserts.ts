import type { createDb } from "@skout/db";

type Sql = ReturnType<typeof createDb>["sql"];

/**
 * Makes the database refuse some cell inserts while `run` executes, to show that a write is all or nothing.
 *
 * The trigger goes on one partition of `workbook_cells` at a time, each in its own statement. A trigger created or
 * dropped on the partitioned table itself locks all 64 partitions together, and deadlocks with any other test file
 * that is reading or writing cells at that moment. A statement waiting for a single lock cannot be part of a deadlock.
 *
 * @param name a unique SQL identifier for the function and its triggers
 * @param condition a PL/pgSQL condition on `new`; matching inserts raise an error
 */
export async function withFailingCellInserts<T>(sql: Sql, name: string, condition: string, run: () => Promise<T>): Promise<T> {
  const partitions = await sql<{ name: string }[]>`select inhrelid::regclass::text as name from pg_inherits where inhparent = 'workbook_cells'::regclass order by 1`;
  if (!partitions.length) throw new Error("workbook_cells has no partitions");
  await sql.unsafe(`create function ${name}() returns trigger language plpgsql as $$ begin if ${condition} then raise exception 'boom'; end if; return new; end $$`);
  try {
    for (const partition of partitions) await sql.unsafe(`create trigger ${name} before insert on ${partition.name} for each row execute function ${name}()`);
    return await run();
  } finally {
    for (const partition of partitions) await sql.unsafe(`drop trigger if exists ${name} on ${partition.name}`);
    await sql.unsafe(`drop function if exists ${name}()`);
  }
}
