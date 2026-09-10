# Skout AI — Master PRD Summary

> Condensed reference from the Master Product Requirements Document (v1.0).  
> For engineering mapping and phased delivery, see [master-prd-implementation.md](./master-prd-implementation.md).

---

## Vision in one sentence

Skout AI is an **AI-native Revenue Operating System (RevenueOS)** — not another CRM — that unifies prospecting, outreach, pipeline management, intelligence, and automation on **one shared data model** so revenue teams never sync tools manually.

**Tagline:** *One Platform. One Customer Record. One AI. One Revenue Engine.*

---

## Core positioning

| Traditional CRM | Skout AI |
|-----------------|----------|
| System of **record** (passive) | System of **action** (active revenue partner) |
| Stores what reps type | Discovers, enriches, engages, forecasts |
| Many add-ons for prospecting/outreach | Native modules on unified data |
| AI bolted on | AI embedded in every workflow |

**Terminology (product language):**

- **Revenue Workspace** — user-facing CRM / pipeline experience (not “another CRM product”)
- **Unified Data Layer** — shared system of record (contacts, companies, deals, activities, AI context)
- **Workspaces** — modular product surfaces (Prospecting, Outreach, Revenue Intelligence, etc.) on the same entities

---

## Product philosophy

1. **AI-first** — assistance, scoring, research, and agents are default, not optional add-ons  
2. **Unified platform** — one contact, one company, one deal, one timeline, one AI memory  
3. **Zero duplicate data** — prospecting and outreach reference CRM entities; no parallel silos  
4. **Automation before manual work** — events trigger workflows, sequences, and AI actions  
5. **Natural language** — copilot for search, list building, sequences, summaries, forecasting  
6. **Modular architecture** — workspaces evolve independently; data layer stays canonical  
7. **Enterprise scalability** — multi-tenant, RBAC, audit, integrations

---

## Target users (personas)

| Persona | Primary need |
|---------|----------------|
| **SDR** | Find leads, personalize outreach, book meetings |
| **AE** | Deal context, next-best-action, forecasting |
| **Sales Manager** | Pipeline health, coaching, team dashboards |
| **RevOps** | Data quality, workflows, permissions, reporting |
| **CSM** | Health, renewals, expansion on same customer record |
| **Marketing** | Attribution, lead routing, campaign impact |
| **Revenue Leader** | Forecast confidence, cross-functional visibility |
| **Admin** | SSO, RBAC, audit, configuration |

**Initial build priority:** SDR, AE, Sales Manager, RevOps, CSM.

---

## Product workspaces (modules)

| Workspace | Purpose | Key capabilities |
|-----------|---------|------------------|
| **CRM / Revenue** | Customer & pipeline management | Contacts, companies, deals, pipelines, tasks, meetings, activities, forecast |
| **Prospecting** | Find & qualify | Search, ICP, lists, waterfall enrichment, signals, AI research |
| **Outreach** | Engage | Email, sequences, templates, deliverability, reply handling |
| **Revenue Intelligence** | Predict performance | Forecasting, pipeline health, deal coaching, dashboards |
| **Customer Success** | Retain & expand | Health scores, renewals, QBRs, expansion |
| **Marketing** | Inbound demand | Forms, landing pages, attribution (later) |
| **Workflow Automation** | GTM ops | Triggers, webhooks, event engine, AI automation |
| **AI Copilot** | NL control plane | “Build a sequence”, “Show at-risk deals”, “Summarize meeting” |

**CRM is the operating layer** — it orchestrates prospecting and outreach; it does not own duplicate copies of those workflows.

---

## Canonical workflow (no imports/exports between modules)

```
Lead found → Enrichment → AI research → Sequence → Reply
  → Deal created → Meeting → Pipeline update → Forecast → Dashboard
```

All steps write to the **same** contact/company/deal/activity records.

---

## Architecture (high level)

### Layers

| Layer | Responsibility |
|-------|----------------|
| **Presentation** | Web, mobile (future), admin, AI chat |
| **Application** | CRM, prospecting, outreach, workflow, notification, reporting, AI orchestration |
| **Domain** | Core entities + business rules |
| **Data** | Postgres (OLTP), OpenSearch (search), Redis (cache/queues), S3, warehouse (analytics) |
| **Integration** | Email, calendar, telephony, enrichment, CRM migration, webhooks |

### Principles

- **Unified data model** — shared entities across all workspaces  
- **Event-driven** — `contact.created`, `deal.stage_changed`, `email.replied`, etc.  
- **API-first** — versioned REST (+ GraphQL optional for reads)  
- **Multi-tenant** — strict org/workspace isolation  
- **AI-native** — RAG over platform data; permission-aware actions; audit trail

