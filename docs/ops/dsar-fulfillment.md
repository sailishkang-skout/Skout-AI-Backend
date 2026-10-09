# DSAR fulfillment (§16)

## Modes (both available)
| Mode | When | Behavior |
|------|------|----------|
| `auto` | Default for `access` / `portability` | Builds JSON export (consents + request metadata), sets status `completed`, respects 30-day SLA clock |
| `manual` | Default for `erasure` / `rectification`, or pass `fulfillmentMode:"manual"` | Queue for Legal/ops; SLA due = created + 30 days |

## API
```bash
# Auto (access)
curl -X POST "$API/api/v1/dsar" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"requestType":"access","subjectEmail":"a@b.com"}'

# Force manual
curl -X POST "$API/api/v1/dsar" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"requestType":"access","subjectEmail":"a@b.com","fulfillmentMode":"manual"}'
```

## SLA (current product decision)
**30 calendar days** from intake (`slaDueAt`). Legal may shorten via contract later.

## Process owner (Leadership go-ahead 2026-08-25)
**Neeraj (Lead)** — privacy / DSAR fulfillment owner; SLA = **30 calendar days**.  
Hand off to hired Legal / DPO when available; until then Eng Lead owns intake → fulfill / escalate.

## CustomerOps records (COPS-07)

The auto-export (v2) now includes, for the subject's email: the onboarding emails sent to that
address (template, subject, status, sent / opened / clicked times) and, when the request names a
contact id, the engineering tickets linked to that contact (id, title, status, created time).
Ticket descriptions and comments are left out on purpose: they can hold internal notes and other
people's data, and need a human to review before release.

Erasure is still manual. For a CustomerOps subject, review these tables for the contact or address:

| Table | What to do |
|---|---|
| `cops_onboarding_email_sends` | Delete rows for the address (`to_email`). |
| `engineering_tickets`, `ticket_comments` | Clear `contact_id`; redact the person's details from free text. Keep the ticket. |
| `tasks`, `activities`, timeline rows | Follow the CRM contact erasure steps above. |
| `audit_logs` | Keep. Audit rows are retained for the period in the retention policy. |
| `credit_transactions` | Keep. The ledger is append-only and holds no personal data. |

Retention (CustomerOps admin, Retention and privacy) is separate from DSAR: it removes old rows by
category and age for the whole workspace, never for one person. Its automatic targets are audit
logs, onboarding email sends, idempotency keys and published outbox events.
