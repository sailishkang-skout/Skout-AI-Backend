# SSO / SAML / SCIM Stage-6 checklist

ADR: `docs/adr/0006-sso-scim-stage-6.md`

## Confirm before execute (you / leadership)
- [x] (a) Clerk plan includes Organization SSO + SCIM — **confirmed 2026-08-25** (Clerk Enterprise includes both)
- [ ] (b) First customer IdP named: _______________ (Okta / Azure AD / Google)
- [ ] (c) Group → role map: IdP groups → Skout `owner` / `admin` / `member`

## Then engineering executes
1. Enable Clerk Org SSO for pilot org  
2. Exchange IdP metadata  
3. Enable SCIM; sync into `users` / `workspace_members` / `workspace_member_roles`  
4. `backfill-rbac` after first sync  
5. E2E: IdP user → workspace role → access revoked on disable  

**Until (a)(b)(c) confirmed, SSO remains Stage-6 — not claimable as done.**
