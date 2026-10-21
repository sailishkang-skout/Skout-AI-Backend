# Runbook: resolve a duplicate account merge (COPS-02, Bible Appendix I)

Use this when the same customer exists twice (for example one account from the HubSpot import and
one created by hand), or when a merge was refused.

All paths are under `/api/v1`. Merging needs `crm:admin`.

## 1. Pick the survivor

The survivor keeps its id, its values and its history. Pick the account with the most history: the
one with the subscription, the tickets or the CRM link. The duplicate's id stays traceable in the
merge history (`cops_account_merges`), so old references still lead to the survivor.

## 2. Preview the merge

`POST /accounts/merge` with `{ "survivor_id": "...", "duplicate_id": "...", "reason": "Same customer imported twice from HubSpot" }`
and no `confirm`.

- No conflicts: the merge runs at once (step 3 is not needed).
- Conflicts: the answer is `{ "status": "review_required", "conflicts": [...] }` listing each field
  (name, domain, owner) where both accounts have a different value. Nothing has changed yet.

The reason must be 8 to 500 characters; it goes in the audit log.

## 3. Confirm

If the survivor's values are the right ones, send the same request with `"confirm": true`. The merge:

- keeps the survivor's values and fills its empty fields from the duplicate;
- moves every reference (contacts, opportunities, tickets, tasks, timeline) to the survivor;
- keeps the survivor's CRM link where both are linked on the same connection, and records the
  duplicate's external id in the merge history, so no external reference is lost;
- records the merge and an `account.merged` audit row, and removes the duplicate.

If the duplicate's value is the right one for a conflicting field, change the survivor's field
first (normal account edit), then preview again.

## 4. When it is refused

- `409 BUSINESS_STATE_CONFLICT` "This account has already been merged": the duplicate was merged
  before. Look it up in `cops_account_merges` by `duplicate_id` to find its survivor.
- `422 VALIDATION_FAILED`: an id is not in this workspace, or the two ids are the same.

## 5. Check

- `GET /accounts/:survivor_id/360` shows the moved contacts, opportunities and tickets.
- If a CRM sync is connected, run `POST /crm/:provider/poll` so the provider sees one account.

## Do not

- Do not delete the duplicate by hand: its references would point nowhere and the merge history
  would not record it.
- People (contacts) are merged through the identity-merge review (`/identity-merge/proposals`),
  not this endpoint.