### Core entities

Organization, User, Workspace, Contact, Company, Deal, Pipeline, Stage, Activity, Task, Meeting, Note, Sequence, Campaign, Message, Signal, AI Insight, AI Memory, Workflow, Notification, Audit Log.

---

## Autonomous Prospecting Engine (APE)

APE is the **always-on prospecting subsystem**:

1. Define ICP (filters + natural language)  
2. Discover accounts/contacts  
3. Waterfall enrichment (multi-provider fallback)  
4. AI research summaries + personalization cues  
5. Signal detection (funding, hiring, intent, tech changes)  
6. Multi-dimensional scoring (fit, intent, engagement, completeness, readiness)  
7. Dynamic lists + auto-activation (CRM, sequences, tasks)  
8. Continuous monitoring + score updates  

**Differentiator:** prospecting is not a separate export/import step — qualified records flow directly into outreach and CRM.

---

## AI capabilities (platform-wide)

| Capability | Examples |
|------------|----------|
| Copilot | NL search, commands, summaries |
| Research agent | Company/contact briefs, buying committee |
| Prospecting agent | ICP match, list build, prioritization |
| Outreach agent | Personalization, reply classification, follow-ups |
| Deal coach | Risk, next-best-action, stakeholder map |
| Meeting intelligence | Transcript summary, action items, CRM auto-fill |
| Forecasting | Pipeline prediction, slippage, scenarios |

**Guardrails:** grounded outputs, confidence scores, human approval for high-risk actions, full AI audit logs.

---

## Integrations strategy

**Principles:** map to unified schema, bi-directional where needed, OAuth/API keys, event/webhook-first, graceful failure, extensible registry.

**MVP priority:** Gmail, Outlook, Google/Microsoft Calendar, Slack, Zoom, Salesforce, HubSpot, Pipedrive, Twilio, Stripe, Zapier.

**Categories:** communication, CRM, enrichment, marketing, support, finance, automation, analytics/warehouse.

---

## Security & compliance (summary)

- Zero trust, least privilege, tenant isolation  
- RBAC (+ field-level for sensitive data)  
- TLS + encryption at rest, secrets vault  
- Immutable audit logs, GDPR/SOC2 readiness  
- AI: prompt injection protection, restricted agent tools, approval gates

---

## Roadmap phases (product)

| Phase | Goal | Scope highlights |
|-------|------|------------------|
| **MVP** | Unified lead-to-deal in one platform | Auth, CRM basics, search/enrich, sequences (email), AI summaries, timeline, dashboards, core integrations |
| **V1** | Automation + depth | AI copilot, deal coaching, forecasting, meeting intel, workflow builder, custom fields, webhooks, advanced reporting |
| **V2** | Autonomy + enterprise | Full APE, multi-agent orchestration, predictive intelligence, CS workflows, enterprise governance, marketplace |

---

## Success metrics (north stars)

- **Product:** WAU/MAU, feature adoption, time-to-first-value  
- **Revenue:** ARR, NRR, churn, trial→paid  
- **Sales productivity:** meetings booked, pipeline velocity, automation rate  
- **AI:** suggestion acceptance, forecast accuracy lift, research time saved  
- **Data quality:** enrichment success, duplicate rate, sync failures

---

## Key risks & mitigations

| Risk | Mitigation |
|------|------------|
| Scope too broad | Phased delivery; clear wedge (prospecting → outreach → CRM) |
| AI inaccuracy | Ground in platform data; confidence + human review |
| Data quality | Waterfall enrichment, validation, RevOps tooling |
| Incumbent ecosystems | Superior UX + unified workflow vs. feature parity |
| Migration friction | CRM import, parallel run, incremental module adoption |

---

## Documentation standard (per feature)

Every feature spec should include: purpose, business value, personas, user stories, functional requirements, acceptance criteria, UI, data model, APIs, automations, AI, permissions, notifications, integrations, analytics, edge cases, NFRs, future enhancements.

---

## Related internal docs

| Doc | Focus |
|-----|--------|
| [skout-ai-feature-guide.md](./skout-ai-feature-guide.md) | What is shipped today |
| [master-prd-implementation.md](./master-prd-implementation.md) | PRD → engineering phases & repo mapping |
| [mvp-flows.md](./mvp-flows.md) | MVP user/data flows |
| [remaining-features-build-order.md](./tickets/remaining-features-build-order.md) | Post-MVP epic backlog |
| [database-schema.md](./database-schema.md) | Current OLTP schema |
