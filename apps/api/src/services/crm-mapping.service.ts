import { eq } from "drizzle-orm";
import { schema, scopedTo, type Db } from "@skout/db";

const { crmConnections } = schema;

export type CrmSyncDirection = "inbound" | "outbound" | "bidirectional";
export type CrmTransformType = "none" | "trim" | "lowercase" | "uppercase" | "split_name" | "number";
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
    {
      id: "deal_stage",
      internalField: "stageId",
      externalField: "dealstage",
      direction: "inbound",
      transform: "none",
      nullBehavior: "ignore",
      conflictPolicy: "manual_review",
      isProtected: false,
    },
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
      if (field.nullBehavior === "overwrite" || field.nullBehavior === "preserve") {
        patch[field.internalField] = null;
        appliedFields.push(field.internalField);
      } else {
        // nullBehavior === "ignore" (default)
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
  availableExternalProperties?: string[]
): MappingValidationResult {
  const errors: string[] = [];
  const missingExternalProperties: string[] = [];

  if (!mapping.version || mapping.version < 1) {
    errors.push("Mapping version must be a positive integer");
  }

  if (!mapping.entityType || !["contact", "deal"].includes(mapping.entityType)) {
    errors.push(`Invalid entityType: ${mapping.entityType}`);
  }

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
      }

      if (!field.externalField) {
        errors.push(`Field mapping ${field.id || "unknown"} is missing externalField`);
      }

      if (availableExternalProperties && availableExternalProperties.length > 0) {
        if (!availableExternalProperties.includes(field.externalField)) {
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

export async function saveCrmMappings(
  db: Db,
  workspaceId: string,
  provider: string,
  mappings: { contact?: CrmObjectMapping; deal?: CrmObjectMapping }
): Promise<void> {
  const [row] = await db
    .select({ id: crmConnections.id, settings: crmConnections.settings })
    .from(crmConnections)
    .where(scopedTo(crmConnections, workspaceId, eq(crmConnections.provider, provider)))
    .limit(1);

  if (!row) {
    throw new Error(`CRM connection for provider ${provider} not found`);
  }

  const currentSettings = (row.settings ?? {}) as Record<string, any>;
  const currentMappings = currentSettings.mappings ?? {};

  const updatedMappings = {
    ...currentMappings,
    ...(mappings.contact ? { contact: mappings.contact } : {}),
    ...(mappings.deal ? { deal: mappings.deal } : {}),
  };

  await db
    .update(crmConnections)
    .set({
      settings: {
        ...currentSettings,
        mappings: updatedMappings,
      },
      updatedAt: new Date(),
    })
    .where(eq(crmConnections.id, row.id));
}

