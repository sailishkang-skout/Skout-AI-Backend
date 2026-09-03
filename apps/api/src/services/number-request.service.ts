import { desc, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedById, scopedTo } from "@skout/db";
import type { Env } from "../config/env.js";
import { HttpError } from "../utils/http.js";
import {
  defaultTelnyxNumbersClient,
  isTelnyxNumbersConfigured,
  type TelnyxNumbersClient,
  type TelnyxRequirement,
} from "./telnyx-numbers.client.js";

const { numberRequests, numberRequestEvents, tenantWorkspaces } = schema;

export const NUMBER_REQUEST_STATUSES = [
  "requested",
  "selected",
  "requirements_pending",
  "compliance_submitted",
  "compliance_review",
  "ordering",
  "provisioning",
  "active",
  "failed",
  "expired",
  "cancelled",
] as const;

export type NumberRequestStatus = (typeof NUMBER_REQUEST_STATUSES)[number];

export const NUMBER_REQUEST_TRANSITIONS: Record<NumberRequestStatus, NumberRequestStatus[]> = {
  requested: ["selected", "cancelled", "expired"],
  selected: ["requirements_pending", "ordering", "cancelled", "expired"],
  requirements_pending: ["compliance_submitted", "cancelled", "expired"],
  compliance_submitted: ["compliance_review", "cancelled"],
  compliance_review: ["ordering", "requirements_pending", "failed", "cancelled"],
  ordering: ["provisioning", "failed", "cancelled"],
  provisioning: ["active", "failed"],
  active: [],
  failed: [],
  expired: [],
  cancelled: [],
};

const TERMINAL: NumberRequestStatus[] = ["active", "failed", "expired", "cancelled"];

