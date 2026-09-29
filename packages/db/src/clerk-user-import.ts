/**
 * AUTH-BE-21 — Clerk user import tool (core import logic).
 *
 * Reads Clerk user records and reconciles them against existing PostgreSQL users.
 * - Match priority: clerk_user_id first, then verified normalized email.
 * - Additive only: adds user_credentials and auth_identities to existing users,
 *   never creates new user rows (users are lazily provisioned).
 * - Stores bcrypt hashes with hash_algo: "bcrypt" so BE-11 can verify-and-upgrade
 *   to argon2id on first successful login.
 * - For users without a usable hash, sets must_reset = true.
 * - Google external accounts receive a google identity row.
 * - Dry-run by default, --apply required to write.
 * - Idempotent: re-running produces zero new rows.
 * - Reports counts only, never logs hashes or PII (Ground Rule 3).
 */
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { users } from "./schema/users.js";
import { userCredentials } from "./schema/auth-own.js";
import { authIdentities } from "./schema/auth-identities.js";

export interface ClerkExportEmail {
  id?: string;
  email_address: string;
  verification?: {
    status?: string;
  } | null;
}

export interface ClerkExportExternalAccount {
  id?: string;
  provider: string; // e.g. "google" | "oauth_google"
  provider_user_id?: string;
  google_id?: string;
  email_address?: string;
  verification?: {
    status?: string;
  } | null;
}

export interface ClerkExportUser {
  id: string; // Clerk user ID (e.g. "user_2...")
  email_addresses?: ClerkExportEmail[];
  email?: string;
  email_address?: string;
  email_verified?: boolean;
  password_digest?: string | null;
  password_hash?: string | null;
  external_accounts?: ClerkExportExternalAccount[];
  google_id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  banned?: boolean;
  locked?: boolean;
}

export interface ClerkImportConflict {
  clerkUserId?: string;
  reason: "duplicate_email_in_export" | "multiple_db_users_matched" | "ambiguous_match";
  details?: string;
}

export interface ClerkImportReport {
  dryRun: boolean;
  totalInExport: number;
  matched: number;
  created: {
    credentials: number;
    identities: number;
  };
  skipped: number;
  needsReset: number;
  conflicts: ClerkImportConflict[];
}

