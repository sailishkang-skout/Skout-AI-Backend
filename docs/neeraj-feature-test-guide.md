# Skout AI — User testing guide (Neeraj completed features)

**How to use this document:** Sign in to Skout as a normal user (owner/admin preferred). Follow each section in order. For every step, mark **Pass** or **Fail** in the checkbox column (print this PDF and tick by hand, or copy into a sheet).

| | |
|--|--|
| **App** | https://www.skoutai.io/app |
| **API / gateway** | https://ckoy6iywm0.execute-api.us-east-1.amazonaws.com |
| **Who should test** | Product / QA / founder with a real workspace |
| **Date** | ________________ |
| **Tester name** | ________________ |

---

## Before you start

1. Open the app in Chrome.
2. Sign in with your Skout account (Clerk).
3. Confirm you land on the dashboard (no blank error page).
4. Keep this PDF open and tick each step as you go.

**Pass criteria for the whole guide:** Every *user* step in sections 1–15 is Pass (or marked N/A with a reason). External leftovers at the end are optional.

---

## 1. Sign-in & home (smoke)

| # | What you do | What you should see | ☐ |
|---|-------------|---------------------|---|
| 1.1 | Go to the app URL and sign in | Dashboard / home loads | |
| 1.2 | Click your profile / workspace name in the sidebar | Your workspace is shown | |
| 1.3 | Refresh the page | You stay signed in | |

---

## 2. Onboarding (§8.1)

| # | What you do | What you should see | ☐ |
|---|-------------|---------------------|---|
| 2.1 | Open **Onboarding** from the sidebar (or `/onboarding`) | Setup wizard / ICP questions appear | |
| 2.2 | Fill company / ICP basics and continue | Progress saves; you can finish or skip to the app | |
| 2.3 | After finishing, open Discover or TAM | App works with your workspace settings | |

---

## 3. Discover / TAM / search (§8.2)

| # | What you do | What you should see | ☐ |
|---|-------------|---------------------|---|
| 3.1 | Open **TAM** or **Prospect search** | Search page loads (results or empty state OK) | |
| 3.2 | Enter a company / title / filter and search | Results list appears, or a clear “no results” | |
| 3.3 | Add one prospect to a list | Prospect shows in that list | |

---

## 4. Enrichment workbooks (§8.3)

| # | What you do | What you should see | ☐ |
|---|-------------|---------------------|---|
| 4.1 | Open **Enrichment → Workbooks** | Workbook list page | |
| 4.2 | Create a new workbook and save | It appears in the list | |
| 4.3 | Activate it and start a run | Run status moves (queued → running → done/failed) | |
| 4.4 | Open the run | You can see rows / progress / errors | |

---

## 5. Account & Person 360 (§8.4)

| # | What you do | What you should see | ☐ |
|---|-------------|---------------------|---|
| 5.1 | Open **CRM** and pick any company (or copy its ID) | Company detail exists | |
| 5.2 | Open **Account 360** (`/crm/360`) and load that company | One screen with deals, activity, signals (or empty sections) | |
| 5.3 | Switch to **Person** mode and load a contact | Person 360 shows contact-centric view | |

---

## 6. Signals (§8.5)

| # | What you do | What you should see | ☐ |
|---|-------------|---------------------|---|
| 6.1 | Open **Signals** | Feed or empty state (no crash) | |
| 6.2 | Open one signal if any exist | Detail view opens | |

---

## 7. Sequences (§8.6)

| # | What you do | What you should see | ☐ |
|---|-------------|---------------------|---|
| 7.1 | Open **Sequences** | Sequence list | |
| 7.2 | Create a sequence with at least one email/step | Sequence saves | |
| 7.3 | Enroll a contact/prospect | Enrollment shows as active / pending | |
| 7.4 | Check sequence analytics or enrollments | Counts update | |

---

## 8. Dexter & Policy Gateway (§8.7)

| # | What you do | What you should see | ☐ |
|---|-------------|---------------------|---|
| 8.1 | Open **Settings → Automation policy** (Policy Gateway) | Modes like ask / auto / draft / approve | |
| 8.2 | Change one action’s mode and save | Setting sticks after refresh | |
| 8.3 | Open **Dexter** (`/dexter`) | Orchestrator page loads | |
| 8.4 | Propose / create a GTM plan | Plan appears as pending approval | |
| 8.5 | Approve the plan, then invoke | Invoke works after approve (blocked before) | |
| 8.6 | Record a learning / outcome if shown | Outcome saved on the plan | |
| 8.7 | Open the floating **AI chat** button | Chat opens; ask “What should I do next?” and get a reply | |

---

## 9. Decisions (§10)

