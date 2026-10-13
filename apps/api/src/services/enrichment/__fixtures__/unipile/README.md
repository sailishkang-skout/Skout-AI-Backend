# Unipile payload fixtures

Two kinds of fixture live here and they are not interchangeable.

## `live/` — recorded from the real API

A file here is a response recorded from Unipile API v2 through a real connected account, with
personal data replaced (names, URLs, ids, emails, phone numbers) but **keys and value types left
exactly as returned**. These are the only fixtures that can prove a field mapping.

A mapping in `unipile-profile.adapter.ts` may be marked `status: "verified"` only when it names
one of these files in `verifiedBy` and that file contains a value at the mapped path. The
contract test (`unipile-profile.adapter.test.ts`) enforces both.

File names: `person-<label>.json`, `company-<label>.json`. The prefix tells the test which field
map to check.

**This directory is empty.** No live payload has been recorded yet, so no mapping is verified
and every provider job ends `PARTIAL` with its fields kept as evidence only.

### Recording one

1. Use a Unipile account and a LinkedIn profile you are authorised to retrieve.
2. `GET {base}/v2/{account_id}/users/{public_id}?with_sections=linkedin_*_preview&with_sections=linkedin_experience&with_sections=linkedin_skills`
   (companies: `GET {base}/v2/{account_id}/linkedin/company/{public_id}`), header `X-API-KEY`.
3. Replace personal values. Do not add, remove or rename keys. Do not commit a real person's data.
4. Save under `live/`, mark the mappings it proves as `verified` with `verifiedBy: "<file name>"`,
   and bump `UNIPILE_MAPPING_VERSION`.

## `documented/` — written from the published schema

Files here are hand-written from Unipile's v2 documentation (field names from the v1 → v2 users
migration guide). They exercise the adapter's mechanics — path reading, joining, blank handling —
and prove nothing about what the API really returns. A mapping must never cite one of these.
