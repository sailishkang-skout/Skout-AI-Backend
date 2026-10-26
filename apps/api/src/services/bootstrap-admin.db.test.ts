import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "@skout/db";
import { bootstrapAdmin } from "./bootstrap-admin.service.js";

/** Runs only when COPS_TEST_DATABASE_URL is set (real Postgres). */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("bootstrapAdmin", () => {
  let db: Db;
  let close: () => Promise<void>;
  const email = `boot-${Date.now().toString(36)}@example.test`;

  beforeAll(() => {
    const made = createDb(url as string);
    db = made.db as unknown as Db;
    close = () => made.sql.end();
  });
  afterAll(async () => close?.());

  it("creates the admin once and never changes an existing password", async () => {
    expect(await bootstrapAdmin(db, {})).toBe("skipped_not_configured");
    expect(await bootstrapAdmin(db, { BOOTSTRAP_ADMIN_EMAIL: email, BOOTSTRAP_ADMIN_PASSWORD: "short" })).toBe("rejected_policy");
    expect(await bootstrapAdmin(db, { BOOTSTRAP_ADMIN_EMAIL: email, BOOTSTRAP_ADMIN_PASSWORD: "Correct-Horse-9-Battery" })).toBe("created");
    expect(await bootstrapAdmin(db, { BOOTSTRAP_ADMIN_EMAIL: email, BOOTSTRAP_ADMIN_PASSWORD: "Another-Strong-Pass-7" })).toBe("skipped_exists");
  });
});
