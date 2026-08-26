import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { eq, and } from "drizzle-orm";
import type { Env } from "../config/env.js";
import { buildEnrichmentService, type ProspectSnapshot } from "./enrichment/index.js";
import { buildListService } from "./list.service.js";
import { openSearchConfigFromEnv } from "../lib/opensearch-config.js";
import { HttpError } from "../utils/http.js";

export const DEMO_LIST_NAME = "Demo: Sample Prospects";

/**
 * R8.1 — "never a blank dashboard." Opt-in only (never runs automatically for a real
 * workspace): seeds one list with a handful of obviously-fake prospects so a new workspace
 * has something to look at. Uses example.com/.org/.net — the IANA-reserved documentation
 * domains (RFC 2606) that can never resolve to a real mailbox — so even an accidental
 * sequence enrollment against this data can't reach a real person.
 */
const DEMO_PROSPECTS: ProspectSnapshot[] = [
  {
    companyDomain: "example.com",
    companyName: "Example Corp (demo)",
    fullName: "Alex Demo",
    title: "VP Sales",
    seniority: "vp",
    industry: "SaaS",
    country: "US",
    employeeCount: 120,
  },
  {
    companyDomain: "example.org",
    companyName: "Sample Org (demo)",
    fullName: "Jordan Sample",
    title: "Head of Marketing",
    seniority: "head",
    industry: "Marketing",
    country: "UK",
    employeeCount: 45,
  },
  {
    companyDomain: "example.net",
    companyName: "Demo Networks (demo)",
    fullName: "Taylor Preview",
    title: "Director of RevOps",
    seniority: "director",
    industry: "Technology",
    country: "CA",
    employeeCount: 300,
  },
];

export async function seedDemoData(
  db: Db | null,
  config: Env,
  workspaceId: string
): Promise<{ listId: string; added: number; alreadySeeded: boolean }> {
  if (!db) throw new HttpError("database_unavailable", 503);

  const [existing] = await db
    .select({ id: schema.lists.id })
    .from(schema.lists)
    .where(and(eq(schema.lists.workspaceId, workspaceId), eq(schema.lists.name, DEMO_LIST_NAME)))
    .limit(1);
  if (existing) {
    return { listId: existing.id, added: 0, alreadySeeded: true };
  }

  const listSvc = buildListService(db, openSearchConfigFromEnv(config));
  if (!listSvc) throw new HttpError("list_service_unavailable", 503);
  const list = await listSvc.createList(workspaceId, DEMO_LIST_NAME);

  const enrichmentSvc = buildEnrichmentService(db, config);
  await enrichmentSvc.addListMembers(workspaceId, list.id, DEMO_PROSPECTS);

  return { listId: list.id, added: DEMO_PROSPECTS.length, alreadySeeded: false };
}
