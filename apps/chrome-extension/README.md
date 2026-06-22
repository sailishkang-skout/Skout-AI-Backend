# Skout AI Chrome Extension (MVP)

Manifest V3 extension for LinkedIn prospect capture.

## Load unpacked

1. Start **API** (`pnpm dev` on port 3001) and **web app** (`pnpm dev` on port 3000).
2. Open `chrome://extensions` → **Developer mode** → **Load unpacked** → select this folder.
3. **Sign in to Skout** at http://localhost:3000 (Clerk) — the extension picks up your session automatically.
4. Open a LinkedIn profile (`/in/username`).
5. Pick a list in the popup → **Add to list** or **Enrich email**.

## Connect (Clerk — normal local dev)

1. **Reload** the extension at `chrome://extensions` after code changes.
2. Sign in to Skout in Chrome (same browser as the extension).
3. Open the extension popup — it should show **Signed in as you@email.com** within a few seconds.
4. If not connected yet, click **Connect Skout account** (opens Skout; syncs when you’re signed in).
5. Click **Refresh lists**, then use Add to list / Enrich on LinkedIn.

**Stub mode** (optional): only if API runs with `AUTH_STUB=true` — check **Use stub auth** in the popup and set a stub email.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Not signed in" | Sign in to Skout at localhost:3000 in the same Chrome profile |
| "Could not load lists" | Wait for green signed-in status, or click Connect Skout account |
| "Not a LinkedIn profile" | Open `/in/username`, not feed or company page |
| "Cannot reach API" | Start backend on port 3001 |
| Buttons seem dead | Check red error text at bottom of popup; reload extension after code changes |

After code changes: go to `chrome://extensions` → click **Reload** on Skout AI Prospector.
