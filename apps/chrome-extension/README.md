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

## Production (Chrome Web Store)

Store builds default to:

| Setting | Default |
|--------|---------|
| Web URL | `https://www.skoutai.io` |
| API URL | `https://ckoy6iywm0.execute-api.us-east-1.amazonaws.com` |

Package for upload:

```bash
pnpm build
pnpm package:store
```

Creates `skout-extension-v<version>.zip` with production-only host permissions (no localhost).

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

## Reviewed capture (ENR-02)

The side panel's **Capture** section saves a LinkedIn person profile, a company page, or a
Sales Navigator people search to Skout after the user reviews it.

| Step | Where | What happens |
| --- | --- | --- |
| Start | Side panel → `capture-background.js` → `capture/capture-content.js` | The user clicks Capture on the open tab. The API's capture status (kill switch, daily limit) is checked first. |
| Read | `capture/*.js` in the LinkedIn tab, temporary tabs opened by `capture-background.js` | Rendered content only. A person capture reads that profile's own detail pages; a company capture reads its tabs and up to 10 pages of its people results; a Sales capture reads at most 10 rendered result pages or 250 leads, then looks up each lead page, one at a time, for a public link LinkedIn shows there. |
| Review | Side panel (`capture-panel.js`) | Summary, editable fields, a tick list of people, and the full JSON. Nothing has been saved yet. |
| Save | `POST /api/v1/enrichment/ingest/{person,company,sales-search}` | The panel reports success only when the API returns a capture run with the terminal status `completed`; any other outcome is shown as a failure with its reason. |

Rules the code keeps (covered by `test/capture-*.test.js`):

- The extension never sets filters, submits a search, sends a message or connection request, or
  calls a hidden/private LinkedIn API. `linkedin-outreach.js` stays unwired.
- A Sales Navigator lead without a visible public link is saved as `sales-lead:<opaque-id>` with
  its `/sales/lead/…` URL. An `/in/` URL is never built from a lead id.
- Company people discovery is resumable: each reviewed batch commits a page cursor in
  `chrome.storage.local` (`company-people-capture:<company-id>`). **Pause** keeps the unsaved
  batch, **Stop** drops it; starting the capture again continues from the saved page.
- If LinkedIn renders a warning, verification or restriction during a capture
  (`capture/restriction-detect.js`), every reader stops, temporary tabs close, and the side
  panel shows a banner that must be acknowledged before another capture can start.
- The 10-page / 250-lead cap, the per-user daily limit and the workspace kill switch are
  enforced by the API as well. They are workload controls, not a LinkedIn safety guarantee.

Not ported from the prototype: the background queue that opened every discovered profile and
saved it without review. Full profile capture stays one reviewed profile at a time.

### Compliance review: inline page JSON in `linkedin-scrape.js`

The prototype's rule is rendered content only, with no hidden/private API access. Each read of
inline page JSON in the existing scraper was reviewed for ENR-02:

| Read (v0.8.3) | What it was | Decision |
| --- | --- | --- |
| `fieldsFromPageSource()`: regexes over `document.documentElement.innerHTML` for `firstName`/`lastName`, `headline`/`occupation`, `companyName`, `geoLocationName`/`locationName`, `summary` | LinkedIn's embedded API payloads (the data its own app boots from), not content shown to the user | **Replaced** with the rendered DOM readers that already existed (`nameFromDom`, `headlineFromDom`, `companyFromTopCard`/`parseTopExperience`, `locationFromDom`, `aboutFromDom`). A field that is not rendered is left empty. |
| `nameFromJsonLd()`: `<script type="application/ld+json">` | Inline structured-data JSON | **Removed.** The rendered `<h1>` is the source; the page title / Open Graph title remain as a name-only fallback. |
| `scrapeLinkedInCompany()`: `localizedName`/`name`, `websiteUrl`, `localizedIndustryName`/`industryName`, `staffCountRange`/`staffCount`, `description` from `innerHTML` | Embedded API payloads | **Replaced** with the rendered top card and About list (`h1`, website link, `Industry` / `Company size` rows, description block). |
| `nameFromOg()`, `nameFromDocumentTitle()` | Page metadata the browser itself displays (tab title, share title), not an API payload | **Kept** as a name-only fallback, the same allowance the prototype makes. |
| `nameFromUrl()`, `nameFromUrlVanity()` | Not inline JSON: a display name guessed from the URL slug | **Kept, unchanged** (out of scope here). The new capture path does not use it; it requires a rendered name. Worth removing in a follow-up. |

`test/capture-compliance.test.js` fails if `innerHTML`, JSON-LD or `JSON.parse` returns to
`linkedin-scrape.js`, or if any capture script gains a network call or a private-API reference.
