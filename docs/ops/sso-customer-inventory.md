# SSO customer inventory and communication plan (AUTH-ADI-22)

Ticket doc: "From ADI-01/ADI-03, list every workspace with an active SSO binding, its IdP
(Okta/Azure AD/Google Workspace), and contractual commitments. Draft the customer communication
and migration timeline per decision D1."

## Inventory (2026-09-23, from AUTH-ADI-01 and AUTH-ADI-03)

**Zero workspaces have an active SSO binding**, confirmed two independent ways:
1. **AUTH-ADI-01** (SkoutDev database, read-only): `workspace_sso_configs` has **0 rows**. The
   app's own SSO binding table has never had an entry.
2. **AUTH-ADI-03** (Clerk dashboard, 2026-09-23): **Organizations is not enabled** on the Clerk
   instance, and **SSO Connections lists only Google as a social sign-in provider** — no
   enterprise SAML/OIDC connection exists.

Both checks agree: no customer, past or present, has ever bound an IdP (Okta, Azure AD, Google
Workspace, or otherwise). There is no workspace with contractual SSO commitments to protect.

## What this means for the inventory table

The ticket doc's inventory table (workspace, IdP, contractual commitment) is empty by
construction — there is nothing to list. This is recorded here rather than left as a blank
template so the "zero" is a checked fact, not an unfilled task.

## Customer communication

**None needed.** The communication plan exists to warn active SSO customers before their IdP
binding changes. With zero active bindings, there is no customer whose access is at risk from
the own-auth migration on this axis.

## Feeds into: D1 (SSO/SCIM strategy, ADR-0007)

ADR-0007 already recorded this finding as a risk against D1 ("build in-house SSO/SCIM"): the
decision was kept despite showing zero current usage, on the basis of a business reason outside
what's visible in Clerk's config (see `docs/adr/0007-clerk-to-custom-auth.md`, Risks section).
This inventory is the formal confirmation that risk note was pointing at — re-read it before
`AUTH-BE-23`/`AUTH-BE-24` (an XL ticket) is scheduled, in case the business reason has since
changed or a customer signs an SSO requirement.

## Acceptance

- [x] Inventory complete — zero active SSO bindings, confirmed via two independent sources.
- [x] Each customer has a plan and a date — N/A, no customer is affected.
- [x] Communication sent before the customer's cutover — N/A, nothing to communicate.
