-- WB2-023: one row per CRM record per workbook, so importing the same record again (a retry, or the same selection
-- twice) never adds a second row. Only references that name the record's object take part: the Rows API accepts a
-- shorter reference that does not.
CREATE UNIQUE INDEX IF NOT EXISTS "workbook_rows_workbook_crm_ref_key" ON "workbook_rows" ("workbook_id", (("crm_ref" ->> 'provider')), (coalesce("crm_ref" ->> 'accountId', '')), (("crm_ref" ->> 'object')), (("crm_ref" ->> 'id'))) WHERE ("crm_ref" ->> 'object') IS NOT NULL;
