#!/usr/bin/env node
/**
 * AUTH-BE-21 — Clerk user import CLI.
 *
 * Usage:
 *   pnpm --filter @skout/db import-clerk-users <path-to-export.json> [--apply]
 *
 * Defaults to dry-run (read-only). Pass `--apply` to write credentials and
 * identities into PostgreSQL. Never logs hashes or PII.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "./client.js";
import { resolveDatabaseUrl } from "./database-url.js";
import { importClerkUsers, type ClerkExportUser } from "./clerk-user-import.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
try {
  const { config } = await import("dotenv");
  config({ path: path.resolve(__dirname, "../../../.env") });
} catch {
  // ECS / task injects database env vars directly.
}

function parseCliArgs(): { filePath: string | null; apply: boolean } {
  const args = process.argv.slice(2);
  let apply = false;
  let filePath: string | null = null;

  for (const arg of args) {
    if (arg === "--apply") {
      apply = true;
    } else if (!arg.startsWith("--") && !filePath) {
      filePath = arg;
    }
  }

  return { filePath, apply };
}

function parseExportFile(filePath: string): ClerkExportUser[] {
  const resolvedPath = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Export file not found at path: ${resolvedPath}`);
  }

  const raw = fs.readFileSync(resolvedPath, "utf-8").trim();
  if (!raw) {
    throw new Error(`Export file is empty: ${resolvedPath}`);
  }

  // Try parsing as standard JSON
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed as ClerkExportUser[];
    }
    if (parsed && typeof parsed === "object") {
      if (Array.isArray(parsed.users)) {
        return parsed.users as ClerkExportUser[];
      }
      if (Array.isArray(parsed.data)) {
        return parsed.data as ClerkExportUser[];
      }
      // Single user object
      if (parsed.id) {
        return [parsed as ClerkExportUser];
      }
    }
  } catch {
    // If not standard JSON, try parsing as JSON Lines (one JSON object per line)
    const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
    const users: ClerkExportUser[] = [];
    for (let i = 0; i < lines.length; i++) {
      try {
        const item = JSON.parse(lines[i]!);
        if (item && typeof item === "object") {
          users.push(item as ClerkExportUser);
        }
      } catch (err) {
        throw new Error(`Failed to parse line ${i + 1} as JSON: ${(err as Error).message}`);
      }
    }
    if (users.length > 0) {
      return users;
    }
  }

  throw new Error("Could not parse export file as a JSON array or JSON Lines format.");
}

async function main() {
  const { filePath, apply } = parseCliArgs();

  if (!filePath) {
    console.error("Usage: pnpm --filter @skout/db import-clerk-users <export-file.json> [--apply]");
    console.error("  --apply    Write credentials and identities to DB (default: dry-run)");
    process.exit(1);
  }

  console.log(`Starting Clerk user import...`);
  console.log(`Export file: ${filePath}`);
  console.log(`Mode: ${apply ? "APPLY (writing changes to DB)" : "DRY RUN (no changes will be written)"}`);

  let exportUsers: ClerkExportUser[];
  try {
    exportUsers = parseExportFile(filePath);
    console.log(`Parsed ${exportUsers.length} user records from export file.`);
  } catch (err) {
    console.error(`Error reading export file: ${(err as Error).message}`);
    process.exit(1);
  }

  const databaseUrl = resolveDatabaseUrl();
  const { db, sql } = createDb(databaseUrl);

  try {
    const report = await importClerkUsers(db, exportUsers, { apply });

    console.log("\n============================================================");
    console.log(`CLERK USER IMPORT REPORT [${report.dryRun ? "DRY RUN" : "APPLIED"}]`);
    console.log("============================================================");
    console.log(`Total records in export:  ${report.totalInExport}`);
    console.log(`Matched to existing users: ${report.matched}`);
    console.log(`Skipped (no local user):  ${report.skipped}`);
    console.log(`Needs password reset:     ${report.needsReset}`);
    console.log(`Credentials created:      ${report.created.credentials}`);
    console.log(`Identities created:       ${report.created.identities}`);
    console.log(`Conflicts detected:       ${report.conflicts.length}`);

    if (report.conflicts.length > 0) {
      console.log("\nConflicts Summary (PII redacted):");
      for (const conflict of report.conflicts) {
        console.log(`  - [${conflict.clerkUserId ?? "unknown"}]: ${conflict.reason} (${conflict.details ?? ""})`);
      }
    }
    console.log("============================================================\n");

    if (report.conflicts.length > 0) {
      console.warn("One or more conflicts were detected during import. Investigate before proceeding.");
      process.exitCode = 1;
    }
  } finally {
    await sql.end();
  }
}

if (process.env.NODE_ENV !== "test") {
  main().catch((err) => {
    console.error("Fatal error during Clerk user import:", err.message);
    process.exit(1);
  });
}

