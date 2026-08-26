# Integration encryption key rotation

## Code path
- Encrypt: current `INTEGRATION_ENCRYPTION_KEY`
- Decrypt: `decryptSecretWithFallback(cipher, current, INTEGRATION_ENCRYPTION_KEY_PREVIOUS)`
- Batch re-encrypt: `pnpm --filter @skout/db rotate-integration-encryption-key`

## Safe cutover
1. Generate new 32+ char key; store as candidate secret (do not overwrite yet).
2. Set `INTEGRATION_ENCRYPTION_KEY_PREVIOUS` = **current** live key.
3. Set `INTEGRATION_ENCRYPTION_KEY` = **new** key; redeploy API (dual-read works).
4. Run rotate script against that environment’s DB.
5. After verification, clear `INTEGRATION_ENCRYPTION_KEY_PREVIOUS` on next deploy window.

## Local dry-run
```bash
# Ensure both env vars set in .env for the window
pnpm --filter @skout/db rotate-integration-encryption-key
```

Do **not** rotate production without an approved maintenance window.

## 90-day cadence (Tier 1)
Rotate every **90 days** (and immediately on suspected exposure).  
Program baseline 2026-08-25 → next target **2026-11-23** unless prod rotated earlier.  
Track the window in the ops calendar; use the cutover steps above.

## Approved prod window (Leadership go-ahead 2026-08-25)
| Field | Value |
|-------|--------|
| Target date | **2026-11-23** (next scheduled) |
| Env | SkoutDev executed **2026-08-26**; SkoutProd on first deploy or next window |
| Status | **SkoutDev complete** — 9 rows rotated; `INTEGRATION_ENCRYPTION_KEY_PREVIOUS` cleared |