| # | What you do | What you should see | ☐ |
|---|-------------|---------------------|---|
| 9.1 | Open **Decisions** (`/decisions`) | Decision queue page | |
| 9.2 | Create a decision from next-best-action (or UI create) | New item in the queue | |
| 9.3 | Choose an option or dismiss | Status updates; item leaves open queue | |

---

## 10. Workflows (§8.14)

| # | What you do | What you should see | ☐ |
|---|-------------|---------------------|---|
| 10.1 | Open **Workflows** (`/workflows`) | Workflow Studio / runs list | |
| 10.2 | Start a run (enrich/score style if available) | Run appears as running | |
| 10.3 | Wait until complete (or mark complete if UI allows) | Run shows completed | |

---

## 11. LinkedIn (§8.8)

| # | What you do | What you should see | ☐ |
|---|-------------|---------------------|---|
| 11.1 | Open Deliverability / **LinkedIn** connect | Connect screen or account list | |
| 11.2 | Connect a LinkedIn account (Unipile) if prompted | Account shows as connected / active | |
| 11.3 | Add a LinkedIn step to a sequence and enroll someone | Job queued/sent, or a clear “not configured” message | |

---

## 12. Chrome extension (§8.9)

| # | What you do | What you should see | ☐ |
|---|-------------|---------------------|---|
| 12.1 | Install the Skout extension (unpacked `store-build` or zip from the team) | Extension appears in Chrome | |
| 12.2 | Sign in to Skout in the same browser → open side panel → Connect | Shows you as signed in | |
| 12.3 | Open a LinkedIn profile → **Add to list** | Contact appears in your Skout list | |

---

## 13. Email intelligence & Warm-Up (§8.10)

| # | What you do | What you should see | ☐ |
|---|-------------|---------------------|---|
| 13.1 | Open **Intelligence → Email** | Verify / discover UI | |
| 13.2 | Verify a real email address | Result with status (valid / risky / etc.) | |
| 13.3 | Open **Warm-Up** | Page loads (Google/Microsoft connect may still be blocked until OAuth apps are ready) | |

---

## 14. Calling (§8.11)

| # | What you do | What you should see | ☐ |
|---|-------------|---------------------|---|
| 14.1 | Open **Settings → Calling** | Calling settings page | |
| 14.2 | Open a contact with a phone number → click **Call** | Call starts **or** a clear “calling not configured” message | |

---

## 15. CRM Intelligence & HubSpot (§8.12)

| # | What you do | What you should see | ☐ |
|---|-------------|---------------------|---|
| 15.1 | Open **CRM → Intelligence** | Intelligence views load | |
| 15.2 | Connect HubSpot if your workspace uses it | Connection shows as linked | |
| 15.3 | Run sync / import if the button exists | Progress or success summary | |

---

## 16. CRO / reporting (§8.15 / §8.13)

| # | What you do | What you should see | ☐ |
|---|-------------|---------------------|---|
| 16.1 | Open **Admin → CRO** (or reporting) | Charts / forecasts or empty states | |
| 16.2 | Ask Dexter chat something about pipeline | Sensible reply (not a blank error) | |

---

## 17. Competitive win/loss (§2) — for GTM

| # | What you do | What you should see | ☐ |
|---|-------------|---------------------|---|
| 17.1 | Open competitive / win-loss entry (CRM or API-backed UI) | Form or list to add deals | |
| 17.2 | Add a won or lost deal (competitor, reason, region) | Deal saves and appears in the list | |
| 17.3 | Add until you have **4+ real deals** (GTM goal) | Regional TAM unlocks when gate is met | |

---

## 18. Team & security (as a user) (§11.1)

| # | What you do | What you should see | ☐ |
|---|-------------|---------------------|---|
| 18.1 | As **owner**, open Team / invites and invite a teammate | Invite sends / shows as pending | |
| 18.2 | As a **member** (or second account), try an admin-only action | Access denied / blocked — not a server crash | |
| 18.3 | Confirm you only see **your workspace’s** data | No other company’s contacts | |

---

## Optional / external (do not block Pass)

| Item | Notes | ☐ |
|------|-------|---|
| Warm-Up Google / Microsoft connect | Needs Sailesh OAuth apps | |
| Chrome Web Store public listing | Package ready; publisher submit optional | |
| Customer SSO (Okta etc.) | Done in Clerk at deal time | |
| Telnyx number buy / KYC | Done in Telnyx Mission Control, not in Skout | |

---

## Sign-off

| | |
|--|--|
| Overall result | ☐ Pass ☐ Fail ☐ Partial |
| Tester | ________________ |
| Date | ________________ |
| Notes | ________________ |

---

*Skout AI · Neeraj completed features · User testing guide · 2026-08-26*
