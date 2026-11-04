import { eq } from "drizzle-orm";
import { schema, scopedTo, type Db } from "@skout/db";
import { CRM_SYNC_OWNED_FIELDS } from "@skout/shared";
import { isProtectedField } from "./crm-conflict.service.js";

const { crmConnections, auditLogs } = schema;

/** Earlier mapping versions kept on the connection, newest first. */
const MAPPING_HISTORY_LIMIT = 20;

export type CrmSyncDirection = "inbound" | "outbound" | "bidirectional";
export type CrmTransformType = "none" | "trim" | "lowercase" | "uppercase" | "number";
const DIRECTIONS: readonly CrmSyncDirection[] = ["inbound", "outbound", "bidirectional"];
const TRANSFORMS: readonly CrmTransformType[] = ["none", "trim", "lowercase", "uppercase", "number"];
const NULL_BEHAVIORS: readonly CrmNullBehavior[] = ["preserve", "ignore", "overwrite"];
const CONFLICT_POLICIES: readonly CrmConflictPolicy[] = ["skout_wins", "external_wins", "most_recent", "manual_review"];
/** A blank provider value: "overwrite" clears the Skout field; "preserve" and "ignore" keep it. */
export type CrmNullBehavior = "preserve" | "ignore" | "overwrite";
export type CrmConflictPolicy = "skout_wins" | "external_wins" | "most_recent" | "manual_review";

export interface CrmFieldMapping {
  id: string;
  internalField: string;
  externalField: string;
  direction: CrmSyncDirection;
  transform?: CrmTransformType;
  nullBehavior?: CrmNullBehavior;
  conflictPolicy?: CrmConflictPolicy;
  isProtected?: boolean;
}

export interface CrmObjectMapping {
  version: number;
  entityType: "contact" | "deal";
  externalObjectType: string;
  fields: CrmFieldMapping[];
  lastValidatedAt?: string;
  schemaVersion?: string;
}

export interface CrmConnectorMappings {
  version: number;
  provider: string;
  mappings: {
    contact: CrmObjectMapping;
    deal: CrmObjectMapping;
  };
}

export const DEFAULT_HUBSPOT_CONTACT_MAPPING: CrmObjectMapping = {
  version: 1,
  entityType: "contact",
  externalObjectType: "contacts",
  fields: [
    {
      id: "contact_email",
      internalField: "email",
      externalField: "email",
      direction: "bidirectional",
      transform: "lowercase",
      nullBehavior: "ignore",
      conflictPolicy: "skout_wins",
      isProtected: false,
    },
    {
      id: "contact_first_name",
      internalField: "firstName",
      externalField: "firstname",
      direction: "bidirectional",
      transform: "trim",
      nullBehavior: "ignore",
      conflictPolicy: "most_recent",
      isProtected: false,
    },
    {
      id: "contact_last_name",
      internalField: "lastName",
      externalField: "lastname",
      direction: "bidirectional",
      transform: "trim",
      nullBehavior: "ignore",
      conflictPolicy: "most_recent",
      isProtected: false,
    },
    {
      id: "contact_phone",
      internalField: "phone",
      externalField: "phone",
      direction: "bidirectional",
      transform: "trim",
      nullBehavior: "ignore",
      conflictPolicy: "most_recent",
      isProtected: false,
    },
    {
      id: "contact_title",
      internalField: "title",
      externalField: "jobtitle",
      direction: "bidirectional",
      transform: "trim",
      nullBehavior: "ignore",
      conflictPolicy: "most_recent",
      isProtected: false,
    },
  ],
};

export const DEFAULT_HUBSPOT_DEAL_MAPPING: CrmObjectMapping = {
  version: 1,
  entityType: "deal",
  externalObjectType: "deals",
  fields: [
    {
      id: "deal_name",
      internalField: "name",
      externalField: "dealname",
      direction: "bidirectional",
      transform: "trim",
      nullBehavior: "ignore",
      conflictPolicy: "most_recent",
      isProtected: false,
    },
    {
      id: "deal_amount",
      internalField: "amount",
      externalField: "amount",
      direction: "bidirectional",
      transform: "number",
      nullBehavior: "ignore",
      conflictPolicy: "manual_review",
      isProtected: false,
    },
    // No stage mapping: HubSpot's dealstage is a HubSpot stage id, Skout's stageId a uuid of its
    // own pipeline; mapping one to the other needs a stage lookup table (open question for COPS-09).
  ],
};

