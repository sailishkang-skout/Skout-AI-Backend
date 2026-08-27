import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { HttpError } from "../utils/http.js";
import type { AutomationGraph } from "./automation-graph.js";

const { automations, automationVersions } = schema;

export class AutomationService {
  constructor(private readonly db: Db) {}

  async createAutomation(workspaceId: string, input: { name: string; description?: string; createdBy?: string }) {
    const [row] = await this.db
      .insert(automations)
      .values({
        workspaceId,
        name: input.name,
        description: input.description ?? null,
        createdBy: input.createdBy ?? null,
      })
      .returning();
    return row!;
  }

  async listAutomations(workspaceId: string) {
    return this.db.select().from(automations).where(eq(automations.workspaceId, workspaceId)).orderBy(desc(automations.createdAt));
  }

  async getAutomation(workspaceId: string, automationId: string) {
    const [row] = await this.db
      .select()
      .from(automations)
      .where(and(eq(automations.id, automationId), eq(automations.workspaceId, workspaceId)))
      .limit(1);
    if (!row) throw new HttpError("automation_not_found", 404);
    return row;
  }

  async updateAutomation(workspaceId: string, automationId: string, patch: { name?: string; description?: string }) {
    await this.getAutomation(workspaceId, automationId); // 404s if not found/wrong workspace
    const [row] = await this.db
      .update(automations)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(automations.id, automationId))
      .returning();
    return row!;
  }

  /** Upserts the single draft version for an automation (version 0 — never published). */
  async saveDraftVersion(workspaceId: string, automationId: string, graph: AutomationGraph) {
    await this.getAutomation(workspaceId, automationId); // 404s if not found/wrong workspace

    const [existingDraft] = await this.db
      .select()
      .from(automationVersions)
      .where(and(eq(automationVersions.automationId, automationId), eq(automationVersions.status, "draft")))
      .limit(1);

    if (existingDraft) {
      const [updated] = await this.db
        .update(automationVersions)
        .set({ graph })
        .where(eq(automationVersions.id, existingDraft.id))
        .returning();
      return updated!;
    }

    const [created] = await this.db
      .insert(automationVersions)
      .values({ automationId, version: 0, graph, status: "draft" })
      .returning();
    return created!;
  }

  /**
   * Snapshots the current draft graph as a new immutable published version — same pattern as
   * sequence.service.ts's publishVersion(). In-flight runs keep whatever version they started on.
   */
  async publishVersion(workspaceId: string, automationId: string, graph: AutomationGraph, publishedBy?: string) {
    const auto = await this.getAutomation(workspaceId, automationId);
    const nextVersion = auto.currentVersion + 1;

    const [version] = await this.db
      .insert(automationVersions)
      .values({
        automationId,
        version: nextVersion,
        graph,
        status: "published",
        publishedAt: new Date(),
        publishedBy: publishedBy ?? null,
      })
      .returning();

    await this.db
      .update(automations)
      .set({ currentVersion: nextVersion, status: "active", updatedAt: new Date() })
      .where(eq(automations.id, automationId));

    return version!;
  }

  async getVersion(workspaceId: string, automationId: string, version: number) {
    await this.getAutomation(workspaceId, automationId);
    const [row] = await this.db
      .select()
      .from(automationVersions)
      .where(and(eq(automationVersions.automationId, automationId), eq(automationVersions.version, version)))
      .limit(1);
    if (!row) throw new HttpError("automation_version_not_found", 404);
    return row;
  }

  /** The single draft row (version 0) — used to simulate the in-progress graph before it's published. */
  async getDraftVersion(automationId: string) {
    const [row] = await this.db
      .select()
      .from(automationVersions)
      .where(and(eq(automationVersions.automationId, automationId), eq(automationVersions.status, "draft")))
      .limit(1);
    return row ?? null;
  }

  async getLatestPublishedVersion(automationId: string) {
    const [row] = await this.db
      .select()
      .from(automationVersions)
      .where(and(eq(automationVersions.automationId, automationId), eq(automationVersions.status, "published")))
      .orderBy(desc(automationVersions.version))
      .limit(1);
    return row ?? null;
  }

  async listVersions(workspaceId: string, automationId: string) {
    await this.getAutomation(workspaceId, automationId);
    return this.db.select().from(automationVersions).where(eq(automationVersions.automationId, automationId)).orderBy(desc(automationVersions.version));
  }
}
