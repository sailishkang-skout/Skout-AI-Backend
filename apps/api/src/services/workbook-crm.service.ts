import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { WorkbookV2Error, findLiveWorkbook, type WorkbookActor } from "./workbook-v2.service.js";
import { MAX_COLUMNS } from "./workbook-v2-columns.service.js";
import { inputDataType, normalizeInputValue, type InputDataType } from "./workbook-cell-values.js";
import { namedLike, suggestMapping, type ExistingColumn } from "./workbook-import-plan.js";
import type { CsvHeader } from "./workbook-import-csv.js";
import { assertRoomForAnotherImport, getImport, type ImportDto } from "./workbook-imports.service.js";
import { CRM_PROVIDERS } from "./workbook-v2-column-config.js";
import { crmMessage, providerCode, type CrmAccess, type CrmConnectionStatus, type CrmSession } from "./workbook-crm-access.js";
import {
  CRM_OBJECTS,
  CrmSourceError,
  VALUELESS_OPERATORS,
  type CrmField,
  type CrmFilter,
  type CrmObject,
  type CrmOperator,
  type CrmQuery,
  type CrmRecordSource,
  type CrmView,
} from "./crm-record-source.js";

/**
 * Importing a CRM's contacts and companies (WB2-023) or saved Apollo contacts (WB2-024) into a workbook: what can be
 * chosen, and the preview. A preview is an import waiting to be confirmed, so mapping, confirming, progress, cancelling
 * and the report are the same as for a CSV file (WB2-020). Nothing is added before the confirm.
 */
const { workbookColumns, workbookImports } = schema;

export const MAX_CRM_FIELDS = 50;
export const CRM_PREVIEW_ROWS = 20;
const MAX_PREVIEW_TEXT = 500;
const COLUMN_NAME_MAX = 200;

/** A confirmed or waiting CRM import, as stored on the import record beside the CSV mapping. */
export interface CrmPlan {
  provider: string;
  providerLabel: string;
  object: CrmObject;
  /** The CRM account the preview was read from; the import refuses to read another. */
  accountId: string;
  query: CrmQuery;
  viewName: string | null;
  /** The names of the stages searched by, as they were at the preview. */
  searchStages?: string[];
  /** How many records the CRM said the selection holds; null when it did not say. */
  matched: number | null;
  /** Where the next page starts, saved with each chunk of rows. */
  cursor: string | null;
  done: boolean;
  /** Set when the workbook filled up before the selection ended, or the source would not be read any further. */
  truncated?: { matched: number; considered: number; reason?: "source_limit" };
  background?: boolean;
}

const CODE = {
  // Not 401: that would read as the person's own Skout session ending.
  not_connected: ["CRM_NOT_CONNECTED", 409],
  reauth: ["CRM_RECONNECT_REQUIRED", 409],
  scope: ["CRM_SCOPE_MISSING", 409],
  rate_limited: ["CRM_RATE_LIMITED", 429],
  unavailable: ["CRM_UNAVAILABLE", 502],
  not_found: ["CRM_UNKNOWN_VIEW", 422],
  rejected: ["CRM_QUERY_REJECTED", 422],
} as const satisfies Record<CrmSourceError["failure"], readonly [string, number]>;

export const objectLabel = (object: CrmObject) => (object === "contact" ? "contacts" : "companies");

function requireSource(access: CrmAccess, provider: string, object: CrmObject): CrmRecordSource {
  const source = access.source(provider);
  if (!source || !source.objects.includes(object)) {
    throw new WorkbookV2Error("CRM_NOT_AVAILABLE", 422, `Importing ${objectLabel(object)} from ${access.label(provider)} isn't available yet.`);
  }
  return source;
}

/** Runs a call to the CRM, turning its failure into an answer that says what to do. */
async function fromCrm<T>(access: CrmAccess, workspaceId: string, provider: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof CrmSourceError)) throw error;
    if (error.failure === "reauth") await access.expired(workspaceId, provider);
    const [code, status] = CODE[error.failure];
    throw new WorkbookV2Error(providerCode(provider, code), status, crmMessage(provider, error.failure, access.label(provider)), error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : undefined);
  }
}

const open = (access: CrmAccess, workspaceId: string, provider: string) => fromCrm(access, workspaceId, provider, () => access.open(workspaceId, provider));

export interface CrmProviderDto {
  provider: string;
  label: string;
  status: CrmConnectionStatus;
  objects: readonly CrmObject[];
}

