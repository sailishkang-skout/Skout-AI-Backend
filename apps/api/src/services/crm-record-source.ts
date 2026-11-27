import type { InputDataType } from "./workbook-cell-values.js";

/**
 * Reading contacts and companies from somewhere outside Skout: a CRM (WB2-023) or Apollo (WB2-024). A CRM connector
 * that can be imported from provides a record source (`CrmConnector.records`), and the Apollo import adapter provides
 * Apollo's; anything without one is offered to nobody. Everything provider-specific, from which filters exist to how
 * pages are walked, stays behind this interface.
 */
export const CRM_OBJECTS = ["contact", "company"] as const;
export type CrmObject = (typeof CRM_OBJECTS)[number];

export type CrmFieldType = "string" | "number" | "date" | "datetime" | "bool" | "enumeration" | "phone";

export interface CrmField {
  name: string;
  label: string;
  type: CrmFieldType;
  /** The kind of value it holds, where the field's name and type don't already say. */
  holds?: InputDataType;
}

/** A selection saved in the CRM that records can be read from, such as a HubSpot list. */
export interface CrmView {
  id: string;
  name: string;
  /** What the CRM says it holds, which may be out of date. Null when it does not say. */
  count: number | null;
}

export const CRM_OPERATORS = ["equals", "not_equals", "contains", "not_contains", "greater_than", "at_least", "less_than", "at_most", "has_value", "is_empty"] as const;
export type CrmOperator = (typeof CRM_OPERATORS)[number];
export const VALUELESS_OPERATORS: readonly CrmOperator[] = ["has_value", "is_empty"];

export interface CrmFilter {
  field: string;
  operator: CrmOperator;
  value?: string;
  /** The field's type, so a source can write the value the way its CRM expects. */
  type?: CrmFieldType;
}

/** What to read: every record, one view, or the records matching all filters. */
export interface CrmQuery {
  object: CrmObject;
  /** Field names to read, in the order they are shown. */
  fields: string[];
  viewId?: string;
  filters: CrmFilter[];
  /** A free search, for a source that has one instead of filters. Empty means every record. */
  search?: { keywords?: string; stageIds?: string[] };
}

export interface CrmRecord {
  id: string;
  /** Null for a record the selection named but the CRM no longer has. */
  properties: Record<string, string | null> | null;
  /** Other identifiers of the record worth keeping beside its id. */
  ref?: Record<string, string>;
}

export interface CrmPage {
  /** In the selection's order. */
  records: CrmRecord[];
  /** Where the next page starts; null after the last. Opaque, and safe to store. */
  next: string | null;
  /** How many records the selection holds, when the page says. */
  total?: number | null;
  /** Set on a last page when the source holds more than it will let anyone read. */
  limited?: boolean;
}

/**
 * `reauth`: access expired or was revoked. `scope`: connected without permission for this. `rate_limited` and
 * `unavailable`: worth trying later. `not_found`: the view is gone. `rejected`: the CRM refused the request as made.
 */
export type CrmFailure = "not_connected" | "reauth" | "scope" | "rate_limited" | "unavailable" | "not_found" | "rejected";

/** The only thing a record source throws. It says what went wrong, never what the CRM answered. */
export class CrmSourceError extends Error {
  constructor(
    readonly failure: CrmFailure,
    readonly retryAfterMs?: number
  ) {
    super(`CRM read failed: ${failure}`);
    this.name = "CrmSourceError";
  }
  get retryable() {
    return this.failure === "rate_limited" || this.failure === "unavailable";
  }
}

export interface CrmRecordSource {
  readonly objects: readonly CrmObject[];
  /** What a view is called here, and what cannot be offered. */
  readonly views: { label: string; note: string };
  readonly maxFilters: number;
  /** Record ids are unique everywhere, so a record is recognised whichever account it is read through. */
  readonly globalIds?: boolean;
  /** The most records one selection can be read to. */
  readonly maxRecords?: number;
  /** A deleted view reads as empty rather than as an error, so it has to be looked for. */
  readonly verifyViews?: boolean;
  /** The longest a background import waits in place for a rate limit to lift before it is put back in the queue. */
  readonly maxRateLimitWaitMs?: number;
  /** Stages records can be searched by, where the source has them. */
  listStages?(token: string): Promise<Array<{ id: string; name: string }>>;
  operatorsFor(type: CrmFieldType): readonly CrmOperator[];
  /** Fields worth selecting to start with. */
  defaultFields(object: CrmObject): readonly string[];
  listFields(token: string, object: CrmObject): Promise<CrmField[]>;
  listViews(token: string, object: CrmObject): Promise<CrmView[]>;
  /** How many records the query selects, when the CRM can say. */
  count(token: string, query: CrmQuery): Promise<number | null>;
  /** Up to `limit` records from `cursor` (null for the first page). */
  page(token: string, query: CrmQuery, cursor: string | null, limit: number): Promise<CrmPage>;
}
