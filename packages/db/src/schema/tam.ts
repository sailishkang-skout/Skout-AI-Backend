import { integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";

/**
 * R12.1/R12.2 — a saved, named, re-computable account universe generated from the workspace
 * ICP (or a custom filter override), distinct from a one-off search result set. `totalCount`
 * and `segmentBreakdown` come from the corpus (OpenSearch) at compute time; `coverage` is the
 * activation/enrichment/contact/reply/deal funnel, computed from Postgres workspace data —
 * both recomputed together on every `recompute` call.
 */
export const tams = pgTable("tams", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** Null = use the current workspace_icp.config at compute time. Non-null = a saved override. */
  filterConfig: jsonb("filter_config"),
  totalCount: integer("total_count").notNull().default(0),
  /** [{ dimension: "industry"|"size"|"geo", value: string, count: number }] */
  segmentBreakdown: jsonb("segment_breakdown").notNull().default([]),
  /** { total, activated, enriched, contacted, replied, deal } */
  coverage: jsonb("coverage").notNull().default({}),
  /** 8.2 Ask — "disclose provider/licensing data-coverage limits inline". "opensearch" (live
   * corpus index) | "demo_corpus" (local synthetic corpus, no index configured) — which source
   * totalCount/segmentBreakdown actually came from at last compute. Null for rows computed
   * before this column existed. */
  dataSource: text("data_source"),
  lastComputedAt: timestamp("last_computed_at", { withTimezone: true }),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
