import { describe, expect, it } from "vitest";
import postgres from "postgres";

/**
 * Tenant-scoped uniqueness on the COPS-02 gap tables, against real Postgres.
 * Runs only when COPS_TEST_DATABASE_URL is set.
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("COPS-02 gap tables are tenant-scoped (Postgres)", () => {
  const sql = postgres(url as string, { max: 1 });
  const tagName = `tenant-scope-${Date.now()}`;

  async function workspace(label: string): Promise<string> {
    const [row] = await sql`insert into workspaces (name, slug) values (${label}, ${`tenant-${label}-${Date.now()}-${Math.random()}`}) returning id`;
    return row.id as string;
  }

  it("allows the same tag name in two different workspaces", async () => {
    const a = await workspace("A");
    const b = await workspace("B");
    await sql`insert into tags (workspace_id, name) values (${a}, ${tagName})`;
    await sql`insert into tags (workspace_id, name) values (${b}, ${tagName})`;
    const rows = await sql`select workspace_id from tags where name = ${tagName} and workspace_id in (${a}, ${b})`;
    expect(rows.length).toBe(2);
  });

  it("rejects a duplicate tag name inside one workspace", async () => {
    const a = await workspace("A2");
    await sql`insert into tags (workspace_id, name) values (${a}, ${tagName + "-dup"})`;
    await expect(
      sql`insert into tags (workspace_id, name) values (${a}, ${tagName + "-dup"})`
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("scopes custom field definitions per workspace", async () => {
    const a = await workspace("CF-A");
    const b = await workspace("CF-B");
    await sql`insert into custom_field_definitions (workspace_id, object_type, key, label, field_type) values (${a}, 'account', 'tier', 'Tier', 'text')`;
    await sql`insert into custom_field_definitions (workspace_id, object_type, key, label, field_type) values (${b}, 'account', 'tier', 'Tier', 'text')`;
    await expect(
      sql`insert into custom_field_definitions (workspace_id, object_type, key, label, field_type) values (${a}, 'account', 'tier', 'Tier', 'text')`
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it.todo("rejects linking accounts from two different workspaces (application-level check, not yet implemented)");

  it("closes the connection", async () => {
    await sql.end();
  });
});
