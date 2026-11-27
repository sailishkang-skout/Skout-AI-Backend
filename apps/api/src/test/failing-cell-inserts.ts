import type { createDb } from "@skout/db";

type Sql = ReturnType<typeof createDb>["sql"];

/**
 * Changes a trigger on one table, taking the lock the change needs before anything else.
 *
 * `drop trigger` on its own first takes a weak lock on the table and then asks for the strongest one. Two test files
 * doing that on the same table each hold what the other is waiting past, and the database ends one as a deadlock. With
 * the strong lock taken first, the second simply waits its turn.
 */
async function changeTrigger(sql: Sql, table: string, lock: "share row exclusive" | "access exclusive", statement: string): Promise<void> {
  await sql.begin(async (tx) => {
    await tx.unsafe(`lock table ${table} in ${lock} mode`);
    await tx.unsafe(statement);
  });
}

/**
 * Makes the database refuse some cell inserts while `run` executes, to show that a write is all or nothing.
 *
 * The trigger goes on one partition of `workbook_cells` at a time, each in its own transaction. A trigger created or
 * dropped on the partitioned table itself locks all 64 partitions together, and deadlocks with any other test file
 * that is reading or writing cells at that moment.
 *
 * @param name a unique SQL identifier for the function and its triggers
 * @param condition a PL/pgSQL condition on `new`; matching inserts raise an error
 */
export async function withFailingCellInserts<T>(sql: Sql, name: string, condition: string, run: () => Promise<T>): Promise<T> {
  const partitions = await sql<{ name: string }[]>`select inhrelid::regclass::text as name from pg_inherits where inhparent = 'workbook_cells'::regclass order by 1`;
  if (!partitions.length) throw new Error("workbook_cells has no partitions");
  await sql.unsafe(`create function ${name}() returns trigger language plpgsql as $$ begin if ${condition} then raise exception 'boom'; end if; return new; end $$`);
  try {
    for (const partition of partitions) {
      await changeTrigger(sql, partition.name, "share row exclusive", `create trigger ${name} before insert on ${partition.name} for each row execute function ${name}()`);
    }
    return await run();
  } finally {
    for (const partition of partitions) await changeTrigger(sql, partition.name, "access exclusive", `drop trigger if exists ${name} on ${partition.name}`);
    await sql.unsafe(`drop function if exists ${name}()`);
  }
}
