# Skout AI Chrome Extension (MVP)

Manifest V3 extension for LinkedIn prospect capture.

## Load unpacked

1. Start **API** and **web app** (local or deployed).
2. Open `chrome://extensions` → **Developer mode** → **Load unpacked** → select this folder.
3. Configure URLs in the side panel (defaults to localhost if unset).
4. **Sign in to Skout** in the same Chrome profile → **Connect Skout account**.
5. Open a LinkedIn profile (`/in/username`).
6. Pick a list → **Add to list**, **Enrich email**, or **Score ICP**.

## Local dev (default)

| Setting | Default |
|--------|---------|
| Web URL | `http://localhost:3000` |
| API URL | `http://localhost:3001` |

No extra setup — works out of the box when both servers are running.

## Test on dev server (AWS)

Use the **API Gateway WebUrl** from CDK deploy output — not the ALB URL (ALB returns 403 when HTTPS front door is enabled).

### 1. Get dev URLs

```bash
cd infra && pnpm cdk deploy --all -c env=dev --outputs-file outputs.json
```

From `outputs.json` (or AWS console):

| Field | Example | Use in extension |
|-------|---------|------------------|
| **WebUrl** | `https://abc123.execute-api.us-east-1.amazonaws.com` | **Web URL** |
| **ApiUrl** (CDK) | `https://abc123...amazonaws.com/api/v1` | **API URL** — paste as-is; Save strips `/api/v1` automatically |

### 2. Configure extension

1. `chrome://extensions` → **Load unpacked** → this folder
2. Open side panel → **Developer settings**
3. Set **Web URL** = WebUrl from CDK
4. Set **API URL** = same origin (or paste ApiUrl — `/api/v1` is stripped on save)
5. **Use stub auth** = off (use real Clerk)
6. Click **Save settings** → approve Chrome host permission prompt

### 3. Clerk dashboard

Add your dev WebUrl to **Allowed origins** and sign-in redirect URLs in [Clerk Dashboard](https://dashboard.clerk.com).

### 4. Connect and test

1. Open dev WebUrl in Chrome → sign in with Clerk
2. Side panel → **Connect Skout account** (should show “Signed in as …”)
3. **Refresh lists** → pick a list
4. LinkedIn `/in/username` → inline panel: Add / Enrich / Score ICP
5. LinkedIn people search → bulk panel: select profiles → Add to list

### 5. Debug

| Symptom | Fix |
|---------|-----|
| “Not signed in” | Keep Skout tab open and signed in; click Connect |
| Lists won’t load | API URL must be origin only (no `/api/v1`); check CORS |
| Bridge not working | Hard-refresh Skout tab after extension reload |
| Score fails “ICP not configured” | Set ICP in Skout → Settings |
| Settings reset to localhost | Fixed — only first install sets defaults; re-save after major reload |

Service worker logs: `chrome://extensions` → Skout AI Prospector → **Service worker** → filter `[Skout Extension]`.

## Connect (Clerk)

1. **Reload** the extension at `chrome://extensions` after code changes.
2. Sign in to Skout (local or deployed) in the same browser.
3. Click **Connect Skout account** if not auto-connected.
4. Click **Refresh lists**, then use Add / Enrich / Score on LinkedIn.

**Stub mode** (optional): only if API runs with `AUTH_STUB=true` — check **Use stub auth** and set a stub email.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Not signed in" | Sign in to Skout at your configured Web URL |
| "Could not load lists" | Check API URL; click Connect Skout account |
| Host permission denied | Re-save settings and allow access to your Skout domain |
| "Not a LinkedIn profile" | Open `/in/username`, not feed or company page |
| "Cannot reach API" | Verify API URL and that CORS includes your web origin |
| Wrong name on add | Focus the correct LinkedIn profile tab before adding |
| Buttons seem dead | Reload extension; hard-refresh LinkedIn + Skout tabs |

After code changes: `chrome://extensions` → **Reload** → hard-refresh open tabs.
