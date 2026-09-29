import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createDb, schema } from "@skout/db";
import { inArray } from "drizzle-orm";
import { loadEnv } from "../config/env.js";
import { fetchCohortRows, pickLoginMethod, splitEmail } from "./login-discovery.service.js";

describe("login-discovery.service (AUTH-BE-22) — pure resolution", () => {
  it("normalizes the email and extracts the domain", () => {
    expect(splitEmail("  Bob@Example.COM ")).toEqual({ email: "bob@example.com", domain: "example.com" });
  });

  it("returns the default when no row matches", () => {
    expect(pickLoginMethod([], "clerk")).toBe("clerk");
    expect(pickLoginMethod([], "password")).toBe("password");
  });

  it("uses a domain row", () => {
    expect(pickLoginMethod([{ subjectType: "domain", method: "sso" }], "clerk")).toBe("sso");
  });

  it("an exact-email row overrides a domain row, whatever the row order", () => {
    const rows = [
      { subjectType: "domain", method: "password" },
      { subjectType: "email", method: "google" },
    ];
    expect(pickLoginMethod(rows, "clerk")).toBe("google");
    expect(pickLoginMethod([...rows].reverse(), "clerk")).toBe("google");
  });

  it("ignores rows with an unrecognized method", () => {
    expect(pickLoginMethod([{ subjectType: "email", method: "magic" }], "clerk")).toBe("clerk");
    expect(
      pickLoginMethod(
        [
          { subjectType: "email", method: "magic" },
          { subjectType: "domain", method: "password" },
        ],
        "clerk"
      )
    ).toBe("password");
  });
});

describe("login-discovery.service (AUTH-BE-22) — database lookup", () => {
  const config = loadEnv();
  const { db, sql } = createDb(config.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/skout");
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const domain = `be22-${suffix}.example.test`;
  const createdSubjects: string[] = [];

  async function addRow(subjectType: "domain" | "email", subject: string, method: string) {
    createdSubjects.push(subject);
    await db.insert(schema.authLoginCohorts).values({ subjectType, subject, method });
  }

  afterEach(async () => {
    if (createdSubjects.length) {
      await db.delete(schema.authLoginCohorts).where(inArray(schema.authLoginCohorts.subject, createdSubjects));
      createdSubjects.length = 0;
    }
  });

  afterAll(async () => {
    await sql.end();
  });

  async function discoverLoginMethod(rawEmail: string, defaultMethod: "clerk") {
    const { email, domain: d } = splitEmail(rawEmail);
    return pickLoginMethod(await fetchCohortRows(db, email, d), defaultMethod);
  }

  it("falls back to the default for an unlisted email", async () => {
    expect(await discoverLoginMethod(`nobody@${domain}`, "clerk")).toBe("clerk");
  });

  it("routes a listed domain, case-insensitively", async () => {
    await addRow("domain", domain, "password");
    expect(await discoverLoginMethod(`Someone@${domain.toUpperCase()}`, "clerk")).toBe("password");
  });

  it("returns sso for an SSO-bound domain", async () => {
    await addRow("domain", domain, "sso");
    expect(await discoverLoginMethod(`anyone@${domain}`, "clerk")).toBe("sso");
  });

  it("an exact-email row overrides its domain row", async () => {
    await addRow("domain", domain, "password");
    await addRow("email", `vip@${domain}`, "google");
    expect(await discoverLoginMethod(`vip@${domain}`, "clerk")).toBe("google");
    expect(await discoverLoginMethod(`other@${domain}`, "clerk")).toBe("password");
  });

  it("rejects an unknown method at the database level", async () => {
    await expect(
      db.insert(schema.authLoginCohorts).values({ subjectType: "domain", subject: `bad-${domain}`, method: "magic" })
    ).rejects.toThrow();
  });
});
