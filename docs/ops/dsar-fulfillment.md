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
