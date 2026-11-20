import { sql } from "drizzle-orm";
import { boolean, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";
import { companies } from "./crm.js";

/**
 * Latest Job Roles: the job listings captured for a company (by the extension today). One row per
 * job, found again and again by `job_key` (the LinkedIn job id, else the normalised title and
 * location), so repeated scans and retries never duplicate a role. A job missing from later scans
 * is only marked `not_seen`: it is never closed because it was absent.
 */
export const companyJobRoles = pgTable(
  "company_job_roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull(),
    /** `id:<linkedin job id>` or `text:<hash of normalised title|location>`. */
    jobKey: text("job_key").notNull(),
    externalJobId: text("external_job_id"),
    title: text("title").notNull(),
    companyName: text("company_name"),
    department: text("department"),
    location: text("location"),
    country: text("country"),
    employmentType: text("employment_type"),
    /** remote | hybrid | on_site, only when LinkedIn shows it. */
    workplaceType: text("workplace_type"),
    description: text("description"),
    requirements: text("requirements"),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    /** The posting age as LinkedIn wrote it ("3 days ago"), kept when no exact date is shown. */
    postedText: text("posted_text"),
    jobUrl: text("job_url"),
    source: text("source").notNull().default("linkedin_extension"),
    /** open: seen in the latest verified scan | not_seen: missed by later verified scans. Never "closed". */
    status: text("status").notNull().default("open"),
    missedScans: integer("missed_scans").notNull().default(0),
    /** The detail page (description, requirements) was read, not only the card. */
    detailsComplete: boolean("details_complete").notNull().default(false),
    firstDetectedAt: timestamp("first_detected_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    /** When the role's content last changed after it was first detected. */
    changedAt: timestamp("changed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("company_job_roles_company_key_unique_idx").on(table.workspaceId, table.companyId, table.jobKey),
    foreignKey({
      name: "company_job_roles_company_workspace_fk",
      columns: [table.workspaceId, table.companyId],
      foreignColumns: [companies.workspaceId, companies.id],
    }).onDelete("cascade"),
    index("company_job_roles_company_detected_idx").on(table.workspaceId, table.companyId, table.firstDetectedAt),
  ]
);

/**
 * One row per scan of a company's job listings, and per rescan request from the workspace
 * (`requested`, picked up by the extension). The status says what the scan can be trusted for.
 */
export const companyJobScans = pgTable(
  "company_job_scans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull(),
    /** requested | in_progress | completed_verified | verification_required | partial | not_found | restricted | not_loaded | failed */
    status: text("status").notNull().default("requested"),
    /** Names one scan so that sending it again (a lost response) records it once. */
    clientScanId: text("client_scan_id"),
    source: text("source"),
    passes: integer("passes").notNull().default(0),
    jobsFound: integer("jobs_found").notNull().default(0),
    jobsNew: integer("jobs_new").notNull().default(0),
    jobsUpdated: integer("jobs_updated").notNull().default(0),
    verified: boolean("verified").notNull().default(false),
    /** Per-pass detail and notes (what was loaded, what was not), shown in the workspace. */
    details: jsonb("details").notNull().default({}),
    error: text("error"),
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    requestedAt: timestamp("requested_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "company_job_scans_company_workspace_fk",
      columns: [table.workspaceId, table.companyId],
      foreignColumns: [companies.workspaceId, companies.id],
    }).onDelete("cascade"),
    index("company_job_scans_company_created_idx").on(table.workspaceId, table.companyId, table.createdAt),
    uniqueIndex("company_job_scans_client_scan_unique_idx")
      .on(table.workspaceId, table.companyId, table.clientScanId)
      .where(sql`${table.clientScanId} IS NOT NULL`),
  ]
);
