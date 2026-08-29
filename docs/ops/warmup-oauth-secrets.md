# Warm-Up OAuth — required keys

Ask Sailesh / platform for **Warm-Up Tool** OAuth app credentials (not Deliverability).

## Required environment variables (all-or-nothing per provider)

### Google Connect
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI` — must match console, e.g.  
  `http://localhost:3010/api/v1/oauth/google/callback` (local)  
  `https://<warmup-public-host>/api/v1/oauth/google/callback` (ECS)

### Microsoft 365 Connect
- `MICROSOFT_CLIENT_ID`
- `MICROSOFT_CLIENT_SECRET`
- `MICROSOFT_REDIRECT_URI` — e.g.  
  `http://localhost:3010/api/v1/oauth/microsoft/callback`  
  `https://<warmup-public-host>/api/v1/oauth/microsoft/callback`

## Where to set (SkoutDev)

**Google (live):** reuse `SkoutDev/google` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`).  
CDK injects those into Warm-Up ECS plus:

`GOOGLE_REDIRECT_URI=https://ckoy6iywm0.execute-api.us-east-1.amazonaws.com/api/v1/warmup-tool/oauth/google/callback`

Register that redirect URI on the same Google OAuth client (inbox/calendar app).

**Microsoft (pending):** add `MICROSOFT_*` to `SkoutDev/warmup-tool` or a dedicated secret when Sailesh provides the Entra app; wire in `warmup-tool-stack.ts` the same way as Google.

## Verify
Frontend `/warmup` → Connect Google/Microsoft → mailbox status connected.