/** The CRMs Workbooks knows of, and which of them this workspace can import from now. */
export async function listCrmSources(access: CrmAccess, workspaceId: string): Promise<CrmProviderDto[]> {
  return Promise.all(
    CRM_PROVIDERS.map(async (provider) => ({
      provider,
      label: access.label(provider),
      status: await access.status(workspaceId, provider),
      objects: access.source(provider)?.objects ?? [],
    }))
  );
}

export interface CrmObjectDto {
  provider: string;
  object: CrmObject;
  fields: Array<CrmField & { operators: readonly CrmOperator[] }>;
  defaultFields: string[];
  views: { label: string; note: string; available: boolean; reason: string | null; items: CrmView[] };
  filters: { max: number };
}

export async function describeCrmObject(access: CrmAccess, workspaceId: string, provider: string, object: CrmObject): Promise<CrmObjectDto> {
  const source = requireSource(access, provider, object);
  const session = await open(access, workspaceId, provider);
  const fields = await fromCrm(access, workspaceId, provider, () => source.listFields(session.accessToken, object));
  // A connection without permission for lists can still import everything, or by filter.
  let items: CrmView[] = [];
  let reason: string | null = null;
  try {
    items = await source.listViews(session.accessToken, object);
  } catch (error) {
    if (!(error instanceof CrmSourceError) || error.failure === "reauth") await fromCrm(access, workspaceId, provider, () => Promise.reject(error));
    reason = crmMessage(provider, (error as CrmSourceError).failure, access.label(provider));
  }
  const names = new Set(fields.map((f) => f.name));
  return {
    provider,
    object,
    fields: fields.map((f) => ({ ...f, operators: source.operatorsFor(f.type) })).sort((a, b) => a.label.localeCompare(b.label)),
    defaultFields: source.defaultFields(object).filter((name) => names.has(name)),
    views: { ...source.views, available: reason === null, reason, items },
    filters: { max: source.maxFilters },
  };
}

export interface CrmImportRequest {
  provider: string;
  object: CrmObject;
  fields: string[];
  viewId?: string;
  filters?: Array<{ field: string; operator: CrmOperator; value?: string }>;
  search?: { keywords?: string; stageIds?: string[] };
}

const invalidFilter = (message: string, index?: number) => new WorkbookV2Error("CRM_INVALID_FILTER", 422, message, index === undefined ? undefined : { filter: index });

const FILTER_VALUE: Partial<Record<CrmField["type"], [InputDataType, string]>> = {
  number: ["number", "a number"],
  date: ["date", "a date (YYYY-MM-DD)"],
  datetime: ["date", "a date (YYYY-MM-DD)"],
  bool: ["checkbox", "true or false"],
};

/** Checks every filter against the fields the CRM really has, before anything is read with it. */
function checkFilters(source: CrmRecordSource, fields: Map<string, CrmField>, requested: NonNullable<CrmImportRequest["filters"]>): CrmFilter[] {
  if (requested.length > source.maxFilters) throw invalidFilter(`Use at most ${source.maxFilters} filters.`);
  return requested.map((filter, index) => {
    const field = fields.get(filter.field);
    if (!field) throw invalidFilter("A filter uses a field the CRM doesn't have.", index);
    if (!source.operatorsFor(field.type).includes(filter.operator)) throw invalidFilter(`“${field.label}” can't be filtered that way.`, index);
    if (VALUELESS_OPERATORS.includes(filter.operator)) {
      if (filter.value !== undefined) throw invalidFilter(`“${field.label}” needs no value for this filter.`, index);
      return { field: field.name, operator: filter.operator, type: field.type };
    }
    const value = filter.value?.trim();
    if (!value) throw invalidFilter(`Give a value to filter “${field.label}” by.`, index);
    const rule = FILTER_VALUE[field.type];
    if (rule) {
      const cell = normalizeInputValue(value, rule[0]);
      if (cell.kind !== "value" || cell.errorCode) throw invalidFilter(`Filtering “${field.label}” needs ${rule[1]}.`, index);
      return { field: field.name, operator: filter.operator, type: field.type, value: field.type === "bool" ? String(cell.value) : value };
    }
    return { field: field.name, operator: filter.operator, type: field.type, value };
  });
}

const SIMPLE: Partial<Record<CrmField["type"], InputDataType>> = { number: "number", date: "date", datetime: "date", bool: "checkbox", phone: "phone" };