export interface ImportClerkUsersOptions {
  apply?: boolean;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function extractEmail(user: ClerkExportUser): { email: string | null; isVerified: boolean } {
  if (Array.isArray(user.email_addresses) && user.email_addresses.length > 0) {
    const verified = user.email_addresses.find((e) => e.verification?.status === "verified");
    if (verified && verified.email_address) {
      return { email: normalizeEmail(verified.email_address), isVerified: true };
    }
    const first = user.email_addresses[0];
    if (first && first.email_address) {
      return {
        email: normalizeEmail(first.email_address),
        isVerified: first.verification?.status === "verified",
      };
    }
  }

  const rawEmail = user.email ?? user.email_address;
  if (rawEmail) {
    const isVerified = user.email_verified !== false;
    return { email: normalizeEmail(rawEmail), isVerified };
  }

  return { email: null, isVerified: false };
}

export function extractGoogleSubject(user: ClerkExportUser): string | null {
  if (Array.isArray(user.external_accounts)) {
    const googleAcc = user.external_accounts.find(
      (acc) => acc.provider === "google" || acc.provider === "oauth_google"
    );
    if (googleAcc) {
      return googleAcc.provider_user_id ?? googleAcc.google_id ?? null;
    }
  }
  return user.google_id ?? null;
}

export function extractPasswordHash(user: ClerkExportUser): { hash: string | null; isBcrypt: boolean } {
  const raw = (user.password_digest ?? user.password_hash ?? "").trim();
  if (!raw) return { hash: null, isBcrypt: false };
  const isBcrypt = raw.startsWith("$2");
  return { hash: raw, isBcrypt };
}

export async function importClerkUsers(
  db: Db,
  exportUsers: ClerkExportUser[],
  options: ImportClerkUsersOptions = {}
): Promise<ClerkImportReport> {
  const apply = options.apply === true;

  const report: ClerkImportReport = {
    dryRun: !apply,
    totalInExport: exportUsers.length,
    matched: 0,
    created: {
      credentials: 0,
      identities: 0,
    },
    skipped: 0,
    needsReset: 0,
    conflicts: [],
  };

  // 1. Conflict pre-scan: find duplicate verified emails inside the export file
  const verifiedEmailCounts = new Map<string, number>();
  for (const clerkUser of exportUsers) {
    const { email, isVerified } = extractEmail(clerkUser);
    if (email && isVerified) {
      verifiedEmailCounts.set(email, (verifiedEmailCounts.get(email) ?? 0) + 1);
    }
  }

  const conflictingEmails = new Set<string>();
  for (const [email, count] of verifiedEmailCounts.entries()) {
    if (count > 1) {
      conflictingEmails.add(email);
    }
  }

  // 2. Process each Clerk user
  for (const clerkUser of exportUsers) {
    const clerkId = clerkUser.id;
    const { email, isVerified } = extractEmail(clerkUser);

    if (email && conflictingEmails.has(email)) {
      report.conflicts.push({
        clerkUserId: clerkId,
        reason: "duplicate_email_in_export",
        details: "Multiple export records share this email address",
      });
      continue;
    }

    // Match priority 1: clerk_user_id
    let matchedUser: { id: string; email: string; clerkUserId: string | null } | null = null;
    if (clerkId) {
      const [byClerkId] = await db
        .select({ id: users.id, email: users.email, clerkUserId: users.clerkUserId })
        .from(users)
        .where(eq(users.clerkUserId, clerkId))
        .limit(1);
      if (byClerkId) {
        matchedUser = byClerkId;
      }
    }

    // Match priority 2: verified normalized email
    if (!matchedUser && email && isVerified) {
      const candidates = await db
        .select({ id: users.id, email: users.email, clerkUserId: users.clerkUserId })
        .from(users)
        .where(sql`lower(trim(${users.email})) = ${email}`)
        .limit(2);

      if (candidates.length > 1) {
        report.conflicts.push({
          clerkUserId: clerkId,
          reason: "multiple_db_users_matched",
          details: "Multiple database users matched by email",
        });
        continue;
      }

      if (candidates.length === 1 && candidates[0]) {
        matchedUser = candidates[0];
      }
    }

    // If no local user matched, skip (no new users created)
    if (!matchedUser) {
      report.skipped++;
      continue;
    }

    report.matched++;

    const { hash, isBcrypt } = extractPasswordHash(clerkUser);
    const googleSub = extractGoogleSubject(clerkUser);
    const hasUsablePassword = Boolean(isBcrypt && hash);

    if (apply) {
      // Create/ensure clerk identity
      if (clerkId) {
        const [identity] = await db
          .insert(authIdentities)
          .values({
            userId: matchedUser.id,
            provider: "clerk",
            providerSubject: clerkId,
            emailAtLink: matchedUser.email,
            emailVerifiedAt: isVerified ? new Date() : null,
          })
          .onConflictDoNothing({ target: [authIdentities.provider, authIdentities.providerSubject] })
          .returning({ id: authIdentities.id });

        if (identity) {
          report.created.identities++;
        }
      }

      // Create/ensure google identity if present
      if (googleSub) {
        const [googleIdentity] = await db
          .insert(authIdentities)
          .values({
            userId: matchedUser.id,
            provider: "google",
            providerSubject: googleSub,
            emailAtLink: matchedUser.email,
            emailVerifiedAt: new Date(),
          })
          .onConflictDoNothing({ target: [authIdentities.provider, authIdentities.providerSubject] })
          .returning({ id: authIdentities.id });

        if (googleIdentity) {
          report.created.identities++;
        }
      }

      // Create/ensure password identity if usable password is provided (required for own-auth login)
      if (hasUsablePassword && email) {
        const [pwIdentity] = await db
          .insert(authIdentities)
          .values({
            userId: matchedUser.id,
            provider: "password",
            providerSubject: email,
            emailAtLink: matchedUser.email,
            emailVerifiedAt: isVerified ? new Date() : null,
          })
          .onConflictDoNothing({ target: [authIdentities.provider, authIdentities.providerSubject] })
          .returning({ id: authIdentities.id });

        if (pwIdentity) {
          report.created.identities++;
        }
      }

      // Create/update user_credentials
      const [existingCred] = await db
        .select({
          userId: userCredentials.userId,
          hashAlgo: userCredentials.hashAlgo,
          mustReset: userCredentials.mustReset,
        })
        .from(userCredentials)
        .where(eq(userCredentials.userId, matchedUser.id))
        .limit(1);

      if (!existingCred) {
        if (hasUsablePassword) {
          await db.insert(userCredentials).values({
            userId: matchedUser.id,
            passwordHash: hash!,
            hashAlgo: "bcrypt",
            hashParams: {},
            mustReset: false,
          });
          report.created.credentials++;
        } else {
          await db.insert(userCredentials).values({
            userId: matchedUser.id,
            passwordHash: "!imported:no_usable_hash",
            hashAlgo: "none",
            hashParams: {},
            mustReset: true,
          });
          report.created.credentials++;
          report.needsReset++;
        }
      } else {
        // Idempotency: if mustReset is true and we now have a bcrypt hash, update it
        if (existingCred.mustReset && hasUsablePassword) {
          await db
            .update(userCredentials)
            .set({
              passwordHash: hash!,
              hashAlgo: "bcrypt",
              hashParams: {},
              mustReset: false,
              updatedAt: new Date(),
            })
            .where(eq(userCredentials.userId, matchedUser.id));
          report.created.credentials++;
        } else if (existingCred.mustReset) {
          report.needsReset++;
        }
      }
    } else {
      // Dry-run mode: count projected changes without writing
      if (clerkId) {
        const [hasClerkIdentity] = await db
          .select({ id: authIdentities.id })
          .from(authIdentities)
          .where(
            and(
              eq(authIdentities.provider, "clerk"),
              eq(authIdentities.providerSubject, clerkId)
            )
          )
          .limit(1);
        if (!hasClerkIdentity) {
          report.created.identities++;
        }
      }

      if (googleSub) {
        const [hasGoogleIdentity] = await db
          .select({ id: authIdentities.id })
          .from(authIdentities)
          .where(
            and(
              eq(authIdentities.provider, "google"),
              eq(authIdentities.providerSubject, googleSub)
            )
          )
          .limit(1);
        if (!hasGoogleIdentity) {
          report.created.identities++;
        }
      }

      if (hasUsablePassword && email) {
        const [hasPwIdentity] = await db
          .select({ id: authIdentities.id })
          .from(authIdentities)
          .where(
            and(
              eq(authIdentities.provider, "password"),
              eq(authIdentities.providerSubject, email)
            )
          )
          .limit(1);
        if (!hasPwIdentity) {
          report.created.identities++;
        }
      }

      const [existingCred] = await db
        .select({
          userId: userCredentials.userId,
          mustReset: userCredentials.mustReset,
        })
        .from(userCredentials)
        .where(eq(userCredentials.userId, matchedUser.id))
        .limit(1);

      if (!existingCred) {
        report.created.credentials++;
        if (!hasUsablePassword) {
          report.needsReset++;
        }
      } else if (existingCred.mustReset) {
        if (hasUsablePassword) {
          report.created.credentials++;
        } else {
          report.needsReset++;
        }
      }
    }
  }

  return report;
}

