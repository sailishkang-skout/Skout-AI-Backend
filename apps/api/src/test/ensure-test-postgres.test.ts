import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TEST_DATABASE_URL, isPortOpen, resolveTestDatabase } from "../../../../scripts/test-database.mjs";

/** The `pretest` database preparation must act on the database the tests use, and never on a remote one. */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const THROWAWAY = "postgresql://postgres:s3cret@localhost:55432/throwaway";
const REMOTE = "postgresql://postgres:s3cret@db.project.supabase.example:6543/postgres";
const file = (name: string, DATABASE_URL: string) => ({ name, values: { DATABASE_URL } });

describe("resolveTestDatabase", () => {
  it("uses DATABASE_URL from the environment over everything else", () => {
    const r = resolveTestDatabase({ DATABASE_URL: THROWAWAY }, [file(".env", DEFAULT_TEST_DATABASE_URL)]);
    expect(r).toMatchObject({ url: THROWAWAY, source: "DATABASE_URL", local: true, compose: false, label: "localhost:55432/throwaway" });
  });

  it("then .env, then .env.local, as the test setup loads them", () => {
    expect(resolveTestDatabase({}, [file(".env", THROWAWAY), file(".env.local", REMOTE)])).toMatchObject({ url: THROWAWAY, source: ".env" });
    expect(resolveTestDatabase({}, [{ name: ".env", values: {} }, file(".env.local", THROWAWAY)])).toMatchObject({ url: THROWAWAY, source: ".env.local" });
  });

  it("falls back to the docker-compose database", () => {
    expect(resolveTestDatabase({})).toMatchObject({ url: DEFAULT_TEST_DATABASE_URL, source: "the default", local: true, compose: true });
    // An empty variable is "set" to dotenv, so no file replaces it, and the tests then take the default.
    expect(resolveTestDatabase({ DATABASE_URL: "" }, [file(".env", REMOTE)])).toMatchObject({ url: DEFAULT_TEST_DATABASE_URL });
  });

  it("treats only databases on this machine as safe to migrate", () => {
    for (const url of [
      "postgresql://u:p@localhost:5434/skout",
      "postgres://u:p@127.0.0.1/x",
      "postgresql://u:p@[::1]:5432/x",
      "postgresql://u:p@host.docker.internal:5434/x",
      "postgresql://u:p@postgres:5432/skout",
    ]) {
      expect(resolveTestDatabase({ DATABASE_URL: url }).local, url).toBe(true);
    }
    for (const url of [
      REMOTE,
      "postgresql://u:p@10.0.0.5:5432/x",
      "postgresql://u:p@skout-dev.abc123.rds.amazonaws.com:5432/skout",
      "postgresql://u:p@localhost.evil.example:5432/x",
      "postgresql://u:p@localhost:5432/x?host=db.remote.example",
      "mysql://u:p@localhost:3306/x",
      "not a url",
    ]) {
      expect(resolveTestDatabase({ DATABASE_URL: url }).local, url).toBe(false);
    }
  });

  it("only ever starts docker compose for its own port on this machine", () => {
    const compose = (url: string) => resolveTestDatabase({ DATABASE_URL: url }).compose;
    expect(compose("postgresql://u:p@127.0.0.1:5434/skout")).toBe(true);
    expect(compose(THROWAWAY)).toBe(false);
    expect(compose("postgresql://u:p@localhost:5432/skout")).toBe(false);
    expect(compose("postgresql://u:p@host.docker.internal:5434/skout")).toBe(false);
    expect(compose(REMOTE)).toBe(false);
  });

  it("never puts credentials in the label it prints", () => {
    for (const url of [THROWAWAY, REMOTE, "garbage s3cret"]) expect(resolveTestDatabase({ DATABASE_URL: url }).label).not.toContain("s3cret");
  });
});

describe("isPortOpen", () => {
  it("is true only while something is listening", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;
    expect(await isPortOpen("127.0.0.1", port)).toBe(true);
    await new Promise((resolve) => server.close(resolve));
    expect(await isPortOpen("127.0.0.1", port)).toBe(false);
  });
});

/** The real scripts, with `pnpm` and `docker` replaced by stubs that only record how they were called. */
describe.skipIf(process.platform === "win32")("ensure-test-postgres scripts", () => {
  let bin: string;
  let log: string;

  beforeAll(() => {
    bin = mkdtempSync(path.join(os.tmpdir(), "ensure-pg-"));
    log = path.join(bin, "calls.log");
    for (const name of ["pnpm", "docker"]) {
      writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $* | $DATABASE_URL" >> "${log}"\n`);
      chmodSync(path.join(bin, name), 0o755);
    }
  });
  beforeEach(() => rmSync(log, { force: true }));
  afterAll(() => rmSync(bin, { recursive: true, force: true }));

  function run(app: "api" | "crm", env: Record<string, string>) {
    const childEnv: Record<string, string | undefined> = { ...process.env, ...env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
    if (env.CI === undefined) delete childEnv.CI;
    delete childEnv.GITHUB_ACTIONS;
    const res = spawnSync(process.execPath, [path.join(repoRoot, "apps", app, "scripts", "ensure-test-postgres.mjs")], { env: childEnv as NodeJS.ProcessEnv, encoding: "utf8" });
    return { status: res.status, output: `${res.stdout}${res.stderr}`, calls: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [] };
  }

  it("API: migrates, repairs and seeds the database DATABASE_URL names, without starting docker", () => {
    const r = run("api", { DATABASE_URL: THROWAWAY });
    expect(r.status, r.output).toBe(0);
    expect(r.calls).toHaveLength(3);
    expect(r.calls.map((c) => c.split(" | ")[1])).toEqual([THROWAWAY, THROWAWAY, THROWAWAY]);
    expect(r.calls[0]).toContain("db:migrate");
    expect(r.calls[1]).toContain("apply-pending");
    expect(r.calls[2]).toContain("backfill-rbac");
    expect(r.calls.join("\n")).not.toContain("5434");
    expect(r.output).toContain("migrating localhost:55432/throwaway (from DATABASE_URL)");
    expect(r.output).not.toContain("s3cret");
  });

  it("API: changes nothing when DATABASE_URL is remote, and says so", () => {
    const r = run("api", { DATABASE_URL: REMOTE });
    expect(r.status, r.output).toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.output).toContain("was NOT migrated");
    expect(r.output).not.toContain("s3cret");
  });

  it("API: in CI it still migrates DATABASE_URL, as before", () => {
    const r = run("api", { DATABASE_URL: THROWAWAY, CI: "true" });
    expect(r.status, r.output).toBe(0);
    expect(r.calls).toHaveLength(3);
    expect(r.calls.every((c) => c.endsWith(THROWAWAY))).toBe(true);
  });

  it("CRM: leaves docker alone when the tests use another database", () => {
    for (const url of [THROWAWAY, REMOTE]) {
      const r = run("crm", { DATABASE_URL: url });
      expect(r.status, r.output).toBe(0);
      expect(r.calls).toEqual([]);
    }
  });
});
