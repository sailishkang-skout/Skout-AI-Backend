import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { processCopsEventOnce, type CopsProcessedStore } from "./cops-relay.js";

/**
 * Real-Postgres duplicate-event check: a redelivered event_id runs its side effect once.
 * Runs only when COPS_TEST_DATABASE_URL is set (see cops-outbox-kill.test.ts).
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

const dbRequire = createRequire(new URL("../../db/package.json", import.meta.url));
const postgres = dbRequire("postgres") as typeof import("postgres");

maybe("consumer dedupe against cops_processed_events (Postgres)", () => {
  const sql = postgres(url as string, { max: 1 });
  const consumer = "test-consumer";
  const eventId = "44444444-4444-4444-8444-444444444444";

  const store: CopsProcessedStore & { release: (c: string, e: string) => Promise<void> } = {
    insertIfAbsent: async (c, e) => {
      const rows = await sql`insert into cops_processed_events (consumer, event_id)
        values (${c}, ${e}) on conflict do nothing returning event_id`;
      return rows.length === 1;
    },
    release: async (c, e) => {
      await sql`delete from cops_processed_events where consumer = ${c} and event_id = ${e}`;
    },
  };

  it("delivers the same event_id twice and runs the side effect once", async () => {
    await sql`delete from cops_processed_events where consumer = ${consumer} and event_id = ${eventId}`;
    let effects = 0;
    const handler = async () => {
      effects++;
    };
    expect(await processCopsEventOnce(store, consumer, eventId, handler)).toBe("processed");
    expect(await processCopsEventOnce(store, consumer, eventId, handler)).toBe("duplicate");
    expect(effects).toBe(1);
    await sql.end();
  });
});