export function getDefaultCrmMappings(provider: string): CrmConnectorMappings {
  const p = provider.toLowerCase();
  if (p === "hubspot") {
    return {
      version: 1,
      provider: "hubspot",
      mappings: {
        contact: DEFAULT_HUBSPOT_CONTACT_MAPPING,
        deal: DEFAULT_HUBSPOT_DEAL_MAPPING,
      },
    };
  }
  // Generic fallback
  return {
    version: 1,
    provider: p,
    mappings: {
      contact: { ...DEFAULT_HUBSPOT_CONTACT_MAPPING },
      deal: { ...DEFAULT_HUBSPOT_DEAL_MAPPING },
    },
  };
}

export function transformValue(value: unknown, transform?: CrmTransformType): unknown {
  if (value == null) return null;
  const str = String(value);

  switch (transform) {
    case "trim":
      return str.trim();
    case "lowercase":
      return str.trim().toLowerCase();
    case "uppercase":
      return str.trim().toUpperCase();
    case "number": {
      const num = Number(str.replace(/[^0-9.-]/g, ""));
      return Number.isFinite(num) ? num : value;
    }
    case "none":
    default:
      return value;
  }
}

export interface InboundMappingResult {
  patch: Record<string, unknown>;
  appliedFields: string[];
  skippedFields: string[];
}

export function applyInboundMapping(
  mapping: CrmObjectMapping,
  externalProperties: Record<string, unknown>
): InboundMappingResult {
  const patch: Record<string, unknown> = {};
  const appliedFields: string[] = [];
  const skippedFields: string[] = [];

  for (const field of mapping.fields) {
    if (field.direction !== "inbound" && field.direction !== "bidirectional") {
      skippedFields.push(field.internalField);
      continue;
    }

    const rawValue = externalProperties[field.externalField];
    const isBlank = rawValue == null || (typeof rawValue === "string" && rawValue.trim() === "");

    if (isBlank) {
      if (field.nullBehavior === "overwrite") {
        patch[field.internalField] = null;
        appliedFields.push(field.internalField);
      } else {
        // "preserve" and "ignore" (the default) keep the Skout value.
        skippedFields.push(field.internalField);
      }
      continue;
    }

    patch[field.internalField] = transformValue(rawValue, field.transform);
    appliedFields.push(field.internalField);
  }

  return { patch, appliedFields, skippedFields };
}

export interface OutboundMappingResult {
  properties: Record<string, string>;
  appliedFields: string[];
  skippedFields: string[];
}

export function applyOutboundMapping(
  mapping: CrmObjectMapping,
  internalPatch: Record<string, unknown>
): OutboundMappingResult {
  const properties: Record<string, string> = {};
  const appliedFields: string[] = [];
  const skippedFields: string[] = [];

  for (const field of mapping.fields) {
    if (field.direction !== "outbound" && field.direction !== "bidirectional") {
      skippedFields.push(field.externalField);
      continue;
    }

    if (!(field.internalField in internalPatch)) {
      continue;
    }

    const rawValue = internalPatch[field.internalField];
    const isBlank = rawValue == null || (typeof rawValue === "string" && rawValue.trim() === "");

    if (isBlank) {
      if (field.nullBehavior === "overwrite") {
        properties[field.externalField] = "";
        appliedFields.push(field.externalField);
      } else {
        skippedFields.push(field.externalField);
      }
      continue;
    }

    const transformed = transformValue(rawValue, field.transform);
    properties[field.externalField] = String(transformed);
    appliedFields.push(field.externalField);
  }

  return { properties, appliedFields, skippedFields };
}

export interface MappingValidationResult {
  valid: boolean;
  errors: string[];
  missingExternalProperties: string[];
}