/** The kind of value a field is known to hold, from its type or its name. */
function knownType(field: CrmField): InputDataType | null {
  if (field.holds) return field.holds;
  if (field.type !== "string") return SIMPLE[field.type] ?? null;
  const name = field.name.toLowerCase();
  if (name === "email") return "email";
  if (name === "domain") return "domain";
  if (name === "website") return "url";
  return name.includes("linkedin") ? "linkedin_url" : null;
}

const TESTED: InputDataType[] = ["email", "url", "linkedin_url", "domain", "phone", "number", "date", "checkbox"];

/**
 * Which column types a field may be imported into: text, the type it is known to hold, and any type every value in the
 * preview fits. A choice outside these is refused when the import is confirmed. The suggested type is the known one,
 * when the previewed values bear it out.
 */
export function fieldTypes(field: CrmField, sample: string[]): { fits: InputDataType[]; suggested: InputDataType } {
  const filled = sample.filter((v) => v.trim() !== "");
  const holds = (type: InputDataType) =>
    filled.every((v) => {
      const cell = normalizeInputValue(v, type);
      return cell.kind === "value" && !cell.errorCode;
    });
  const known = knownType(field);
  const fits = new Set<InputDataType>(["text"]);
  if (known) fits.add(known);
  if (known === "url" || known === "linkedin_url") fits.add("url");
  // A field the CRM types as something else holds that, whatever a few values look like.
  if (filled.length && field.type === "string") for (const type of TESTED) if (holds(type)) fits.add(type);
  return { fits: [...fits], suggested: known && holds(known) ? known : "text" };
}

async function columnsOf(db: Db, workbookId: string): Promise<ExistingColumn[]> {
  const rows = await db
    .select({ id: workbookColumns.id, name: workbookColumns.name, type: workbookColumns.type, config: workbookColumns.config })
    .from(workbookColumns)
    .where(eq(workbookColumns.workbookId, workbookId))
    .orderBy(asc(workbookColumns.position), asc(workbookColumns.id));
  return rows.map((c) => ({ id: c.id, name: c.name, type: c.type, dataType: inputDataType(c.config) }));
}

