#!/usr/bin/env node
/**
 * AUTH-ADI-13 — converts Clerk's Dashboard "Export users" CSV into the JSON array
 * `import-clerk-users.ts` (AUTH-BE-21) expects.
 *
 * Clerk's CSV columns (confirmed against the honest-mammoth-99 export, 2026-09-28):
 *   id, first_name, last_name, username, primary_email_address, primary_phone_number,
 *   verified_email_addresses, unverified_email_addresses, verified_phone_numbers,
 *   unverified_phone_numbers, totp_secret, password_digest, password_hasher, created_at
 *
 * It does not include external_accounts / OAuth provider IDs (Clerk support confirmed this —
 * fetch those separately via the Backend API `GET /users` if account-linking needs them; the
 * import tool works without them, those users just fall back to reset/OTP like any Google-only
 * signup with no password_digest).
 *
 * Never logs a digest value, only whether one is present.
 *
 * Usage:
 *   pnpm --filter @skout/db convert-clerk-export-csv <export.csv> <output.json>
 */
import fs from "node:fs";
import path from "node:path";
import type { ClerkExportUser } from "./clerk-user-import.js";

function parseCliArgs(): { inputPath: string; outputPath: string } {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath) {
    console.error("Usage: pnpm --filter @skout/db convert-clerk-export-csv <export.csv> <output.json>");
    process.exit(1);
  }
  return { inputPath, outputPath };
}

/** Minimal RFC 4180 CSV line splitter — handles quoted fields with embedded commas/quotes,
 *  which Clerk's export can produce for the email-list columns. */
export function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,;]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

export function rowToClerkExportUser(row: Record<string, string>): ClerkExportUser {
  const primaryEmail = row.primary_email_address?.trim() || undefined;
  const verifiedEmails = splitList(row.verified_email_addresses);
  const emailVerified = primaryEmail ? verifiedEmails.includes(primaryEmail) : false;

  return {
    id: row.id!,
    email: primaryEmail,
    email_verified: emailVerified,
    // password_hasher is expected to be "bcrypt" per Clerk support's answer; pass the digest
    // through regardless — clerk-user-import.ts's own isBcrypt check ($2 prefix) is the real
    // gate, this is just belt-and-suspenders against a future non-bcrypt hasher.
    password_digest: row.password_digest?.trim() || null,
    first_name: row.first_name?.trim() || null,
    last_name: row.last_name?.trim() || null,
  };
}

export type ConvertResult = {
  users: ClerkExportUser[];
  withDigest: number;
  nonBcryptHasher: number;
};

export function parseCsvText(raw: string): ConvertResult {
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) {
    throw new Error("CSV is empty.");
  }

  const header = splitCsvLine(lines[0]!);
  const users: ClerkExportUser[] = [];
  let withDigest = 0;
  let nonBcryptHasher = 0;

  for (const line of lines.slice(1)) {
    const values = splitCsvLine(line);
    const row: Record<string, string> = {};
    header.forEach((key, i) => {
      row[key] = values[i] ?? "";
    });
    if (!row.id) continue;

    const user = rowToClerkExportUser(row);
    if (user.password_digest) withDigest++;
    if (row.password_hasher && row.password_hasher.trim() && row.password_hasher.trim() !== "bcrypt") {
      nonBcryptHasher++;
    }
    users.push(user);
  }

  return { users, withDigest, nonBcryptHasher };
}

function main(): void {
  const { inputPath, outputPath } = parseCliArgs();
  const resolvedInput = path.resolve(process.cwd(), inputPath);
  if (!fs.existsSync(resolvedInput)) {
    console.error(`CSV not found at: ${resolvedInput}`);
    process.exit(1);
  }

  let result: ConvertResult;
  try {
    result = parseCsvText(fs.readFileSync(resolvedInput, "utf-8"));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  const { users, withDigest, nonBcryptHasher } = result;

  const resolvedOutput = path.resolve(process.cwd(), outputPath);
  fs.writeFileSync(resolvedOutput, JSON.stringify(users, null, 2));

  console.log(`Converted ${users.length} user record(s) from ${inputPath} -> ${outputPath}`);
  console.log(`  With a password digest:    ${withDigest}`);
  console.log(`  Without a digest (Google-only signup, or another SSO provider — expected):  ${users.length - withDigest}`);
  if (nonBcryptHasher > 0) {
    console.warn(
      `  WARNING: ${nonBcryptHasher} row(s) report a password_hasher other than "bcrypt" — ` +
        `verify before running import-clerk-users, its bcrypt check only looks at the digest's $2 prefix.`
    );
  }
  console.log("\nNo hash values were printed above. Next: pnpm --filter @skout/db import-clerk-users " + outputPath + " (dry run, no --apply).");
}

if (process.env.NODE_ENV !== "test") {
  main();
}
