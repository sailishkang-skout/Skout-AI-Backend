# Gap: prospect-corpus identity vs native-CRM identity not reconciled (sequences + inbox)

**Raised by:** R14.1 unified-record lock-in audit (`docs/tickets/r14-1-unified-record-audit.md`).
**Owner:** Sahil (Track A / sequences — inferred from git history, confirm) + Neeraj (inbox —
inferred from git history, confirm).
**Status:** Open.

## The gap

`sequence_enrollments` and `inbox_threads` both key off the prospect-corpus identity
(`prospect_id`, a text hash), not `contacts.id` (the native CRM row). `contacts.sourceProspectId`
is the only link between the two, and it's optional — a contact created manually or via a CRM
import may have no `sourceProspectId` at all, so a sequence enrollment or inbox thread for that
same person cannot always be resolved back to a single CRM record.

This is now a real prerequisite gap, not just a documentation note: R13.3's auto-fill and R20.3's
next-best-action score/signal grounding (both shipped) only work when `contacts.sourceProspectId`
is set — they silently no-op otherwise. R20.4's call-step disposition branching enrolls/advances by
`prospect_id` directly, sidestepping the CRM identity entirely.

## Suggested fix

Pick one direction (per the original R14.1 action item):
1. Add a `contactId` FK to `sequence_enrollments` and `inbox_threads`, backfilled from
   `contacts.sourceProspectId` where resolvable, or
2. Guarantee every `prospect_id` that reaches a sequence/inbox has a corresponding `contacts` row
   (auto-create on first activation), so `sourceProspectId` is never null for an active prospect.

Either removes the silent-no-op failure mode in R13.3/R20.3 and unblocks a clean identity story
for future Track B work.