/** Reads the first records of a selection and keeps them as an import waiting to be confirmed. */
export async function createCrmImport(db: Db, access: CrmAccess, actor: WorkbookActor, workbookId: string, input: CrmImportRequest): Promise<ImportDto> {
  await findLiveWorkbook(db, actor.workspaceId, workbookId);
  const source = requireSource(access, input.provider, input.object);
  if (input.viewId !== undefined && (input.filters?.length || input.search)) {
    throw invalidFilter(`A ${source.views.label} and ${input.search ? "a search" : "filters"} can't be used together. Choose one.`);
  }
  await assertRoomForAnotherImport(db, actor.workspaceId);
  const label = access.label(input.provider);
  const session: CrmSession = await open(access, actor.workspaceId, input.provider);
  const crm = <T>(work: () => Promise<T>) => fromCrm(access, actor.workspaceId, input.provider, work);

  const available = new Map((await crm(() => source.listFields(session.accessToken, input.object))).map((f) => [f.name, f]));
  const unknown = input.fields.filter((name) => !available.has(name));
  if (unknown.length) throw new WorkbookV2Error(providerCode(input.provider, "CRM_UNKNOWN_FIELD"), 422, `${label} has no field “${unknown[0]}” on ${objectLabel(input.object)}.`, { fields: unknown });
  const fields = input.fields.map((name) => available.get(name)!);
  const filters = checkFilters(source, available, input.filters ?? []);

  let view: CrmView | null = null;
  if (input.viewId !== undefined) {
    view = (await crm(() => source.listViews(session.accessToken, input.object))).find((v) => v.id === input.viewId) ?? null;
    if (!view) throw new WorkbookV2Error(providerCode(input.provider, "CRM_UNKNOWN_VIEW"), 422, `That ${source.views.label} doesn't exist for ${objectLabel(input.object)}. Choose it again.`);
  }
  let search: CrmQuery["search"];
  let searchStages: string[] = [];
  if (input.search) {
    const keywords = input.search.keywords?.trim();
    const stageIds = input.search.stageIds ?? [];
    if (stageIds.length) {
      const stages = new Map((await crm(() => source.listStages!(session.accessToken))).map((s) => [s.id, s.name]));
      const missing = stageIds.filter((id) => !stages.has(id));
      if (missing.length) throw new WorkbookV2Error("APOLLO_UNKNOWN_STAGE", 422, `That contact stage no longer exists in ${label}. Choose it again.`, { stageIds: missing });
      searchStages = stageIds.map((id) => stages.get(id)!);
    }
    search = { ...(keywords ? { keywords } : {}), ...(stageIds.length ? { stageIds } : {}) };
  }
  const query: CrmQuery = { object: input.object, fields: input.fields, filters, ...(view ? { viewId: view.id } : {}), ...(search ? { search } : {}) };
  const narrowed = Boolean(view || filters.length || search?.keywords || search?.stageIds);
  const first = await crm(() => source.page(session.accessToken, query, null, CRM_PREVIEW_ROWS));
  const shown = first.records.flatMap((r) => (r.properties ? [r.properties] : []));
  if (!shown.length) {
    throw new WorkbookV2Error("NOTHING_TO_ADD", 422, `${label} has no ${objectLabel(input.object)} ${narrowed ? "in this selection" : "yet"}.`);
  }
  // The page's own total, where it gives one, is newer than what a view says of itself.
  const counted = first.total ?? (view ? view.count : await crm(() => source.count(session.accessToken, query)));
  // A CRM's count can lag behind; it is never less than what was just read.
  const matched = counted === null ? null : Math.max(counted, shown.length);

  const values = shown.map((properties) => fields.map((f) => properties[f.name] ?? ""));
  const labels = fields.map((f) => f.label);
  const headers: CsvHeader[] = fields.map((field, index) => {
    const sample = values.map((row) => row[index]!);
    const name = labels.indexOf(field.label) === labels.lastIndexOf(field.label) ? field.label : `${field.label} (${field.name})`;
    return { index, name: name.slice(0, COLUMN_NAME_MAX), fits: fieldTypes(field, sample).fits, filled: sample.filter((v) => v.trim()).length };
  });
  const columns = await columnsOf(db, workbookId);
  // Every chosen field is offered for import, even one that is empty in the first records.
  const suggestions = suggestMapping(
    headers.map((h) => ({ ...h, filled: Math.max(1, h.filled) })),
    columns,
    MAX_COLUMNS,
    COLUMN_NAME_MAX
  ).map((s) => {
    const field = fields[s.header]!;
    if (!s.target) return s;
    if ("newColumn" in s.target) {
      return { header: s.header, target: { newColumn: { ...s.target.newColumn, dataType: fieldTypes(field, values.map((r) => r[s.header]!)).suggested } } };
    }
    const columnId = s.target.columnId;
    const column = columns.find((c) => c.id === columnId)!;
    // A column of the same name that cannot take this field is not suggested.
    return headers[s.header]!.fits.includes(column.dataType) && namedLike(column.name, headers[s.header]!.name) ? s : { header: s.header, target: null };
  });

  const id = randomUUID();
  const plan: CrmPlan = {
    provider: input.provider,
    providerLabel: label,
    object: input.object,
    accountId: session.accountId,
    query,
    viewName: view?.name ?? null,
    ...(searchStages.length ? { searchStages } : {}),
    matched,
    cursor: null,
    done: false,
  };
  const preview = {
    delimiter: ",",
    headers,
    rows: values.map((row, i) => ({ line: i + 1, values: row.map((v) => (v.length > MAX_PREVIEW_TEXT ? `${v.slice(0, MAX_PREVIEW_TEXT)}…` : v)) })),
    suggestions,
  };
  await db.insert(workbookImports).values({
    id,
    workbookId,
    sourceType: input.provider,
    status: "awaiting_confirmation",
    createdBy: actor.userId,
    fileName: `${label} ${objectLabel(input.object)}${view ? ` · ${view.name}` : filters.length ? " · filtered" : search && narrowed ? " · search" : ""}`.slice(0, 255),
    preview,
    plan: { crm: plan },
    counts: { total: Math.min(matched ?? 0, source.maxRecords ?? Infinity), processed: 0, imported: 0, duplicates: 0, skipped: 0, failed: 0 },
  });
  return getImport(db, actor.workspaceId, workbookId, id);
}

/** Before a CRM import starts: the connection must still be there, and still be the account the preview showed. */
export async function assertSameCrmAccount(access: CrmAccess, workspaceId: string, plan: CrmPlan): Promise<void> {
  const session = await open(access, workspaceId, plan.provider);
  if (session.accountId !== plan.accountId) {
    const changed = plan.provider === "apollo" ? "The Apollo API key was saved again" : `${plan.providerLabel} was reconnected to a different account`;
    throw new WorkbookV2Error(providerCode(plan.provider, "CRM_ACCOUNT_CHANGED"), 409, `${changed} since this preview. Cancel it and start again.`);
  }
}

export { CRM_OBJECTS };