export function validateMapping(
  mapping: CrmObjectMapping,
  availableExternalProperties?: string[],
  expectedEntityType?: "contact" | "deal"
): MappingValidationResult {
  const errors: string[] = [];
  const missingExternalProperties: string[] = [];

  if (!mapping.version || mapping.version < 1) {
    errors.push("Mapping version must be a positive integer");
  }

  if (!mapping.entityType || !["contact", "deal"].includes(mapping.entityType)) {
    errors.push(`Invalid entityType: ${mapping.entityType}`);
  } else if (expectedEntityType && mapping.entityType !== expectedEntityType) {
    errors.push(`Mapping entityType ${mapping.entityType} does not match ${expectedEntityType}`);
  }
  // Only fields the CRM sync owns can be mapped: a mapping must never write ids, workspace or
  // system-derived fields.
  const allowed: readonly string[] =
    mapping.entityType === "contact" || mapping.entityType === "deal" ? CRM_SYNC_OWNED_FIELDS[mapping.entityType] : [];

  if (!Array.isArray(mapping.fields) || mapping.fields.length === 0) {
    errors.push("Mapping must define at least one field mapping");
  } else {
    const internalFieldsSeen = new Set<string>();
    for (const field of mapping.fields) {
      if (!field.internalField) {
        errors.push(`Field mapping ${field.id || "unknown"} is missing internalField`);
      } else {
        if (internalFieldsSeen.has(field.internalField)) {
          errors.push(`Duplicate mapping for internalField: ${field.internalField}`);
        }
        internalFieldsSeen.add(field.internalField);
        if (isProtectedField(field.internalField) || !allowed.includes(field.internalField)) {
          errors.push(`internalField ${field.internalField} cannot be synced (allowed: ${allowed.join(", ")})`);
        }
      }

      if (!DIRECTIONS.includes(field.direction)) {
        errors.push(`Field ${field.internalField}: invalid direction ${field.direction}`);
      }
      if (field.transform !== undefined && !TRANSFORMS.includes(field.transform)) {
        errors.push(`Field ${field.internalField}: invalid transform ${field.transform}`);
      }
      if (field.nullBehavior !== undefined && !NULL_BEHAVIORS.includes(field.nullBehavior)) {
        errors.push(`Field ${field.internalField}: invalid nullBehavior ${field.nullBehavior}`);
      }
      if (field.conflictPolicy !== undefined && !CONFLICT_POLICIES.includes(field.conflictPolicy)) {
        errors.push(`Field ${field.internalField}: invalid conflictPolicy ${field.conflictPolicy}`);
      }

      if (!field.externalField) {
        errors.push(`Field mapping ${field.id || "unknown"} is missing externalField`);
      }

      if (availableExternalProperties && availableExternalProperties.length > 0) {
        if (!availableExternalProperties.map((p) => p.toLowerCase()).includes(String(field.externalField).toLowerCase())) {
          missingExternalProperties.push(field.externalField);
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    missingExternalProperties,
  };
}

export interface TestMappingResult {
  direction: "inbound" | "outbound";
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  appliedFields: string[];
  skippedFields: string[];
  warnings: string[];
}

export function testMappingTransformation(
  mapping: CrmObjectMapping,
  sampleData: Record<string, unknown>,
  direction: "inbound" | "outbound"
): TestMappingResult {
  const warnings: string[] = [];

  if (direction === "inbound") {
    const { patch, appliedFields, skippedFields } = applyInboundMapping(mapping, sampleData);
    return {
      direction,
      input: sampleData,
      output: patch,
      appliedFields,
      skippedFields,
      warnings,
    };
  } else {
    const { properties, appliedFields, skippedFields } = applyOutboundMapping(mapping, sampleData);
    return {
      direction,
      input: sampleData,
      output: properties,
      appliedFields,
      skippedFields,
      warnings,
    };
  }
}

export async function getResolvedCrmMapping(
  db: Db,
  workspaceId: string,
  provider: string,
  entityType: "contact" | "deal"
): Promise<CrmObjectMapping> {
  const [row] = await db
    .select({ settings: crmConnections.settings })
    .from(crmConnections)
    .where(scopedTo(crmConnections, workspaceId, eq(crmConnections.provider, provider)))
    .limit(1);

  const settings = (row?.settings ?? {}) as Record<string, any>;
  const customMapping = settings?.mappings?.[entityType] as CrmObjectMapping | undefined;
  if (customMapping && Array.isArray(customMapping.fields) && customMapping.fields.length > 0) {
    return customMapping;
  }

  const defaults = getDefaultCrmMappings(provider);
  return defaults.mappings[entityType];
}

export interface CrmMappingHistoryEntry {
  version: number;
  replacedAt: string;
  mapping: CrmObjectMapping;
}

/**
 * Saves new mappings as a new version: the version number is one above the current one (the
 * client's number is ignored), the replaced mapping is kept in settings.mappingHistory (newest
 * first, last MAPPING_HISTORY_LIMIT), and the change is audited. Runs in a transaction with the
 * connection row locked, so two saves cannot both read the same version.
 */
export async function saveCrmMappings(
  db: Db,
  workspaceId: string,
  provider: string,
  mappings: { contact?: CrmObjectMapping; deal?: CrmObjectMapping },
  actorId?: string | null
): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: crmConnections.id, settings: crmConnections.settings })
      .from(crmConnections)
      .where(scopedTo(crmConnections, workspaceId, eq(crmConnections.provider, provider)))
      .for("update")
      .limit(1);

    if (!row) {
      throw new Error(`CRM connection for provider ${provider} not found`);
    }

    const settings = (row.settings ?? {}) as Record<string, any>;
    const current: Record<string, CrmObjectMapping | undefined> = { ...(settings.mappings ?? {}) };
    const history: Record<string, CrmMappingHistoryEntry[]> = { ...(settings.mappingHistory ?? {}) };
    const now = new Date().toISOString();
    const changes: Array<{ entityType: string; from: number; to: number }> = [];

    for (const entityType of ["contact", "deal"] as const) {
      const next = mappings[entityType];
      if (!next) continue;
      const previous = current[entityType] ?? getDefaultCrmMappings(provider).mappings[entityType];
      const version = (previous?.version ?? 0) + 1;
      current[entityType] = { ...next, entityType, version, lastValidatedAt: now };
      history[entityType] = [{ version: previous.version, replacedAt: now, mapping: previous }, ...(history[entityType] ?? [])].slice(
        0,
        MAPPING_HISTORY_LIMIT
      );
      changes.push({ entityType, from: previous.version, to: version });
    }
    if (changes.length === 0) return;

    await tx
      .update(crmConnections)
      .set({ settings: { ...settings, mappings: current, mappingHistory: history }, updatedAt: new Date() })
      .where(eq(crmConnections.id, row.id));

    await tx.insert(auditLogs).values({
      workspaceId,
      actorType: actorId ? "user" : "system",
      actorId: actorId ?? null,
      action: "crm_mapping.updated",
      entityType: "crm_connection",
      entityId: row.id,
      beforeState: Object.fromEntries(changes.map((c) => [c.entityType, { version: c.from }])),
      afterState: Object.fromEntries(changes.map((c) => [c.entityType, current[c.entityType]])),
      reason: `CRM field mappings updated (${changes.map((c) => `${c.entityType} v${c.to}`).join(", ")})`,
    });
  });
}

/** Earlier versions of one entity's mapping, newest first. */
export async function getCrmMappingHistory(
  db: Db,
  workspaceId: string,
  provider: string,
  entityType: "contact" | "deal"
): Promise<CrmMappingHistoryEntry[]> {
  const [row] = await db
    .select({ settings: crmConnections.settings })
    .from(crmConnections)
    .where(scopedTo(crmConnections, workspaceId, eq(crmConnections.provider, provider)))
    .limit(1);
  const settings = (row?.settings ?? {}) as Record<string, any>;
  const list = settings.mappingHistory?.[entityType];
  return Array.isArray(list) ? (list as CrmMappingHistoryEntry[]) : [];
}
