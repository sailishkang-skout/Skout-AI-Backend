# ADR 0016: Payments processed by a PSP; Skout stores references and status only

## Status
Proposed — pending Aditya review. Author: open (epic open question 7). PSP: open (epic open
question 1; existing billing provider assumed).

## Context
Handling card data brings PCI scope that Skout does not need. Bible v2 Part IV and Part IX require
payments to be provider-hosted and reconciled, with no raw card data stored or logged.

## Decision
1. Payment links and checkout are created by the PSP. Customers enter card details on the
   provider-hosted page only.
2. Skout stores provider references (payment request ID, charge ID, event ID) and the status
   derived from verified webhooks: requested, paid, failed, refunded.
3. Webhooks are signature-verified and deduplicated by provider event ID. Replays leave state
   unchanged.
4. Raw webhook references are kept for reconciliation. Card numbers, CVC and similar data are never
   stored, logged or returned by the API.

## Consequences
- Reconciliation jobs compare Skout status with PSP status (COPS-03, runbook in Appendix I).
- Credits are granted only after a confirmed PaymentSucceeded (COPS-04).
- Choice of PSP does not change this decision.
