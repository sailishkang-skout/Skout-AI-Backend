import {
  HubSpotApiError,
  HubSpotRateLimitError,
  fetchHubSpotListMemberPage,
  fetchHubSpotObjectLists,
  fetchHubSpotObjectsById,
  fetchHubSpotObjectsPage,
  fetchHubSpotProperties,
  searchHubSpotObjects,
  type HubSpotFilter,
  type HubSpotObject,
  type HubSpotObjectType,
  type HubSpotProperty,
} from "../hubspot.client.js";
import { CrmSourceError, type CrmFieldType, type CrmFilter, type CrmObject, type CrmOperator, type CrmQuery, type CrmRecordSource } from "../crm-record-source.js";

/**
 * HubSpot contacts and companies (WB2-023), on the existing HubSpot client. Three ways to select records, each with its
 * own paging: every record (the objects API), the members of a list (ids, then the records), or filters (the search
 * API, walked by record id so that it is not held to search's first 10,000 matches).
 */
const OBJECT_TYPE: Record<CrmObject, HubSpotObjectType> = { contact: "contacts", company: "companies" };

const DEFAULT_FIELDS: Record<CrmObject, readonly string[]> = {
  contact: ["firstname", "lastname", "email", "jobtitle", "company", "phone"],
  company: ["name", "domain", "website", "industry", "phone", "city", "country"],
};

const OPERATOR: Record<CrmOperator, string> = {
  equals: "EQ",
  not_equals: "NEQ",
  contains: "CONTAINS_TOKEN",
  not_contains: "NOT_CONTAINS_TOKEN",
  greater_than: "GT",
  at_least: "GTE",
  less_than: "LT",
  at_most: "LTE",
  has_value: "HAS_PROPERTY",
  is_empty: "NOT_HAS_PROPERTY",
};

const PRESENCE: CrmOperator[] = ["has_value", "is_empty"];
const OPERATORS: Record<CrmFieldType, readonly CrmOperator[]> = {
  string: ["equals", "not_equals", "contains", "not_contains", ...PRESENCE],
  phone: ["equals", "not_equals", "contains", "not_contains", ...PRESENCE],
  enumeration: ["equals", "not_equals", ...PRESENCE],
  bool: ["equals", "not_equals", ...PRESENCE],
  number: ["equals", "not_equals", "greater_than", "at_least", "less_than", "at_most", ...PRESENCE],
  date: ["greater_than", "at_least", "less_than", "at_most", ...PRESENCE],
  datetime: ["greater_than", "at_least", "less_than", "at_most", ...PRESENCE],
};

/** HubSpot allows six filters in a group; one is kept for walking by record id. */
const MAX_FILTERS = 5;

function fieldType(property: HubSpotProperty): CrmFieldType {
  if (property.fieldType === "phonenumber" || property.type === "phone_number") return "phone";
  if (property.type === "number" || property.type === "date" || property.type === "datetime" || property.type === "bool" || property.type === "enumeration") return property.type;
  return "string";
}

/** Turns whatever the client threw into what happened. HubSpot's own words stop here. */
function failure(error: unknown): CrmSourceError {
  if (error instanceof CrmSourceError) return error;
  if (error instanceof HubSpotRateLimitError) return new CrmSourceError("rate_limited", error.retryAfterMs);
  if (error instanceof HubSpotApiError) {
    if (error.status === 401) return new CrmSourceError("reauth");
    if (error.status === 403 || error.missingScope) return new CrmSourceError("scope");
    if (error.status === 404) return new CrmSourceError("not_found");
    if (error.status === 429) return new CrmSourceError("rate_limited");
    if (error.status >= 500) return new CrmSourceError("unavailable");
    return new CrmSourceError("rejected");
  }
  // Network failures, time-outs and unreadable answers.
  return new CrmSourceError("unavailable");
}

const guarded = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw failure(error);
  }
};

const toRecord = (object: HubSpotObject, fields: string[]) => ({
  id: String(object.id),
  properties: Object.fromEntries(fields.map((f) => [f, object.properties?.[f] ?? null])),
});

const DAY_END_MS = 24 * 60 * 60 * 1000 - 1;

/**
 * HubSpot compares dates as milliseconds. A day given for a date and time covers the whole day: "after" means after it
 * ends, "up to" includes all of it.
 */
function filterValue(filter: CrmFilter): string {
  const value = filter.value!;
  if (filter.type !== "date" && filter.type !== "datetime") return value;
  const wholeDay = value.length === 10;
  const at = Date.parse(wholeDay ? `${value}T00:00:00Z` : value);
  const late = filter.type === "datetime" && wholeDay && (filter.operator === "greater_than" || filter.operator === "at_most");
  return String(late ? at + DAY_END_MS : at);
}

const toFilter = (filter: CrmFilter): HubSpotFilter => ({
  propertyName: filter.field,
  operator: OPERATOR[filter.operator],
  ...(filter.value === undefined ? {} : { value: filterValue(filter) }),
});

/** A page of the selection. The cursor is HubSpot's `after` token, or for filters the last record id read. */
async function page(token: string, query: CrmQuery, cursor: string | null, limit: number) {
  const type = OBJECT_TYPE[query.object];
  if (query.viewId !== undefined) {
    const members = await fetchHubSpotListMemberPage(token, query.viewId, cursor, limit);
    const found = new Map((await fetchHubSpotObjectsById(token, type, members.ids, query.fields)).map((o) => [String(o.id), o]));
    return {
      records: members.ids.map((id) => (found.has(id) ? toRecord(found.get(id)!, query.fields) : { id, properties: null })),
      next: members.after,
    };
  }
  if (query.filters.length) {
    const filters = query.filters.map(toFilter);
    if (cursor !== null) filters.push({ propertyName: "hs_object_id", operator: "GT", value: cursor });
    const { results } = await searchHubSpotObjects(token, type, filters, query.fields, limit);
    const records = results.map((o) => toRecord(o, query.fields));
    return { records, next: records.length === limit ? records[records.length - 1]!.id : null };
  }
  const answer = await fetchHubSpotObjectsPage(token, type, query.fields, cursor, limit);
  return { records: answer.results.map((o) => toRecord(o, query.fields)), next: answer.after };
}

export const hubspotRecords: CrmRecordSource = {
  objects: ["contact", "company"],
  views: { label: "HubSpot list", note: "HubSpot's saved views can't be read through its API, so choose one of your lists, or add filters instead." },
  maxFilters: MAX_FILTERS,
  operatorsFor: (type) => OPERATORS[type],
  defaultFields: (object) => DEFAULT_FIELDS[object],

  listFields: (token, object) =>
    guarded(async () => {
      const properties = await fetchHubSpotProperties(token, OBJECT_TYPE[object]);
      return properties.filter((p) => !p.hidden).map((p) => ({ name: p.name, label: p.label || p.name, type: fieldType(p) }));
    }),

  listViews: (token, object) =>
    guarded(async () => (await fetchHubSpotObjectLists(token, OBJECT_TYPE[object])).map((l) => ({ id: l.listId, name: l.name, count: l.size }))),

  count: (token, query) =>
    guarded(async () => {
      if (query.viewId !== undefined) {
        const list = (await fetchHubSpotObjectLists(token, OBJECT_TYPE[query.object])).find((l) => l.listId === query.viewId);
        return list ? list.size : null;
      }
      return (await searchHubSpotObjects(token, OBJECT_TYPE[query.object], query.filters.map(toFilter), [], 1)).total;
    }),

  page: (token, query, cursor, limit) => guarded(() => page(token, query, cursor, limit)),
};
