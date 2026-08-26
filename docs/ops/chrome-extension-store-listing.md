# §8.9 Chrome extension — store listing package

**Date:** 2026-08-26  
**Status:** Eng package **ready**; Chrome Web Store *publisher click* is optional ops.

## Artifacts (in repo)

| Item | Path |
|------|------|
| Store build (prod hosts) | `apps/chrome-extension/store-build/` |
| Packaged zip | `apps/chrome-extension/skout-extension-v0.8.1.zip` |
| Package script | `pnpm --filter @skout/chrome-extension package:store` |
| Prod API default | `https://ckoy6iywm0.execute-api.us-east-1.amazonaws.com` (SkoutDev = prod) |
| Prod web default | `https://www.skoutai.io` |

## Listing draft

| Field | Value |
|-------|--------|
| Name | Skout AI Prospector |
| Version | 0.8.1 (Manifest V3) |
| Short description | Capture LinkedIn profiles into Skout lists, enrich contacts, and support sequence outreach. |
| Permissions justification | `storage` settings; `activeTab`/`scripting` LinkedIn DOM capture; `sidePanel` UI; `tabs`/`webNavigation` profile detection; host perms for LinkedIn + Skout + API Gateway |
| Privacy | Extension only sends data to the configured Skout API after the user signs in; no sale of browsing data |
| Install path | Web Store **or** enterprise force-install / unpacked for internal |

## Closeout

§8.9 store-listing **engineering residual is closed**. Remaining action is Google account publisher submit (Product) when Marketing wants public listing — not a Neeraj PDF code blocker.
