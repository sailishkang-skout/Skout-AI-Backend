# Skout AI — Database Schema (MVP)

PostgreSQL OLTP schema for workspace-scoped, **activated** records only. The global prospect corpus (~200M) lives in **OpenSearch**; records are materialized here on activation, enrichment, or list/sequence use.

**Migrations:** Drizzle ORM in `packages/db` — table DDL is added per user story via `pnpm db:generate` / `pnpm db:migrate`. This document describes the target schema; it is not applied as raw SQL.

> **Canonical ER diagram + all design decisions:** [mvp/05-database-er-diagram.md](./mvp/05-database-er-diagram.md)  
> **Standalone Mermaid (full diagram):** [diagrams/skout-ai-complete-er.mmd](./diagrams/skout-ai-complete-er.mmd)

**Identity (ADR 0001):**

```
prospect_id  = SHA256(normalized_company_domain + ":" + SHA256(email))
company_id   = SHA256(normalized_company_domain)
```

`prospect_id` and `company_id` are stored as `TEXT` (64-char hex). They are not FKs to a local prospects table.

---

## ER Diagram

```mermaid
erDiagram
    workspaces ||--o{ workspace_members : has
    users ||--o{ workspace_members : belongs_to
    workspaces ||--o{ prospect_activations : owns
    prospect_activations ||--o{ enrichment_jobs : enriches
    async_jobs ||--o| enrichment_jobs : queues
    enrichment_jobs ||--o{ enrichment_attempts : waterfall
    enrichment_jobs ||--o{ enrichment_results : produces
    workspaces ||--o{ lists : owns
    lists ||--o{ list_members : contains
    workspaces ||--o{ async_jobs : queues
    workspaces ||--o{ sequences : owns
    sequences ||--o{ sequence_steps : has
    sequences ||--o{ sequence_enrollments : enrolls
    lists ||--o{ sequence_enrollments : "source (optional)"
    sequence_enrollments ||--o{ sequence_enrollment_steps : tracks
    sequence_steps ||--o{ sequence_enrollment_steps : executes
    workspaces ||--o{ sending_domains : owns
    workspaces ||--o{ inboxes : owns
    sending_domains ||--o{ inboxes : "sends from"
    inboxes ||--o{ inbox_threads : has
    inbox_threads ||--o{ inbox_messages : contains
    workspaces ||--o{ ai_drafts : queues
    inbox_threads ||--o{ ai_drafts : "reply context"
    sequence_enrollment_steps ||--o{ ai_drafts : "step context"
    users ||--o{ ai_drafts : reviews
    workspaces ||--o{ crm_connections : integrates
    workspaces ||--o{ webhook_endpoints : subscribes
    webhook_endpoints ||--o{ webhook_deliveries : delivers

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
        uuid workspace_id PK,FK
        uuid user_id PK,FK
        text role
        timestamptz joined_at
    }

    prospect_activations {
        uuid id PK
        uuid workspace_id FK
        text prospect_id UK
        text company_id
        jsonb snapshot
        int record_version
        timestamptz activated_at
        timestamptz updated_at
    }

    enrichment_jobs {
        uuid id PK
        uuid workspace_id FK
        text prospect_id
        uuid activation_id FK
        uuid async_job_id FK
        text status
        text trigger
        text_array fields_requested
        timestamptz queued_at
        timestamptz completed_at
    }

    enrichment_attempts {
        uuid id PK
        uuid enrichment_job_id FK
        int attempt_order
        text provider
        text operation
        text status
        jsonb request_input
        jsonb response_output
        int latency_ms
        timestamptz attempted_at
    }

    enrichment_results {
        uuid id PK
        uuid enrichment_job_id FK
        uuid workspace_id FK
        text prospect_id
        text field_name
        text field_value
        text source_provider
        numeric confidence
        text validation_status
        boolean is_primary
    }

    lists {
        uuid id PK
        uuid workspace_id FK
        text name
        timestamptz created_at
        timestamptz updated_at
    }

    list_members {
        uuid list_id PK,FK
        text prospect_id PK
        timestamptz added_at
    }

    async_jobs {
        uuid id PK
        uuid workspace_id FK
        text job_type
        text status
        text entity_type
        text entity_id
        jsonb payload
        jsonb result
        text bullmq_job_id
        timestamptz queued_at
        timestamptz completed_at
    }

    sequences {
        uuid id PK
        uuid workspace_id FK
        text name
        text status
        timestamptz created_at
        timestamptz updated_at
    }

    sequence_steps {
        uuid id PK
        uuid sequence_id FK
        int step_order
        text step_type
        int delay_days
        text subject
        text body_template
    }

    sequence_enrollments {
        uuid id PK
        uuid workspace_id FK
        uuid sequence_id FK
        text prospect_id UK
        uuid list_id FK
        text status
        timestamptz enrolled_at
        timestamptz completed_at
    }

    sequence_enrollment_steps {
        uuid id PK
        uuid enrollment_id FK
        uuid step_id FK
        text status
        timestamptz scheduled_at
        timestamptz executed_at
    }

    sending_domains {
        uuid id PK
        uuid workspace_id FK
        text domain UK
        text status
        jsonb dns_records
        timestamptz verified_at
    }

    inboxes {
        uuid id PK
        uuid workspace_id FK
        uuid sending_domain_id FK
        text email_address UK
        text provider
        text warmup_status
        int daily_send_limit
        text status
    }

    inbox_threads {
        uuid id PK
        uuid workspace_id FK
        uuid inbox_id FK
        text prospect_id
        text subject
        text status
        timestamptz last_message_at
    }

    inbox_messages {
        uuid id PK
        uuid thread_id FK
        text direction
        text from_address
        text to_address
        text subject
        text body_text
        text body_html
        text external_id
        timestamptz sent_at
    }

    ai_drafts {
        uuid id PK
        uuid workspace_id FK
        text prospect_id
        uuid thread_id FK
        uuid enrollment_step_id FK
        text subject
        text body
        text status
        text model
        numeric confidence_score
        uuid reviewed_by FK
    }

    crm_connections {
        uuid id PK
        uuid workspace_id FK
        text provider UK
        text status
        text external_account_id
        jsonb settings
        text credentials_ref
        timestamptz connected_at
    }

    webhook_endpoints {
        uuid id PK
        uuid workspace_id FK
        text url
        text secret_hash
        text_array events
        text status
    }

    webhook_deliveries {
        uuid id PK
        uuid endpoint_id FK
        text event_type
        jsonb payload
        text status
        int attempts
        int response_status
    }
```

