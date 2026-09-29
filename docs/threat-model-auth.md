# Authentication Threat Model (STRIDE) — Skout AI Own-Auth

## Status
**Completed (2026-09-24) — AUTH-BE-18**. Input to the independent penetration test and security review gate in **AUTH-ADI-19**.

---

## 1. System Overview & Architecture

Skout AI is transitioning from vendor-hosted authentication (Clerk) to a self-hosted, sovereign authentication architecture per **ADR-0007** (Decision records D1–D7).

### Architecture Components
- **Web App / BFF (`apps/web` / Next.js)**: Front-door web application served at `www.skoutai.io/app`. Implements same-origin route handlers (`/api/auth/*`) managing HttpOnly, Secure, SameSite refresh cookies, and double-submit CSRF headers.
- **Core API (`apps/api` / Fastify)**: Authoritative resource and authentication API. Issues asymmetric RS256 JWT access tokens, validates credentials against PostgreSQL, and maintains session rotation in Redis/PostgreSQL.
- **CRM Service (`apps/crm` / Fastify)**: Internal and CRM workflow service. Validates access tokens via the shared `@skout/auth` verifier using published JWKS.
- **Chrome Extension (`apps/chrome-extension`)**: Browser extension interacting with the web app via a postMessage bridge (`window.__SKOUT_EXTENSION_BRIDGE__`) to receive access tokens for background CRM captures.
- **Persistence & Caching**: PostgreSQL (RDS) for users, identities, credentials, sessions, and audit events; Redis for distributed session revocation cache and IP brute-force sliding-window counters.

---

## 2. Asset Inventory

| Asset | Sensitivity | Storage / Transmission | Security Controls |
|---|---|---|---|
| **User Passwords** | Critical | Not stored plaintext; hashed with Argon2id ($m=65536, t=3, p=4$) in `user_credentials` | Constant-time comparison, no plaintext logging, OWASP password policy (length ≥ 10, top-N breached check) |
| **JWT Private Signing Keys** | Critical | Secrets Manager (`AUTH_JWT_PRIVATE_KEY`), injected as environment variables to API tasks only | CRM and Web receive only public JWKS (`AUTH_JWT_PUBLIC_KEY_SET`); redacted in logs and error dumps |
| **Refresh Tokens** | High | Never stored raw in DB; stored as SHA-256 hashes peppered with `AUTH_REFRESH_TOKEN_PEPPER` in `auth_refresh_tokens` | Single-use rotation on every refresh; immediate chain revocation on reuse detection; HttpOnly, Secure, SameSite cookie |
| **Session IDs & Lifecycle** | High | `auth_sessions` table + Redis revocation cache | Cryptographically random UUIDs; idle TTL (14 days), absolute TTL (60 days); immediate revocation on user block/password reset |
| **CSRF Tokens** | Medium | `skout_csrf` cookie + `x-csrf-token` header | High-entropy random tokens (24 bytes base64url); double-submit check on all cookie-based state-changing endpoints |
| **Step-Up Re-Auth Tokens** | High | `x-reauth-token` HTTP header (15-min TTL) | HMAC-SHA256 signed with `STEP_UP_SIGNING_SECRET`; binds to session `userId` and issue timestamp; validated by `assertStepUp` |
| **User Identity & Tenancy** | High | `users.id` (canonical UUID), `workspace_members`, `auth_identities` | Tenant-isolation query scopes, RBAC permission checks, email normalization (trimmed, lowercased) |

---

## 3. Trust Boundaries

```
[ Unstrusted Internet ]
          │
          ▼
┌─────────────────────────┐         ┌─────────────────────────┐
│ Browser (Client JS)     │ ◄──────►│ Chrome Extension        │
│ Memory: Access Token    │ (Bridge)│ Storage: Access Token   │
│ Cookies: Refresh + CSRF │         └─────────────────────────┘
└──────────┬──────────────┘
           │ HTTPS / Cookie / CSRF Header
           ▼ (Boundary 1)
┌─────────────────────────┐
│ Web Application (BFF)   │
│ /api/auth/* Handlers    │
└──────────┬──────────────┘
           │ HTTPS / Bearer Token
           ▼ (Boundary 2)
┌─────────────────────────────────────────────────────────────┐
│ Core API Service (Fastify)                                  │
│ - JWT Verification (RS256 JWKS)                             │
│ - Credential Hashing (Argon2id)                             │
│ - Lockout Defense (Redis IP counters + DB Account counters) │
└──────────┬───────────────────────────────┬──────────────────┘
           │ Private VPC                   │ Private VPC
           ▼ (Boundary 3)                  ▼ (Boundary 4)
┌─────────────────────────┐      ┌─────────────────────────┐
│ PostgreSQL RDS          │      │ Redis Cluster           │
│ - users, credentials    │      │ - IP rate-limit buckets │
│ - sessions, tokens      │      │ - Revocation cache      │
│ - auth_events (audit)   │      └─────────────────────────┘
└─────────────────────────┘
```

