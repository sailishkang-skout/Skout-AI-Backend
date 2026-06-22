# Skout AI Chrome Extension (MVP)

Manifest V3 extension for LinkedIn prospect capture.

## Load unpacked

1. Start **API** and **web app** (local or deployed).
2. Open `chrome://extensions` → **Developer mode** → **Load unpacked** → select this folder.
3. Configure URLs in the side panel (defaults to localhost if unset).
4. **Sign in to Skout** in the same Chrome profile → **Connect Skout account**.
5. Open a LinkedIn profile (`/in/username`).
6. Pick a list → **Add to list** or **Enrich email**.

## Local dev (default)

| Setting | Default |
|--------|---------|
| Web URL | `http://localhost:3000` |
| API URL | `http://localhost:3001` |

No extra setup — works out of the box when both servers are running.

## Deployed server (dev / UAT / prod)

1. In the side panel, set **Web URL** to your deployed app (e.g. `https://app.example.com` or ALB DNS).
2. Set **API URL** to your API origin:
   - Same host if API is proxied at `/api` on the app domain
   - Or the API Gateway / ALB URL if separate
3. Click **Save settings** — approve the host permission prompt if Chrome asks.
4. Open your deployed Skout URL, sign in, then **Connect Skout account**.

Defaults fall back to localhost when URLs are not saved.

## Connect (Clerk)

1. **Reload** the extension at `chrome://extensions` after code changes.
2. Sign in to Skout (local or deployed) in the same browser.
3. Click **Connect Skout account** if not auto-connected.
4. Click **Refresh lists**, then use Add to list / Enrich on LinkedIn.

**Stub mode** (optional): only if API runs with `AUTH_STUB=true` — check **Use stub auth** and set a stub email.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Not signed in" | Sign in to Skout at your configured Web URL |
| "Could not load lists" | Check API URL; click Connect Skout account |
| Host permission denied | Re-save settings and allow access to your Skout domain |
| "Not a LinkedIn profile" | Open `/in/username`, not feed or company page |
| "Cannot reach API" | Verify API URL and that CORS includes your web origin |
| Buttons seem dead | Reload extension; hard-refresh LinkedIn + Skout tabs |

After code changes: `chrome://extensions` → **Reload** → hard-refresh open tabs.
