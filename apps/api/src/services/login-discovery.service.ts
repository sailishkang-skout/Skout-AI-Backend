/**
 * AUTH-BE-22 — login discovery for the cohort migration.
 *
 * Decides which login method the identifier-first login screen offers for an email, before the
 * user authenticates. The answer comes only from auth_login_cohorts (exact-email row beats a
 * domain row) and the environment default. It never looks at users, credentials, or identities,
 * so a known and an unknown email with the same domain get the same answer from the same single
 * query — the endpoint can't be used to check whether an account exists.
 */
import { and, eq, or } from "drizzle-orm";
import { schema } from "@skout/db";
import type { Db } from "@skout/db";

const { authLoginCohorts } = schema;

export const LOGIN_METHODS = ["clerk", "password", "google", "microsoft", "sso"] as const;
export type LoginMethod = (typeof LOGIN_METHODS)[number];

export interface CohortRow {
  subjectType: string;
  method: string;
}

function isLoginMethod(value: string): value is LoginMethod {
  return (LOGIN_METHODS as readonly string[]).includes(value);
}

/** Trimmed, lowercased email plus its domain (text after the last "@"). */
export function splitEmail(email: string): { email: string; domain: string } {
  const normalized = email.trim().toLowerCase();
  return { email: normalized, domain: normalized.slice(normalized.lastIndexOf("@") + 1) };
}

/** Pure resolution: an exact-email row wins over a domain row; otherwise the default. Rows with
 *  an unrecognized method are ignored (the table's CHECK constraint should prevent them). */
export function pickLoginMethod(rows: CohortRow[], defaultMethod: LoginMethod): LoginMethod {
  const byType = (type: string) => rows.find((r) => r.subjectType === type && isLoginMethod(r.method));
  const match = byType("email") ?? byType("domain");
  return match ? (match.method as LoginMethod) : defaultMethod;
}

export async function fetchCohortRows(db: Db, email: string, domain: string): Promise<CohortRow[]> {
  return db
    .select({ subjectType: authLoginCohorts.subjectType, method: authLoginCohorts.method })
    .from(authLoginCohorts)
    .where(
      or(
        and(eq(authLoginCohorts.subjectType, "email"), eq(authLoginCohorts.subject, email)),
        and(eq(authLoginCohorts.subjectType, "domain"), eq(authLoginCohorts.subject, domain))
      )
    );
}
