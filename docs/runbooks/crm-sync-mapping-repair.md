# Runbook: repair a CRM sync mapping (COPS-09, Bible Appendix I)

Use this when records stop syncing for one field or object, a schema-drift alert fires, or the
connector health shows failed records after a mapping change.

All paths are under `/api/v1`. They need an admin of the workspace. `:provider` is `hubspot` today.

## 1. See what is wrong

1. `GET /crm/:provider/health` shows the auth status, last sync, backlog, failed records and the
   rate-limit state. If the auth status is `needs_reauth`, stop here: use
   [crm-oauth-recovery.md](crm-oauth-recovery.md) first.
2. `POST /crm/:provider/schema-drift` compares the saved mapping with the provider's live
   properties. It names every mapped property the provider no longer has; it does not change the
   mapping.
3. `GET /crm/outbound-writes` lists Skout → provider writes with their status; failed ones carry
   the provider's error.
4. `GET /crm/records/:entityType/:entityId/history` shows one record's sync history (inbound and
   outbound), so you can see when a field stopped moving.

## 2. Fix the mapping

1. `GET /crm/:provider/mappings` returns the active mapping (contact and deal).
2. Try the corrected mapping first, in memory: `POST /crm/:provider/mappings/test` with the mapping
   and sample data. Nothing is saved.
3. Save it: `PUT /crm/:provider/mappings` with `{ contact?, deal? }`. The API checks every mapped
   property against the provider's live properties and refuses (422) a property the portal does
   not have, so a broken mapping cannot be saved again.
4. Each save is a new version and is audited (`crm_mapping.updated`).
   `GET /crm/:provider/mappings/history?entityType=contact` lists the earlier ones, newest first.
   To go back, save the earlier version's mapping with `PUT`.

## 3. Resend what failed

1. Failed outbound writes: `POST /crm/outbound-writes/:id/replay` for each. A replay is audited and
   idempotent: the provider record is updated, not created again.
2. Missed inbound changes: `POST /crm/:provider/poll` runs an incremental pull from the last
   checkpoint. Records with a pending conflict are not overwritten; resolve them in the conflict
   queue (`GET /crm/conflicts`, `POST /crm/conflicts/:id/resolve`).
3. Check `GET /crm/:provider/health` again: the failed count should fall to zero and the last sync
   should be recent.

## Do not

- Do not edit the mapping in the database (`crm_connections.settings.mappings`): the version
  history, the live-property check and the `crm_mapping.updated` audit row are skipped.
- Do not delete failed outbound writes to clear the counter: replay them, or leave them for the
  record's history.