1. **Boundary 1 (Client ↔ Web BFF)**: Client browser JavaScript is untrusted. Refresh tokens are accessible only to the browser via `HttpOnly` cookies. State-changing requests must present matching `x-csrf-token` headers.
2. **Boundary 2 (Web BFF / Direct API Clients ↔ API Gateway)**: API receives short-lived (10-minute) Bearer JWTs. All claims are verified against trusted asymmetric JWKS.
3. **Boundary 3 (API ↔ Internal CRM)**: Internal microservice communication. CRM validates tokens using shared verifier and public keys; never possesses signing keys.
4. **Boundary 4 (API ↔ Persistence Layer)**: Secure VPC peering. Secrets and hashes are protected at rest; all queries parameterized through Drizzle ORM.

---

## 4. STRIDE Threat Analysis & Mitigations

### S — Spoofing Identity

| Threat ID | Threat Scenario | Impact | Mitigation in Code |
|---|---|---|---|
| **S-1** | **Algorithm Confusion (`alg: none`, `HS256`)**: Attacker submits an unsigned token or signs a JWT using HMAC with the server's public RSA key. | Complete auth bypass | `packages/auth/src/auth-mode.ts` & `apps/api/src/services/token.service.ts`: Enforces strict asymmetric RS256 algorithm allowlist. Rejects `none`, `HS256`, and unrecognized algorithms before key lookup. |
| **S-2** | **Key Injection / Unknown `kid`**: Attacker signs token with rogue key and specifies unknown or attacker-controlled `kid`. | Unauthorized token acceptance | `token.service.ts`: Verification looks up `kid` strictly in configured, internal `AUTH_JWT_PUBLIC_KEY_SET` (JWKS). If `kid` is missing or unknown, throws `AUTH_TOKEN_INVALID`. |
| **S-3** | **Issuer / Audience Spoofing**: Attacker presents a valid token minted for another service or staging environment. | Privilege escalation | `verifyAccessToken`: Explicitly validates `iss === config.AUTH_JWT_ISSUER` and `aud === config.AUTH_JWT_AUDIENCE`. |
| **S-4** | **Identity Impersonation via Unverified Identity**: Attacker signs up with an unverified third-party account matching an existing user's email. | Account takeover | **Ground Rule 5**: Account auto-linking is prohibited unless the identity provider reports `email_verified === true`. Email matching is strictly lowercased and trimmed. |
| **S-5** | **Step-Up Re-Authentication Forgery**: Attacker attempts privileged action (e.g. identity merge) without proving recent credential knowledge. | Unauthorized privileged action | `apps/api/src/routes/step-up.routes.ts` & `packages/auth/src/step-up.ts`: `assertStepUp` requires server-signed `x-reauth-token` (HMAC-SHA256 with `STEP_UP_SIGNING_SECRET`) matching `request.userId` with max 15-minute age. |

---

### T — Tampering with Data

