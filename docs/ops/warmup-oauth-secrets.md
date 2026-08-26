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

## Where to set
Warm-Up ECS task definition / secrets manager for SkoutDev + prod.

## Verify
Frontend `/warmup` → Connect Google/Microsoft → mailbox status connected.
