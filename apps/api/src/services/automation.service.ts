import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedById, scopedTo } from "@skout/db";
import { HttpError } from "../utils/http.js";
import { writeCopsAudit } from "./cops-platform.service.js";
import type { AutomationGraph } from "./automation-graph.js";
import { validateAutomationGraph } from "./automation-graph-validate.js";

const { automations, automationVersions, auditLogs } = schema;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

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
    return this.db.select().from(automations).where(scopedTo(automations, workspaceId)).orderBy(desc(automations.createdAt));
  }

  async getAutomation(workspaceId: string, automationId: string) {
    const [row] = await this.db
      .select()
      .from(automations)
      .where(scopedById(automations, workspaceId, automationId))
      .limit(1);
    if (!row) throw new HttpError("automation_not_found", 404);
    return row;
  }

  async updateAutomation(workspaceId: string, automationId: string, patch: { name?: string; description?: string }) {
    await this.getAutomation(workspaceId, automationId); // 404s if not found/wrong workspace
    const [row] = await this.db
      .update(automations)
      .set({ ...patch, updatedAt: new Date() })
      .where(scopedById(automations, workspaceId, automationId))
      .returning();
    return row!;
  }

  /**
   * Turns a published automation on ("active") or off ("paused"). Only active automations start
   * new runs; runs already in flight keep going. Turning on needs a published version.
   */
  async setStatus(workspaceId: string, automationId: string, status: "active" | "paused", actor: { userId: string | null; correlationId: string }) {
    const before = await this.getAutomation(workspaceId, automationId);
    if (before.status === status) return before;
    if (status === "active" && before.currentVersion < 1) throw new HttpError("automation_not_published", 409);
    if (before.status === "archived") throw new HttpError("automation_archived", 409);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(automations)
        .set({ status, updatedAt: new Date() })
        .where(scopedById(automations, workspaceId, automationId))
        .returning();
      await writeCopsAudit(tx, {
        tenantId: workspaceId,
        actor: { type: "user", id: actor.userId },
        entityType: "automation",
        entityId: automationId,
        action: status === "active" ? "automation.activated" : "automation.paused",
        before: { status: before.status },
        after: { status },
        correlationId: actor.correlationId,
        sourceChannel: "api",
      });
      return row!;
    });
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
   * The automation row is locked so two publishes cannot take the same version number.
   */
  async publishVersion(workspaceId: string, automationId: string, graph: AutomationGraph, publishedBy?: string) {
    return this.db.transaction(async (tx) => {
      const auto = await this.lockAutomation(tx, workspaceId, automationId);
      return this.insertPublished(tx, workspaceId, auto.id, auto.currentVersion + 1, graph, publishedBy);
    });
  }

  /**
   * COPS-10 rollback: publishes version `version`'s graph again as the next version, so new runs
   * use it. Runs already in flight are pinned to their own version id and are not touched. The
   * draft is reset to that graph too, so the builder shows what is live. Audited.
   */
  async rollbackToVersion(workspaceId: string, automationId: string, version: number, actorId?: string) {
    return this.db.transaction(async (tx) => {
      const auto = await this.lockAutomation(tx, workspaceId, automationId);
      const [target] = await tx
        .select()
        .from(automationVersions)
        .where(and(eq(automationVersions.automationId, automationId), eq(automationVersions.version, version), eq(automationVersions.status, "published")))
        .limit(1);
      if (!target) throw new HttpError("automation_version_not_found", 404);
      if (version === auto.currentVersion) throw new HttpError("automation_version_already_current", 409);
      const graph = target.graph as AutomationGraph;
      const issues = validateAutomationGraph(graph, { strict: true });
      if (issues.length) throw new HttpError("automation_graph_invalid", 422, { issues });

      const created = await this.insertPublished(tx, workspaceId, automationId, auto.currentVersion + 1, graph, actorId);
      await tx
        .update(automationVersions)
        .set({ graph })
        .where(and(eq(automationVersions.automationId, automationId), eq(automationVersions.status, "draft")));
      await tx.insert(auditLogs).values({
        workspaceId,
        actorType: actorId ? "user" : "system",
        actorId: actorId ?? null,
        action: "automation.rolled_back",
        entityType: "automation",
        entityId: automationId,
        beforeState: { version: auto.currentVersion },
        afterState: { version: created.version, restoredFrom: version },
        reason: `Workflow rolled back to v${version} (published as v${created.version})`,
      });
      return { ...created, restoredFrom: version };
    });
  }

  private async lockAutomation(tx: Tx, workspaceId: string, automationId: string) {
    const [auto] = await tx.select().from(automations).where(scopedById(automations, workspaceId, automationId)).for("update").limit(1);
    if (!auto) throw new HttpError("automation_not_found", 404);
    return auto;
  }

  private async insertPublished(tx: Tx, workspaceId: string, automationId: string, nextVersion: number, graph: AutomationGraph, publishedBy?: string) {
    const [version] = await tx
      .insert(automationVersions)
      .values({ automationId, version: nextVersion, graph, status: "published", publishedAt: new Date(), publishedBy: publishedBy ?? null })
      .returning();
    await tx
      .update(automations)
      .set({ currentVersion: nextVersion, status: "active", updatedAt: new Date() })
      .where(scopedById(automations, workspaceId, automationId));
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