| Threat ID | Threat Scenario | Impact | Mitigation in Code |
|---|---|---|---|
| **T-1** | **Refresh Token Theft & Reuse**: Attacker steals a refresh cookie and attempts to establish persistent sessions. | Session hijacking | `apps/api/src/services/session.service.ts` (`rotateRefreshToken`): Refresh tokens are single-use. If an already-used token is presented, the system detects reuse, immediately revokes the **entire session chain**, logs `refresh_reuse_detected`, and emits an alarm metric. |
| **T-2** | **Cross-Site Request Forgery (CSRF)**: Attacker lures user to malicious site that triggers background state changes (`/auth/refresh`, `/auth/logout`). | Unauthorized session state alteration | Double-submit CSRF pattern: `skout_refresh` is HttpOnly; `skout_csrf` is non-HttpOnly. Endpoints require `x-csrf-token` header matching the cookie value. Cross-origin scripts cannot read the cookie to set the header. |
| **T-3** | **OAuth State & PKCE Tampering**: Attacker intercepts or modifies Google OAuth callback code or state. | Auth flow hijacking | `google-auth.service.ts`: Enforces PKCE `code_challenge` / `code_verifier` with SHA-256, cryptographically signed `state` containing unique nonces, and single-use validation with short TTL. |
| **T-4** | **Token Payload Tampering**: Attacker modifies claims (e.g. changing `sub` to another user's UUID). | Session impersonation | Access tokens are digitally signed with RS256. Any modification to header or payload invalidates the signature and fails verification. |

---

### R — Repudiation

| Threat ID | Threat Scenario | Impact | Mitigation in Code |
|---|---|---|---|
| **R-1** | **Denial of Authenticated Actions**: User denies performing privileged operations or account changes. | Compliance / audit failure | Immutable audit logging in `auth_events` (login, signup, step-up, session revocation, token reuse) and `audit_logs` (tenancy, RBAC). Logs record user ID, IP prefix, user-agent hash, timestamp, and metadata. |
| **R-2** | **Untracked Secret Operations**: Privileged key rotations or administrative overrides performed without traces. | Security incident blindspot | `packages/auth/src/step-up.ts` (`recordPrivilegedAction`) logs privileged changes with before/after state snapshots. |

---

### I — Information Disclosure

| Threat ID | Threat Scenario | Impact | Mitigation in Code |
|---|---|---|---|
| **I-1** | **Account Enumeration via Timing / Status**: Attacker probes login/forgot-password endpoints to map registered user emails. | User reconnaissance | **Ground Rule 6**: `/auth/login` runs constant-time `verifyUnknownUser` comparison for non-existent emails, ensuring response times are indistinguishable from wrong passwords. Both return identical `401 AUTH_INVALID_CREDENTIALS` and generic text ("Invalid email or password."). `/auth/password/forgot` returns identical 200 responses. |
| **I-2** | **Credential & Token Leakage in Logs**: Sensitive secrets (passwords, JWT private keys, refresh tokens) dumped to application logs or APM. | Credential compromise | **Ground Rule 3**: `packages/observability/src/redact.ts` redacts `AUTH_JWT_PRIVATE_KEY`, `AUTH_REFRESH_TOKEN_PEPPER`, `CLERK_SECRET_KEY`, `password`, `refreshToken`, and auth headers from all loggers and exception reports. |
| **I-3** | **Open Redirect Vulnerability**: Attacker crafts malicious `next=` or redirect URLs to trick users into sending credentials to phishing origins. | Phishing / token theft | `packages/auth/src/safe-redirect.ts`: `sanitizeRedirectPath` rejects protocol-relative URLs (`//evil.com`), backslash bypasses (`\evil.com`), pseudo-protocols (`javascript:`), and non-whitelisted domains, falling back to `/dashboard`. |
| **I-4** | **Token Leakage via URLs / Referrers**: One-time verification tokens leaked via HTTP Referer headers. | Token interception | Recovery and verification routes enforce `Referrer-Policy: no-referrer`, and tokens are cleared from client browser history using `history.replaceState`. |

---

### D — Denial of Service

| Threat ID | Threat Scenario | Impact | Mitigation in Code |
|---|---|---|---|
| **D-1** | **Credential Stuffing / Password Brute-Force**: Distributed botnet attempts high-volume password guessing against user accounts. | Account compromise & DB saturation | **AUTH-BE-14**: Multi-tier lockout defense: per-IP sliding-window counter in Redis (`IP_FAILURE_THRESHOLD = 20` per 15 min), and per-account lockout (`ACCOUNT_FAILURE_THRESHOLD = 5` failures locks account for 5 minutes). Responses return `429 AUTH_RATE_LIMITED`. |
| **D-2** | **Argon2id Hash Exhaustion**: Attacker floods login with arbitrary requests to exhaust API server CPU and memory. | Service unavailability | Fastify route-level rate limiting (`max: 15, timeWindow: '1 minute'`) on `/auth/login` and `/auth/signup`. Request body sizes strictly limited via `REQUEST_BODY_LIMIT_BYTES`. |

---

### E — Elevation of Privilege

| Threat ID | Threat Scenario | Impact | Mitigation in Code |
|---|---|---|---|
| **E-1** | **Persistent Access for Deactivated/Blocked Users**: Blocked employee retains access until token expiration. | Unauthorized access | Immediate enforcement: User `status` and `isBlocked` flags are verified dynamically on token refresh, login, and step-up. Marking `isBlocked = true` revokes all active sessions immediately (`revokeAllSessionsForUser`). |
| **E-2** | **Session Fixation**: Attacker pre-creates a session ID and forces victim to authenticate under it. | Session hijacking | Pre-authentication state cannot dictate session identity. Successful login/signup/OAuth always generates a fresh cryptographic session UUID and refresh token. |
| **E-3** | **Cross-Tenant Escalation via Stale Token Claims**: Attacker modifies workspace ID or role inside a JWT. | Cross-tenant data access | Access tokens are deliberately minimal (`sub`, `sid`, `iss`, `aud`). Workspace memberships, roles, and permissions are **never baked into the token**; they are dynamically re-resolved from Postgres per request. |

---

## 5. Penetration Testing Guidance (AUTH-ADI-19 Input)

Recommended test cases for independent penetration testing:
1. **JWT Verification Attacks**: Submit tokens with `alg: none`, `alg: HS256` (signed with public key), expired `exp`, future `nbf`, missing `kid`, and arbitrary claims. Verify all return 401.
2. **Refresh Token Replay**: Obtain a valid refresh token, perform rotation, then replay the old token. Confirm immediate session revocation and that both old and new tokens become invalid.
3. **Brute Force & Lockout**: Execute 6 incorrect password attempts for a test account. Verify 5th/6th attempt triggers 429 and subsequent attempts with the correct password are also rejected while locked.
4. **Timing Attacks**: Measure response latency distributions for 100 requests with unknown emails vs 100 requests with wrong passwords on existing emails. Verify indistinguishable variance.
5. **CSRF Verification**: Craft cross-origin form POSTs to `/api/v1/auth/refresh` and `/api/v1/auth/logout` without matching `x-csrf-token`. Verify rejection with 403.
6. **Open Redirect**: Test parameter vectors on OAuth callbacks and redirects: `//attacker.com`, `\attacker.com`, `/\attacker.com`, `https://attacker.com`, `javascript:alert(1)`. Verify fallback to `/dashboard`.

