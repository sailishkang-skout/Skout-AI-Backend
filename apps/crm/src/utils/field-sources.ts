/**
 * R13.3 — Auto-filled CRM/contact fields.
 *
 * The actual logic now lives in @skout/shared (packages/shared/src/field-sources.ts) so
 * apps/api's enrichment and call-note pipelines can reuse it without a cross-service HTTP call
 * (apps/api and apps/crm are separately deployed services sharing one Postgres). Re-exported
 * here so existing imports in this app (`../utils/field-sources.js`) keep working unchanged.
 */
export {
  type FieldSource,
  type FieldSourceEntry,
  type FieldSourcesMap,
  DEFAULT_AUTO_FILL_CONFIDENCE,
  asFieldSourcesMap,
  effectiveSourcesForAutofill,
  filterAutoFillablePatch,
  mergeAutoFillSources,
  markManualSources,
} from "@skout/shared";