---

## Table Reference

### Tenancy & identity

| Table | Purpose | MVP API |
| --- | --- | --- |
| `workspaces` | Multi-tenant root | `GET /workspaces` |
| `users` | Platform users | (auth — header stub today) |
| `workspace_members` | User ↔ workspace RBAC | — |

### Prospects & lists

| Table | Purpose | MVP API |
| --- | --- | --- |
| `prospect_activations` | Workspace copy of activated prospect (`snapshot` JSONB) | `GET /prospects`, `POST /prospects/:id/enrich` |
| `lists` | Named prospect collections | `GET/POST /lists` |
| `list_members` | Prospect membership in a list | `POST /lists` (`prospectIds`) |

Search (`POST /search/prospects`) reads **OpenSearch**, not these tables.

### Lead enrichment (PAL waterfall)

| Table | Purpose | MVP API |
| --- | --- | --- |
| `enrichment_jobs` | One enrich request per prospect (links to activation + queue) | `POST /prospects/:id/enrich` → `202` |
| `enrichment_attempts` | Per-provider waterfall audit (`internal_graph` → `apollo` → `hunter` → …) | — |
| `enrichment_results` | Structured winning fields (email, company, validation) before snapshot merge | — |

After a job succeeds, the waterfall worker merges `enrichment_results` (where `is_primary = true`) into `prospect_activations.snapshot` and increments `record_version`.

### Async processing

| Table | Purpose | MVP API |
| --- | --- | --- |
| `async_jobs` | Generic BullMQ job state (enroll, send, CRM sync, AI) | `202` on enroll; enrich links via `enrichment_jobs.async_job_id` |

### Sequences

| Table | Purpose | MVP API |
| --- | --- | --- |
| `sequences` | Outreach sequence definition | `GET /sequences` |
| `sequence_steps` | Ordered steps (email, wait, manual) | — |
| `sequence_enrollments` | Prospect enrolled in a sequence | `POST /sequences/:id/enroll` |
| `sequence_enrollment_steps` | Per-step execution state | — |

### Email infrastructure

| Table | Purpose | MVP API |
| --- | --- | --- |
| `sending_domains` | Custom sending domains + DNS verification | `GET /domains` |
| `inboxes` | Sending/receiving mailboxes | `GET /inboxes` |
| `inbox_threads` | Conversation threads | `GET /inbox/threads` |
| `inbox_messages` | Individual messages in a thread | — |

### AI & integrations

| Table | Purpose | MVP API |
| --- | --- | --- |
| `ai_drafts` | Human-in-the-loop email drafts | `GET /ai/drafts` |
| `crm_connections` | CRM OAuth connections | `GET /crm/connections` |
| `webhook_endpoints` | Outbound webhook subscriptions | `GET /webhooks` |
| `webhook_deliveries` | Delivery log + retry state | — |

---

## Design conventions

| Convention | Rule |
| --- | --- |
| Primary keys | `UUID` via `gen_random_uuid()` |
| Timestamps | `TIMESTAMPTZ`, `created_at` / `updated_at` where mutable |
| Tenant isolation | `workspace_id` on all tenant tables |
| Prospect references | `TEXT prospect_id` (canonical hash, not a local FK) |
| Status fields | `TEXT` + `CHECK` constraint (enum-like) |
| Cascades | `ON DELETE CASCADE` for owned children; `SET NULL` for optional refs |
| Secrets | CRM tokens via `credentials_ref` → AWS Secrets Manager (not plain text) |
| RLS | Enable per-table after auth wiring (commented in `001`) |

---

## Data flow (MVP)

```
OpenSearch (corpus)
       │ search / activate
       ▼
prospect_activations ──► lists / list_members
       │
       ├──► enrichment_jobs ──► enrichment_attempts (PAL waterfall)
       │         │                      │
       │         └── async_jobs         └── apollo / hunter / prospeo / …
       │         │
       │         └──► enrichment_results ──► UPDATE snapshot
       │
       └──► sequence_enrollments ──► sequence_enrollment_steps
                    │
                    ├──► inboxes ──► inbox_threads ──► inbox_messages
                    │
                    └──► ai_drafts (HITL) ──► send worker
```


