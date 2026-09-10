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

**Microsoft (live):** store in `SkoutDev/warmup-tool` (same secret as `ENCRYPTION_KEY`):

- `MICROSOFT_CLIENT_ID` — Application (client) ID from Entra
- `MICROSOFT_CLIENT_SECRET` — **Secret Value** (not the Secret ID)
- `MICROSOFT_REDIRECT_URI` — optional in Secrets Manager; CDK also injects  
  `https://ckoy6iywm0.execute-api.us-east-1.amazonaws.com/api/v1/warmup-tool/oauth/microsoft/callback`  
  as `MICROSOFT_REDIRECT_URI` on Warm-Up ECS tasks (must match Entra redirect URIs).

Entra delegated permissions: `openid`, `email`, `offline_access`, `Mail.Read`, `Mail.Send`.  
Warm-Up uses `/common` authority and Graph scopes (`https://graph.microsoft.com/Mail.*`) — do not change authority.

CDK injects `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` from `SkoutDev/warmup-tool` **only when** you pass `-c warmupMicrosoftOAuth=true`. Without those JSON keys present, ECS secret hydration fails and the whole Deploy Dev CDK step rolls back — so leave the flag off until the keys are in Secrets Manager.

Verify without printing secrets:

```bash
node scripts/verify-microsoft-oauth-config.mjs --from-aws SkoutDev/warmup-tool
```

Then redeploy with Microsoft OAuth enabled:

```bash
pnpm cdk deploy SkoutDev-WarmupTool -c env=dev -c warmupMicrosoftOAuth=true --require-approval never
# or full CI: add -c warmupMicrosoftOAuth=true to the Deploy CDK stacks step
```

## Verify
Frontend `/warmup` → Connect Google/Microsoft → mailbox status connected.