export type NumberRequestDto = {
  id: string;
  tenantId: string | null;
  workspaceId: string;
  requestedBy: string | null;
  country: string;
  region: string | null;
  city: string | null;
  areaCode: string | null;
  numberType: string;
  quantity: number;
  requestedCapabilities: unknown;
  selectedProvider: string;
  providerSearchId: string | null;
    providerOrderId: string | null;
    providerNumberId: string | null;
    providerRequirementGroupId: string | null;
    phoneNumber: string | null;
  status: string;
  complianceStatus: string;
  requirementSnapshot: unknown;
  requiredDocuments: unknown;
  submittedDocumentVersions: unknown;
  rejectionReason: string | null;
  failureReason: string | null;
  assignedWorkspaceId: string | null;
  assignedToUserId: string | null;
  idempotencyKey: string | null;
  auditCorrelationId: string;
  selectedAt: string | null;
  complianceSubmittedAt: string | null;
  orderedAt: string | null;
  activatedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type NumberRequestRow = typeof numberRequests.$inferSelect;

function toDto(row: NumberRequestRow): NumberRequestDto {
  return {
    id: row.id,
    tenantId: row.tenantId,
    workspaceId: row.workspaceId,
    requestedBy: row.requestedBy,
    country: row.country,
    region: row.region,
    city: row.city,
    areaCode: row.areaCode,
    numberType: row.numberType,
    quantity: row.quantity,
    requestedCapabilities: row.requestedCapabilities,
    selectedProvider: row.selectedProvider,
    providerSearchId: row.providerSearchId,
    providerOrderId: row.providerOrderId,
    providerNumberId: row.providerNumberId,
    providerRequirementGroupId: row.providerRequirementGroupId,
    phoneNumber: row.phoneNumber,
    status: row.status,
    complianceStatus: row.complianceStatus,
    requirementSnapshot: row.requirementSnapshot,
    requiredDocuments: row.requiredDocuments,
    submittedDocumentVersions: row.submittedDocumentVersions,
    rejectionReason: row.rejectionReason,
    failureReason: row.failureReason,
    assignedWorkspaceId: row.assignedWorkspaceId,
    assignedToUserId: row.assignedToUserId,
    idempotencyKey: row.idempotencyKey,
    auditCorrelationId: row.auditCorrelationId,
    selectedAt: row.selectedAt?.toISOString() ?? null,
    complianceSubmittedAt: row.complianceSubmittedAt?.toISOString() ?? null,
    orderedAt: row.orderedAt?.toISOString() ?? null,
    activatedAt: row.activatedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function canTransition(from: NumberRequestStatus, to: NumberRequestStatus): boolean {
  return NUMBER_REQUEST_TRANSITIONS[from]?.includes(to) ?? false;
}

function asStatus(value: string): NumberRequestStatus {
  if ((NUMBER_REQUEST_STATUSES as readonly string[]).includes(value)) {
    return value as NumberRequestStatus;
  }
  throw new HttpError(`Unknown number request status: ${value}`, 500);
}

export type CreateNumberRequestInput = {
  country: string;
  region?: string;
  city?: string;
  areaCode?: string;
  numberType?: string;
  quantity?: number;
  requestedCapabilities?: string[];
  phoneNumber?: string;
  idempotencyKey?: string;
};

export type ComplianceDocumentInput = {
  requirementId?: string;
  telnyxDocumentId?: string;
  filename?: string;
  contentType?: string;
  contentBase64?: string;
  note?: string;
};

const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;

/** Workspace marketplace DID wins over the platform TELNYX_PHONE_NUMBER fallback. */
export function pickWorkspaceCallerId(
  activePhoneNumbers: Array<string | null | undefined>,
  envFallback?: string | null
): string | null {
  const assigned = activePhoneNumbers.find((n) => typeof n === "string" && n.trim().length > 0);
  if (assigned) return assigned.trim();
  const fallback = envFallback?.trim();
  return fallback || null;
}

export async function resolveWorkspaceCallerId(
  db: Db,
  workspaceId: string,
  envFallback?: string | null
): Promise<string | null> {
  const rows = await db
    .select({ phoneNumber: numberRequests.phoneNumber })
    .from(numberRequests)
    .where(scopedTo(numberRequests, workspaceId, eq(numberRequests.status, "active")))
    .orderBy(desc(numberRequests.activatedAt), desc(numberRequests.createdAt))
    .limit(5);
  return pickWorkspaceCallerId(
    rows.map((r) => r.phoneNumber),
    envFallback
  );
}

export class NumberRequestService {
  constructor(
    private readonly db: Db,
    private readonly config: Env,
    private readonly telnyx: TelnyxNumbersClient = defaultTelnyxNumbersClient
  ) {}

  async list(workspaceId: string): Promise<NumberRequestDto[]> {
    const rows = await this.db
      .select()
      .from(numberRequests)
      .where(scopedTo(numberRequests, workspaceId))
      .orderBy(desc(numberRequests.createdAt))
      .limit(100);
    return rows.map(toDto);
  }

  async get(workspaceId: string, id: string): Promise<NumberRequestDto> {
    return toDto(await this.load(workspaceId, id));
  }

  async create(
    workspaceId: string,
    userId: string,
    input: CreateNumberRequestInput
  ): Promise<NumberRequestDto> {
    const country = input.country.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) {
      throw new HttpError("country must be an ISO-2 code (e.g. US, GB, DE)", 400);
    }

    if (input.idempotencyKey) {
      const [existing] = await this.db
        .select()
        .from(numberRequests)
        .where(scopedTo(numberRequests, workspaceId, eq(numberRequests.idempotencyKey, input.idempotencyKey)))
        .limit(1);
      if (existing) return toDto(existing);
    }

    const [tenantRow] = await this.db
      .select({ tenantId: tenantWorkspaces.tenantId })
      .from(tenantWorkspaces)
      .where(eq(tenantWorkspaces.workspaceId, workspaceId))
      .limit(1);

    const [inserted] = await this.db
      .insert(numberRequests)
      .values({
        tenantId: tenantRow?.tenantId ?? null,
        workspaceId,
        requestedBy: userId,
        country,
        region: input.region?.trim() || null,
        city: input.city?.trim() || null,
        areaCode: input.areaCode?.trim() || null,
        numberType: input.numberType?.trim() || "local",
        quantity: input.quantity ?? 1,
        requestedCapabilities: input.requestedCapabilities?.length ? input.requestedCapabilities : ["voice"],
        phoneNumber: input.phoneNumber?.trim() || null,
        assignedWorkspaceId: workspaceId,
        idempotencyKey: input.idempotencyKey?.trim() || null,
      })
      .returning();

    if (!inserted) throw new HttpError("Failed to create number request", 500);
    await this.recordEvent(inserted, null, "requested", userId, "created");

    if (inserted.phoneNumber) {
      return this.selectNumber(workspaceId, inserted.id, userId, inserted.phoneNumber);
    }
    return toDto(inserted);
  }

  async selectNumber(
    workspaceId: string,
    id: string,
    userId: string,
    phoneNumber: string
  ): Promise<NumberRequestDto> {
    const row = await this.load(workspaceId, id);
    const next = await this.transition(row, "selected", userId, "number selected", {
      phoneNumber,
      selectedAt: new Date(),
    });

    const requirements = await this.safeRequirements(next.country, next.numberType);
    if (requirements.length === 0) {
      return toDto(
        await this.patch(next, {
          complianceStatus: "not_required",
          requirementSnapshot: [],
          requiredDocuments: [],
        })
      );
    }

    return toDto(
      await this.transition(next, "requirements_pending", userId, "regulatory requirements found", {
        complianceStatus: "pending",
        requirementSnapshot: requirements,
        requiredDocuments: requirements,
      })
    );
  }

  async uploadDocument(
    workspaceId: string,
    id: string,
    userId: string,
    input: { filename: string; contentBase64: string; requirementId?: string }
  ): Promise<NumberRequestDto> {
    if (!isTelnyxNumbersConfigured(this.config)) {
      throw new HttpError("Telnyx is not configured (TELNYX_API_KEY)", 503);
    }
    const row = await this.load(workspaceId, id);
    const status = asStatus(row.status);
    if (status !== "requirements_pending" && status !== "selected") {
      throw new HttpError(`Cannot upload documents in status ${row.status}`, 422);
    }
    const decodedBytes = Buffer.from(input.contentBase64, "base64").byteLength;
    if (decodedBytes > MAX_DOCUMENT_BYTES) {
      throw new HttpError("Document exceeds 8MB limit", 413);
    }

    const uploaded = await this.telnyx.uploadDocument(this.config, {
      filename: input.filename,
      contentBase64: input.contentBase64,
    });
    const existing = Array.isArray(row.submittedDocumentVersions) ? row.submittedDocumentVersions : [];
    const nextDocs = [
      ...existing,
      {
        telnyxDocumentId: uploaded.id,
        filename: uploaded.filename ?? input.filename,
        requirementId: input.requirementId ?? null,
        uploadedBy: userId,
        uploadedAt: new Date().toISOString(),
      },
    ];
    return toDto(await this.patch(row, { submittedDocumentVersions: nextDocs }));
  }

  async submitCompliance(
    workspaceId: string,
    id: string,
    userId: string,
    documents: ComplianceDocumentInput[]
  ): Promise<NumberRequestDto> {
    const row = await this.load(workspaceId, id);
    const uploadedNow: unknown[] = [];
    for (const doc of documents) {
      if (doc.contentBase64 && doc.filename) {
        const uploaded = await this.telnyx.uploadDocument(this.config, {
          filename: doc.filename,
          contentBase64: doc.contentBase64,
        });
        uploadedNow.push({
          telnyxDocumentId: uploaded.id,
          filename: uploaded.filename ?? doc.filename,
          requirementId: doc.requirementId ?? null,
          note: doc.note ?? null,
          uploadedBy: userId,
          uploadedAt: new Date().toISOString(),
        });
      } else {
        uploadedNow.push({
          telnyxDocumentId: doc.telnyxDocumentId ?? null,
          filename: doc.filename ?? null,
          requirementId: doc.requirementId ?? null,
          note: doc.note ?? null,
          uploadedBy: userId,
          uploadedAt: new Date().toISOString(),
        });
      }
    }

    const prior = Array.isArray(row.submittedDocumentVersions) ? row.submittedDocumentVersions : [];
    const allDocs = [...prior, ...uploadedNow];
    let requirementGroupId = row.providerRequirementGroupId;

    const fieldValues = allDocs.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const rec = entry as { requirementId?: string | null; telnyxDocumentId?: string | null };
      if (rec.requirementId && rec.telnyxDocumentId) {
        return [{ requirementId: rec.requirementId, fieldValue: rec.telnyxDocumentId }];
      }
      return [];
    });

    if (fieldValues.length > 0 && isTelnyxNumbersConfigured(this.config)) {
      if (!requirementGroupId) {
        const group = await this.telnyx.createRequirementGroup(this.config, {
          countryCode: row.country,
          phoneNumberType: row.numberType,
          customerReference: `skout:${workspaceId}:${row.id}`,
        });
        requirementGroupId = group.id;
      }
      await this.telnyx.updateRequirementGroup(this.config, requirementGroupId, fieldValues);
    }

    const submitted = await this.transition(row, "compliance_submitted", userId, "compliance documents recorded", {
      submittedDocumentVersions: allDocs,
      complianceSubmittedAt: new Date(),
      complianceStatus: "submitted",
      providerRequirementGroupId: requirementGroupId,
    });
    return toDto(await this.transition(submitted, "compliance_review", userId, "awaiting provider / ops review"));
  }

  async order(workspaceId: string, id: string, userId: string): Promise<NumberRequestDto> {
    if (!isTelnyxNumbersConfigured(this.config)) {
      throw new HttpError("Telnyx is not configured (TELNYX_API_KEY)", 503);
    }
    const row = await this.load(workspaceId, id);
    if (!row.phoneNumber) {
      throw new HttpError("Select a phone number before ordering", 400);
    }

    const status = asStatus(row.status);
    if (status === "requirements_pending") {
      throw new HttpError("Submit compliance documents before ordering this number", 422);
    }
    if (status === "requested") {
      throw new HttpError("Select a phone number before ordering", 400);
    }

    const ordering = await this.transition(row, "ordering", userId, "placing Telnyx number order");
    try {
      const order = await this.telnyx.createNumberOrder(this.config, {
        phoneNumber: ordering.phoneNumber!,
        customerReference: `skout:${workspaceId}:${ordering.id}`,
        requirementGroupId: ordering.providerRequirementGroupId ?? undefined,
      });
      const provisioning = await this.transition(ordering, "provisioning", userId, "Telnyx order created", {
        providerOrderId: order.id,
        orderedAt: new Date(),
      });
      return this.applyProviderOrder(provisioning, userId, order.status, order);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Telnyx order failed";
      await this.transition(ordering, "failed", userId, message, { failureReason: message });
      throw new HttpError(message, 502);
    }
  }

  async refresh(workspaceId: string, id: string, userId: string): Promise<NumberRequestDto> {
    const row = await this.load(workspaceId, id);
    if (!row.providerOrderId) {
      return toDto(row);
    }
    if (!isTelnyxNumbersConfigured(this.config)) {
      throw new HttpError("Telnyx is not configured (TELNYX_API_KEY)", 503);
    }
    const order = await this.telnyx.getNumberOrder(this.config, row.providerOrderId);
    return this.applyProviderOrder(row, userId, order.status, order);
  }

  async cancel(workspaceId: string, id: string, userId: string, reason?: string): Promise<NumberRequestDto> {
    const row = await this.load(workspaceId, id);
    if (TERMINAL.includes(asStatus(row.status))) {
      throw new HttpError(`Cannot cancel a request in status ${row.status}`, 422);
    }
    return toDto(
      await this.transition(row, "cancelled", userId, reason ?? "cancelled by user", {
        cancelledAt: new Date(),
      })
    );
  }

  private async applyProviderOrder(
    row: NumberRequestRow,
    userId: string,
    providerStatus: string,
    payload: unknown
  ): Promise<NumberRequestDto> {
    const normalized = providerStatus.toLowerCase();
    if (normalized === "success" || normalized === "complete") {
      const phoneId =
        payload && typeof payload === "object" && "phoneNumbers" in payload
          ? (payload as { phoneNumbers?: Array<{ id?: string }> }).phoneNumbers?.[0]?.id
          : undefined;
      return toDto(
        await this.transition(row, "active", userId, "Telnyx order succeeded", {
          providerNumberId: phoneId ?? row.providerNumberId,
          activatedAt: new Date(),
          assignedWorkspaceId: row.workspaceId,
        })
      );
    }
    if (normalized === "failure" || normalized === "failed") {
      return toDto(
        await this.transition(row, "failed", userId, "Telnyx order failed", {
          failureReason: "Telnyx number order failed",
        })
      );
    }
    return toDto(row);
  }

  private async safeRequirements(country: string, numberType: string): Promise<TelnyxRequirement[]> {
    if (!isTelnyxNumbersConfigured(this.config)) return [];
    try {
      return await this.telnyx.listNumberRequirements(this.config, {
        countryCode: country,
        phoneNumberType: numberType,
      });
    } catch {
      return [];
    }
  }

  private async load(workspaceId: string, id: string): Promise<NumberRequestRow> {
    const [row] = await this.db
      .select()
      .from(numberRequests)
      .where(scopedById(numberRequests, workspaceId, id))
      .limit(1);
    if (!row) throw new HttpError("Number request not found", 404);
    return row;
  }

  private async transition(
    row: NumberRequestRow,
    to: NumberRequestStatus,
    userId: string,
    reason: string,
    extra?: Partial<NumberRequestRow>
  ): Promise<NumberRequestRow> {
    const from = asStatus(row.status);
    if (from === to) {
      return extra ? this.patch(row, extra) : row;
    }
    if (!canTransition(from, to)) {
      throw new HttpError(`Cannot move from ${from} to ${to}`, 422);
    }
    const [updated] = await this.db
      .update(numberRequests)
      .set({
        ...extra,
        status: to,
        updatedAt: new Date(),
      })
      .where(eq(numberRequests.id, row.id))
      .returning();
    if (!updated) throw new HttpError("Failed to update number request", 500);
    await this.recordEvent(updated, from, to, userId, reason);
    return updated;
  }

  private async patch(row: NumberRequestRow, extra: Partial<NumberRequestRow>): Promise<NumberRequestRow> {
    const [updated] = await this.db
      .update(numberRequests)
      .set({ ...extra, updatedAt: new Date() })
      .where(eq(numberRequests.id, row.id))
      .returning();
    return updated ?? row;
  }

  private async recordEvent(
    row: NumberRequestRow,
    fromStatus: string | null,
    toStatus: string,
    actorUserId: string | null,
    reason: string
  ): Promise<void> {
    await this.db.insert(numberRequestEvents).values({
      requestId: row.id,
      workspaceId: row.workspaceId,
      fromStatus,
      toStatus,
      actorUserId,
      reason,
      auditCorrelationId: row.auditCorrelationId,
    });
  }
}

export function buildNumberRequestService(
  db: Db | null | undefined,
  config: Env,
  telnyx?: TelnyxNumbersClient
): NumberRequestService | null {
  if (!db) return null;
  return new NumberRequestService(db, config, telnyx);
}
