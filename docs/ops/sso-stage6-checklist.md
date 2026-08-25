# SSO / SAML / SCIM Stage-6 checklist

ADR: `docs/adr/0006-sso-scim-stage-6.md`

## Confirm before execute (you / leadership)
- [x] (a) Clerk plan includes Organization SSO + SCIM — **confirmed 2026-08-25** (Clerk Enterprise includes both)
- [x] (b) First IdP path — **platform default activated 2026-08-26**: bind via Clerk Dashboard → Organizations → SSO. Pilot IdP = whatever the first enterprise customer uses (Okta / Azure AD / Google Workspace). No code gate remains.
- [x] (c) Default group → role map (Skout):

| IdP group (convention) | Skout role |
|------------------------|------------|
| `skout-owners` / `Owners` | `owner` |
| `skout-admins` / `Admins` | `admin` |
| `skout-members` / `Members` (default) | `member` |

Override per customer in Clerk when their IT provides different group names.

## Then engineering executes (per customer org)
1. Enable Clerk Org SSO for pilot org  
2. Exchange IdP metadata  
3. Enable SCIM; sync into `users` / `workspace_members` / `workspace_member_roles`  
4. `./scripts/ecs-run-backfill-rbac.sh SkoutDev` (or SkoutProd) after first sync  
5. E2E: IdP user → workspace role → access revoked on disable  

**Platform gate removed 2026-08-26** — defaults published; customer IdP bind is Clerk Dashboard work at deal time, not a code/deploy blocker.
