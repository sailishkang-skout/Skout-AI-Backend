# Auth, Login & User Provisioning (Clerk)

> Onboarding guide for developers implementing sign-in, first-login provisioning, and workspace tenancy.
> Last updated: **2026-06-11**

Related: [mvp-flows.md §1 User Authentication](./mvp-flows.md#1-user-authentication) · [database-schema.md](./database-schema.md) · [secrets-setup.md § Clerk](./secrets-setup.md#3-prefixclerk)

---

## Quick summary

| Question | Answer |
|----------|--------|
| Who handles passwords / OAuth? | **Clerk** (not our API) |
| Who stores the user record for the app? | **PostgreSQL** (`users`, `workspace_members`, …) |
| When is a Skout user created? | On **first authenticated API call** after Clerk sign-up (lazy provisioning) |
| How does the API know which workspace to use? | `workspace_members` join table → `request.workspaceId` |
| What do new workspaces get? | **500 credits** + empty `workspace_icp` (filled in onboarding) |
| Where does each column value come from? | See **[§5.0 Where input values come from](#50-where-input-values-come-from)** |

### Implementation status

| Component | Status |
|-----------|--------|
| Clerk secrets in AWS (`{Prefix}/clerk`) | ✅ CDK placeholder |
| DB tables (`users`, `workspaces`, …) | ✅ Migrated |
| Clerk in Next.js (`ClerkProvider`, `/sign-in`) | 
| JWT validation on Fastify API | 
| Lazy provisioning on first JWT | 
| **Current MVP stub** | `X-Workspace-Id` header → demo workspace `00000000-0000-4000-8000-000000000001` |

Code today: `apps/api/src/plugins/workspace-context.ts` (stub), `packages/db/src/seed.ts` (demo workspace).

---

## Actors & services

```mermaid
flowchart LR
    U[User Browser]
    FE[Next.js Frontend]
    C[Clerk]
    API[Fastify API]
    PG[(PostgreSQL)]

    U --> FE
    FE <-->|OAuth / session| C
    FE -->|Bearer JWT| API
    API -->|JWKS verify| C
    API --> PG
```

| Service | Repo path | Responsibility |
|---------|-----------|----------------|
| Frontend | `Skout Ai Frontend` | Sign-in UI, session, attach JWT to API calls |
| Clerk | External (SaaS) | Identity, OAuth, sessions, JWT issuance |
| API | `apps/api` | Verify JWT, provision user, scope all data by `workspace_id` |
| PostgreSQL | `packages/db` | App-owned user + workspace + credits + ICP |

---

## 1. Combined login & sign-up flow

```mermaid
flowchart TD
    A[User opens app URL] --> B{Clerk session exists?}

    B -->|No| C["/sign-in (Clerk UI)"]
    C --> D[Auth method]
    D --> D1[Google OAuth]
    D --> D2[Email + password]
    D --> D3[Magic link]

    D1 --> E[Clerk authenticates]
    D2 --> E
    D3 --> E

    E --> F{Clerk account exists?}
    F -->|New| G[Clerk creates user]
    F -->|Returning| H[Clerk loads user]

    G --> I[Session + JWT]
    H --> I

    I --> J[Frontend: API call with Bearer JWT]
    J --> K{User in PostgreSQL?}

    K -->|No| L[Provision workspace bundle]
    K -->|Yes| M[Load workspace_members]

    L --> N{workspace_icp empty?}
    M --> N

    N -->|Yes| O["/onboarding/icp"]
    N -->|No| P["/prospects/search"]

    B -->|Yes| Q[getToken] --> J
    O --> P
```

---

## 2. Returning user — login (step by step)

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant FE as Next.js
    participant C as Clerk
    participant API as Fastify API
    participant PG as PostgreSQL

    U->>FE: Open protected route
    FE->>C: getSession()
    alt No session
        C-->>FE: null
        FE->>U: Redirect /sign-in
        U->>C: Google / email login
        C-->>FE: Session cookie
    end

    FE->>C: getToken()
    C-->>FE: JWT (short-lived)

    FE->>API: GET /api/v1/workspaces<br/>Authorization: Bearer {JWT}
    API->>C: Verify JWT via JWKS
    C-->>API: sub, email, name

    API->>PG: SELECT * FROM users WHERE email = ?
    PG-->>API: user row

    API->>PG: SELECT * FROM workspace_members WHERE user_id = ?
    PG-->>API: workspace_id, role

    API->>API: request.userId, request.workspaceId, request.role
    API-->>FE: Workspace + credits
    FE->>U: Dashboard
```

| Step | Actor | Action |
|------|-------|--------|
| 1 | User | Visits app |
| 2 | Frontend | Clerk middleware checks session on `(dashboard)/*` routes |
| 3 | User | Signs in at `/sign-in` if needed |
| 4 | Clerk | Issues HttpOnly session + JWT |
| 5 | Frontend | Calls `getToken()` and sends `Authorization: Bearer …` |
| 6 | API | Validates JWT with Clerk public keys (JWKS) |
| 7 | API | Resolves `users.id` and `workspace_id` from PostgreSQL |
| 8 | API | Runs handler with tenant scope |
| 9 | Frontend | Renders app shell (sidebar, credit badge) |

---

## 3. New user — creation & provisioning (step by step)

Clerk creates the **identity** immediately on sign-up. Skout creates **app data** on the first API request.

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant FE as Next.js
    participant C as Clerk
    participant API as Fastify API
    participant PG as PostgreSQL

    U->>FE: Sign up (Google / email)
    FE->>C: signUp / OAuth
    C->>C: INSERT Clerk user (external)
    C-->>FE: Session + JWT

    FE->>API: First API call + Bearer JWT
    API->>C: Verify JWT
    C-->>API: sub, email, full_name

    API->>PG: SELECT id FROM users WHERE email = ?
    PG-->>API: NULL

    Note over API,PG: BEGIN TRANSACTION

    API->>PG: INSERT workspaces (name, slug)
    API->>PG: INSERT users (email, full_name)
    API->>PG: INSERT workspace_members (role = owner)
    API->>PG: INSERT credit_balances (balance = 500)
    API->>PG: INSERT credit_transactions (action = provision, +500)

    Note over API,PG: COMMIT

    API-->>FE: 200 + workspace

    FE->>API: GET /api/v1/icp
    PG-->>API: no row / empty config
    FE->>U: Redirect /onboarding/icp

    U->>FE: Submit ICP wizard
    FE->>API: PUT /api/v1/icp { config }
    API->>PG: UPSERT workspace_icp
    FE->>U: /prospects/search
```

### What Clerk owns vs what PostgreSQL owns

| Data | Stored in | Example |
|------|-----------|---------|
| Password hash, OAuth tokens | **Clerk** | Never in our DB |
| Clerk user ID (`sub` in JWT) | **Clerk** → map in our DB (see note below) | `user_2abc…` |
| Email, display name | **Both** (Clerk source of truth; copy to `users`) | `jane@acme.com` |
| Workspace, role, credits, ICP | **PostgreSQL only** | Skout app state |

> **Recommended schema addition (Sprint 1):** add `users.clerk_id TEXT UNIQUE` to link JWT `sub` → `users.id` without relying on email alone. Not in schema yet — provision by email for now.

---

## 4. Authenticated request pipeline (every API call)

```mermaid
flowchart TD
    A[Frontend apiFetch] --> B[Clerk getToken]
    B --> C[Authorization: Bearer JWT]
    C --> D[Fastify auth preHandler]

    D --> E{JWT valid?}
    E -->|No| F[401 Unauthorized]
    E -->|Yes| G[Parse sub, email from claims]

    G --> H[Lookup users + workspace_members]
    H --> I{Found?}
    I -->|No| J[403 or run provision]
    I -->|Yes| K[Set request context]

    K --> L["request.userId<br/>request.workspaceId<br/>request.role"]
    L --> M[Credit guard if billable action]
    M --> N[Route handler]
    N --> O[Response]
```

**Public (no JWT):** `GET /api/v1/health` only.

**Protected:** all other `/api/v1/*` routes.

---

## 5. Database tables involved in auth & onboarding

Only **five tables** are written during sign-up / first login. They form the tenancy core.

```mermaid
erDiagram
    workspaces ||--o{ workspace_members : has
    users ||--o{ workspace_members : belongs_to
    workspaces ||--|| credit_balances : has
    workspaces ||--o{ credit_transactions : logs
    workspaces ||--o| workspace_icp : configures

    workspaces {
        uuid id PK
        text name
        text slug UK
        timestamptz created_at
        timestamptz updated_at
    }

    users {
        uuid id PK
        text email UK
        text full_name
        timestamptz created_at
        timestamptz updated_at
    }

    workspace_members {
        uuid workspace_id PK_FK
        uuid user_id PK_FK
        text role
        timestamptz joined_at
    }

    credit_balances {
        uuid workspace_id PK_FK
        integer balance
        timestamptz updated_at
    }

    credit_transactions {
        uuid id PK
        uuid workspace_id FK
        integer amount
        text action
        text reference_id
        timestamptz created_at
    }

    workspace_icp {
        uuid workspace_id PK_FK
        jsonb config
        integer version
        timestamptz updated_at
    }
```

---

## 5.0 Where input values come from

Every column in the auth/onboarding tables is filled from one of these **sources**. Use this section when implementing provisioning or debugging “where did this value come from?”

| Source code | Meaning |
|-------------|---------|
| **Clerk JWT** | Parsed from the verified Bearer token after sign-in |
| **Clerk profile** | User object from Clerk SDK (`user.emailAddresses`, `user.fullName`, …) |
| **System auto** | Generated by our API (UUID, slug, timestamps, defaults) |
| **App constant** | Hard-coded product rule (e.g. 500 credits, `role = owner`) |
| **User form** | Typed or selected in the UI (onboarding wizard, settings) |
| **Seed script** | Local dev only — `packages/db/src/seed.ts` |
| **Env var** | `.env` / `.env.local` for stub workspace ID |
| **Prior DB row** | FK copied from another table we just inserted |

### Clerk JWT — claims we read

After `Authorization: Bearer {token}` is verified, the API reads:

| JWT claim | Example | Maps to DB column |
|-----------|---------|-------------------|
| `sub` | `user_2nX9kL…` | *(future)* `users.clerk_id` — not in schema yet |
| `email` (or primary email claim) | `jane@acme.com` | `users.email` |
| `name` / `given_name` + `family_name` | `Jane Smith` | `users.full_name` |
| `iss`, `exp`, `iat` | — | Not stored; used for validation only |

**Where to see these in dev:**

- [Clerk Dashboard](https://dashboard.clerk.com) → **Users** → pick a user → see email, name, user ID (`sub`)
- Browser devtools → Network → any request to Clerk → session / user payload
- Backend (once wired): log decoded JWT in auth middleware

### Master field map (all auth tables)

| Table | Column | Input source | How / when set |
|-------|--------|--------------|----------------|
| **workspaces** | `id` | System auto | `gen_random_uuid()` on INSERT during first-login provision |
| **workspaces** | `name` | System auto *(sign-up)* / **User form** *(settings)* | Sign-up: derived from Clerk name or email, e.g. `"Jane's Workspace"`. Settings: user edits via `PATCH /api/v1/workspaces/current` |
| **workspaces** | `slug` | System auto | Derived from email local-part or workspace name (lowercase, hyphenated). Must be unique |
| **workspaces** | `created_at`, `updated_at` | System auto | PostgreSQL `now()` |
| **users** | `id` | System auto | `gen_random_uuid()` on first provision |
| **users** | `email` | **Clerk JWT** | `email` claim — must match Clerk account |
| **users** | `full_name` | **Clerk JWT / profile** | OAuth display name or sign-up form |
| **users** | `created_at`, `updated_at` | System auto | PostgreSQL `now()` |
| **workspace_members** | `workspace_id` | **Prior DB row** | FK → `workspaces.id` just created (or invite target workspace) |
| **workspace_members** | `user_id` | **Prior DB row** | FK → `users.id` just created |
| **workspace_members** | `role` | **App constant** | Self-serve sign-up: always `"owner"`. Invite: `"member"` or `"admin"` |
| **workspace_members** | `joined_at` | System auto | PostgreSQL `now()` |
| **credit_balances** | `workspace_id` | **Prior DB row** | Same as new `workspaces.id` |
| **credit_balances** | `balance` | **App constant** *(provision)* / **System auto** *(usage)* | Initial: `500`. Later: decremented by enrichment/search services |
| **credit_balances** | `updated_at` | System auto | Updated whenever balance changes |
| **credit_transactions** | `id` | System auto | `gen_random_uuid()` |
| **credit_transactions** | `workspace_id` | **Prior DB row** | FK → `workspaces.id` |
| **credit_transactions** | `amount` | **App constant** or **System auto** | Provision: `+500`. Spend: negative, e.g. `-1` for search |
| **credit_transactions** | `action` | **App constant** / **System auto** | e.g. `provision`, `search`, `enrich`, `export` — set by calling service |
| **credit_transactions** | `reference_id` | **System auto** | Optional job/prospect/list UUID from the action that spent credits |
| **credit_transactions** | `created_at` | System auto | PostgreSQL `now()` |
| **workspace_icp** | `workspace_id` | **Prior DB row** | FK → `workspaces.id` |
| **workspace_icp** | `config` | **User form** | ICP onboarding wizard or `PUT /api/v1/icp` — see JSON shape in §5.6 |
| **workspace_icp** | `version` | System auto | Starts at `1`; incremented on each `PUT` |
| **workspace_icp** | `updated_at` | System auto | PostgreSQL `now()` on upsert |

### Values by lifecycle event

```mermaid
flowchart LR
    subgraph SignUp["First sign-up (Clerk + provision)"]
        C1[Clerk JWT email + name]
        C1 --> U[users]
        C1 --> W[workspaces name/slug]
        W --> WM[workspace_members owner]
        W --> CB[credit_balances 500]
        W --> CT[credit_transactions provision]
    end

    subgraph Onboard["Onboarding wizard"]
        F1[User selects industries geo size]
        F1 --> ICP[workspace_icp.config]
    end

    subgraph Settings["Workspace settings later"]
        F2[User edits workspace name]
        F2 --> W2[workspaces.name + slug]
    end

    subgraph Usage["Product usage"]
        A1[Search / enrich / export]
        A1 --> CB2[credit_balances.balance -= n]
        A1 --> CT2[credit_transactions ledger row]
    end
```

### `workspace_icp.config` — where each JSON field comes from

Filled by the user in the **3-step ICP onboarding wizard** (`/onboarding/icp`) or later via **Settings → ICP** (`PUT /api/v1/icp`).

| JSON field | UI control (onboarding) | Example value | Used by |
|------------|----------------------|---------------|---------|
| `industries` | Multi-select / chips | `["Software", "SaaS"]` | AI ICP scoring, search defaults |
| `countries` | Country picker | `["US", "CA"]` | AI ICP scoring |
| `seniorities` | Checkbox list | `["vp", "director", "c_level"]` | AI ICP scoring |
| `minEmployees` | Number input | `50` | AI ICP scoring |
| `maxEmployees` | Number input | `5000` | AI ICP scoring |

API handler: `apps/api/src/services/icp.service.ts` → `setWorkspaceIcp()`.

### How to get / inspect values in local dev (today)

#### A. Demo workspace (no Clerk yet)

| What you need | Where to get it |
|---------------|-----------------|
| `workspace_id` | `.env` / `.env.local`: `NEXT_PUBLIC_WORKSPACE_ID=00000000-0000-4000-8000-000000000001` |
| Same ID on API | Default in `apps/api/src/plugins/workspace-context.ts` if header omitted |
| Seed data | Run `pnpm --filter @skout/db seed` — creates workspace, 500 credits, demo list |
| Send on API calls | Header: `X-Workspace-Id: 00000000-0000-4000-8000-000000000001` |

#### B. PostgreSQL (any environment)

```sql
-- Workspace + credits for a tenant
SELECT w.id, w.name, w.slug, cb.balance
FROM workspaces w
LEFT JOIN credit_balances cb ON cb.workspace_id = w.id
WHERE w.slug = 'demo';

-- User ↔ workspace membership
SELECT u.email, u.full_name, wm.role, w.name AS workspace
FROM users u
JOIN workspace_members wm ON wm.user_id = u.id
JOIN workspaces w ON w.id = wm.workspace_id;

-- ICP config
SELECT workspace_id, config, version FROM workspace_icp;

-- Credit ledger
SELECT action, amount, reference_id, created_at
FROM credit_transactions
ORDER BY created_at DESC
LIMIT 20;
```

Connect locally: `DATABASE_URL=postgresql://skout:skout@localhost:5432/skout`

#### C. API endpoints (once auth is wired)

| Need | Endpoint | Returns |
|------|----------|---------|
| Current workspace | `GET /api/v1/workspaces` or `GET /api/v1/workspaces/current` | `id`, `name`, `slug` |
| Credit balance | `GET /api/v1/enrichment/credits` | `{ balance }` |
| ICP config | `GET /api/v1/icp` | `{ config, version }` |
| Save ICP | `PUT /api/v1/icp` | Body: `{ industries, countries, … }` |
| Rename workspace | `PATCH /api/v1/workspaces/current` | Body: `{ name }` → updates `name` + `slug` |

#### D. Clerk Dashboard (identity only)

| Need | Where |
|------|-------|
| Test user email / name | Clerk Dashboard → **Users** |
| Publishable + secret keys | Clerk Dashboard → **API Keys** → copy to `.env` |
| OAuth redirect URLs | Clerk Dashboard → **Paths** / **Domains** |

Clerk does **not** store Skout `workspace_id`, credits, or ICP — those exist only in PostgreSQL.

### Product constants (do not change without product sign-off)

| Constant | Value | Used in |
|----------|-------|---------|
| Initial credit grant | `500` | `credit_balances.balance`, `credit_transactions` on provision |
| Self-serve role | `owner` | `workspace_members.role` |
| Default member role | `member` | Invited users (future) |
| Demo workspace UUID | `00000000-0000-4000-8000-000000000001` | Seed + local stub |
| Phone enrich score gate | `80` | PAL (separate from auth; see enrichment docs) |

---

### 5.1 `workspaces`

The tenant container. Every list, enrichment job, and credit balance belongs to one workspace.

| Column | Type | Nullable | Default | Input source | Notes |
|--------|------|----------|---------|--------------|-------|
| `id` | `uuid` | NO | `gen_random_uuid()` | **System auto** | Primary key |
| `name` | `text` | NO | — | **System auto** (sign-up) / **User form** (settings) | e.g. `"Acme Corp"` |
| `slug` | `text` | NO | — | **System auto** | Derived from name/email; must be unique |
| `created_at` | `timestamptz` | NO | `now()` | **System auto** | |
| `updated_at` | `timestamptz` | NO | `now()` | **System auto** | |

**Constraints:** `UNIQUE (slug)`

**Drizzle:** `packages/db/src/schema/workspaces.ts`

**Example row (after sign-up):**

```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "name": "Jane's Workspace",
  "slug": "jane-acme-com",
  "created_at": "2026-06-11T10:00:00Z",
  "updated_at": "2026-06-11T10:00:00Z"
}
```

---

### 5.2 `users`

App user profile. Created on first login; email must match Clerk.

| Column | Type | Nullable | Default | Input source | Notes |
|--------|------|----------|---------|--------------|-------|
| `id` | `uuid` | NO | `gen_random_uuid()` | **System auto** | Primary key (Skout internal ID) |
| `email` | `text` | NO | — | **Clerk JWT** | From `email` claim; **unique** |
| `full_name` | `text` | YES | — | **Clerk JWT / profile** | OAuth name or sign-up form |
| `created_at` | `timestamptz` | NO | `now()` | **System auto** | |
| `updated_at` | `timestamptz` | NO | `now()` | **System auto** | |

**Constraints:** `UNIQUE (email)`

**Drizzle:** `packages/db/src/schema/users.ts`

**Example row:**

```json
{
  "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "email": "jane@acme.com",
  "full_name": "Jane Smith",
  "created_at": "2026-06-11T10:00:00Z",
  "updated_at": "2026-06-11T10:00:00Z"
}
```

---

### 5.3 `workspace_members`

Many-to-many join: which users belong to which workspace, and their role.

| Column | Type | Nullable | Default | Input source | Notes |
|--------|------|----------|---------|--------------|-------|
| `workspace_id` | `uuid` | NO | — | **Prior DB row** | FK → `workspaces.id` |
| `user_id` | `uuid` | NO | — | **Prior DB row** | FK → `users.id` |
| `role` | `text` | NO | `'member'` | **App constant** | Sign-up: `"owner"`. Invite: `"member"` / `"admin"` |
| `joined_at` | `timestamptz` | NO | `now()` | **System auto** | |

**Primary key:** `(workspace_id, user_id)`

**Drizzle:** `packages/db/src/schema/users.ts` (`workspaceMembers`)

**Role values (MVP):**

| Role | Permissions |
|------|-------------|
| `owner` | Full access; assigned on self-serve sign-up |
| `admin` | Settings, invites, billing (future) |
| `member` | Use product; no workspace admin |

**Example row (new sign-up):**

```json
{
  "workspace_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "user_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "role": "owner",
  "joined_at": "2026-06-11T10:00:00Z"
}
```

---

### 5.4 `credit_balances`

One row per workspace. Shown in the top bar; decremented on search/enrich actions.

| Column | Type | Nullable | Default | Input source | Notes |
|--------|------|----------|---------|--------------|-------|
| `workspace_id` | `uuid` | NO | — | **Prior DB row** | PK + FK → `workspaces.id` |
| `balance` | `integer` | NO | `0` | **App constant** (500 on provision) / **System auto** (decrement on use) | Current credit count |
| `updated_at` | `timestamptz` | NO | `now()` | **System auto** | On every balance change |

**Drizzle:** `packages/db/src/schema/credits.ts`

**Beta default on provision:** `500` credits

**Example row:**

```json
{
  "workspace_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "balance": 500,
  "updated_at": "2026-06-11T10:00:00Z"
}
```

---

### 5.5 `credit_transactions`

Append-only ledger for every credit change (audit + usage history page).

| Column | Type | Nullable | Default | Input source | Notes |
|--------|------|----------|---------|--------------|-------|
| `id` | `uuid` | NO | `gen_random_uuid()` | **System auto** | Primary key |
| `workspace_id` | `uuid` | NO | — | **Prior DB row** | FK → `workspaces.id` |
| `amount` | `integer` | NO | — | **App constant** or **System auto** | `+500` provision; negative on spend |
| `action` | `text` | NO | — | **System auto** | Set by service: `provision`, `search`, `enrich`, … |
| `reference_id` | `text` | YES | — | **System auto** | Optional job/prospect/list ID |
| `created_at` | `timestamptz` | NO | `now()` | **System auto** | |

**Drizzle:** `packages/db/src/schema/credits.ts`

**Example row (sign-up grant):**

```json
{
  "id": "8f14e45f-ceea-467a-9a5d-6ce3f954b7df",
  "workspace_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "amount": 500,
  "action": "provision",
  "reference_id": null,
  "created_at": "2026-06-11T10:00:00Z"
}
```

---

### 5.6 `workspace_icp`

Ideal Customer Profile for AI scoring and search defaults. Filled during onboarding wizard.

| Column | Type | Nullable | Default | Input source | Notes |
|--------|------|----------|---------|--------------|-------|
| `workspace_id` | `uuid` | NO | — | **Prior DB row** | PK + FK → `workspaces.id` |
| `config` | `jsonb` | NO | `'{}'` | **User form** | ICP wizard / `PUT /api/v1/icp` |
| `version` | `integer` | NO | `1` | **System auto** | Incremented on each update |
| `updated_at` | `timestamptz` | NO | `now()` | **System auto** | |

**Drizzle:** `packages/db/src/schema/icp.ts`

**API:** `GET/PUT /api/v1/icp` — see `apps/api/src/services/icp.service.ts`

**`config` JSON shape:**

```json
{
  "industries": ["Software", "SaaS"],
  "countries": ["US", "CA"],
  "seniorities": ["vp", "director", "c_level"],
  "minEmployees": 50,
  "maxEmployees": 5000
}
```

**Example row (after onboarding):**

```json
{
  "workspace_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "config": {
    "industries": ["Software"],
    "countries": ["US"],
    "seniorities": ["vp", "director"],
    "minEmployees": 100,
    "maxEmployees": 2000
  },
  "version": 1,
  "updated_at": "2026-06-11T10:05:00Z"
}
```

---

## 6. Full SQL DDL (auth-related tables)

Source: `packages/db/drizzle/0000_yielding_dorian_gray.sql`

```sql
CREATE TABLE "workspaces" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "workspaces_slug_unique" UNIQUE("slug")
);

CREATE TABLE "users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "email" text NOT NULL,
  "full_name" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "users_email_unique" UNIQUE("email")
);

CREATE TABLE "workspace_members" (
  "workspace_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "role" text DEFAULT 'member' NOT NULL,
  "joined_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "workspace_members_workspace_id_user_id_pk"
    PRIMARY KEY("workspace_id", "user_id")
);

CREATE TABLE "credit_balances" (
  "workspace_id" uuid PRIMARY KEY NOT NULL,
  "balance" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "credit_transactions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "amount" integer NOT NULL,
  "action" text NOT NULL,
  "reference_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "workspace_icp" (
  "workspace_id" uuid PRIMARY KEY NOT NULL,
  "config" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Foreign keys
ALTER TABLE "workspace_members"
  ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE cascade;

ALTER TABLE "workspace_members"
  ADD CONSTRAINT "workspace_members_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade;

ALTER TABLE "credit_balances"
  ADD CONSTRAINT "credit_balances_workspace_id_workspaces_id_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE cascade;

ALTER TABLE "credit_transactions"
  ADD CONSTRAINT "credit_transactions_workspace_id_workspaces_id_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE cascade;

ALTER TABLE "workspace_icp"
  ADD CONSTRAINT "workspace_icp_workspace_id_workspaces_id_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE cascade;
```

---

## 7. Provisioning reference (pseudo-code)

Implement this inside auth middleware or `POST /api/v1/auth/sync` after JWT verification:

```typescript
async function provisionNewUser(email: string, fullName: string | null) {
  return db.transaction(async (tx) => {
    const slug = email.split("@")[0].toLowerCase().replace(/[^a-z0-9]/g, "-");

    const [workspace] = await tx
      .insert(workspaces)
      .values({ name: `${fullName ?? email}'s Workspace`, slug })
      .returning();

    const [user] = await tx
      .insert(users)
      .values({ email, fullName })
      .returning();

    await tx.insert(workspaceMembers).values({
      workspaceId: workspace.id,
      userId: user.id,
      role: "owner",
    });

    await tx.insert(creditBalances).values({
      workspaceId: workspace.id,
      balance: 500,
    });

    await tx.insert(creditTransactions).values({
      workspaceId: workspace.id,
      amount: 500,
      action: "provision",
    });

    return { user, workspace };
  });
}
```

---

## 8. Environment variables

### Frontend (`Skout Ai Frontend/.env.local`)

```bash
NEXT_PUBLIC_API_URL=http://localhost:3001
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...          # server components only
```

### Backend (`Skout AI Backend/.env`)

```bash
CLERK_SECRET_KEY=sk_test_...
CORS_ORIGIN=http://localhost:3000
DATABASE_URL=postgresql://skout:skout@localhost:5432/skout
```

### AWS (deployed)

Secret `{Prefix}/clerk` → injected into API + Web ECS tasks. See [secrets-setup.md](./secrets-setup.md).

**Clerk dashboard:** add app URL to **Allowed origins** and configure redirect URLs for `/sign-in` and `/sign-up`.

---

## 9. Key files to implement (Sprint 1 checklist)

| Task | File(s) |
|------|---------|
| Wrap app in Clerk | `Skout Ai Frontend/src/app/layout.tsx` — `ClerkProvider` |
| Protect routes | `Skout Ai Frontend/src/middleware.ts` — `clerkMiddleware` |
| Sign-in page | `Skout Ai Frontend/src/app/sign-in/[[...sign-in]]/page.tsx` |
| Attach JWT to API | `Skout Ai Frontend/src/lib/api-client.ts` — `getToken()` |
| Verify JWT | `apps/api/src/plugins/auth.ts` (new) — JWKS or `@clerk/fastify` |
| Replace stub tenant | `apps/api/src/plugins/workspace-context.ts` |
| Provision on first login | `apps/api/src/services/auth.service.ts` (new) |
| Optional: clerk_id column | New Drizzle migration on `users` |

---

## 10. Demo workspace (local dev stub)

Until Clerk is wired, local dev uses a seeded demo tenant. **All input values below come from the seed script**, not Clerk.

| Field | Value | Input source |
|-------|-------|--------------|
| Workspace ID | `00000000-0000-4000-8000-000000000001` | **Seed script** — hard-coded in `packages/db/src/seed.ts` |
| Name | `Demo Workspace` | **Seed script** |
| Slug | `demo` | **Seed script** |
| Credits | `500` | **Seed script** (same constant as production provision) |

| How to use | Where |
|------------|-------|
| Create rows in DB | `pnpm --filter @skout/db seed` |
| Frontend workspace header | `NEXT_PUBLIC_WORKSPACE_ID` in `Skout Ai Frontend/.env.local` |
| API tenant header | `X-Workspace-Id: 00000000-0000-4000-8000-000000000001` |
| API default (no header) | `apps/api/src/plugins/workspace-context.ts` falls back to same UUID |

**Note:** The demo seed does **not** create a `users` or `workspace_members` row — only `workspaces`, `credit_balances`, and a demo `lists` row. Full user provisioning requires Clerk + auth middleware (§3).

---

## 11. Optional: workspace invite (future)

When a user is invited to an **existing** workspace (not self-serve sign-up):

1. Owner sends invite (email).
2. Invitee signs in via Clerk (same flow).
3. API finds pending invite → inserts `workspace_members` with `role = member`.
4. **No** new `workspaces` or `credit_balances` row — joins existing tenant.

Requires a future `workspace_invites` table (not in schema yet).

---

## Related docs

- [mvp-flows.md §1](./mvp-flows.md#1-user-authentication) — product flow + competitive refs
- [security-compliance-and-performance.md §1.4](./security-compliance-and-performance.md#14-authentication-and-tenancy-in-progress--sprint-1) — security controls
- [database-schema.md](./database-schema.md) — full OLTP schema (lists, enrichment, sequences, …)
