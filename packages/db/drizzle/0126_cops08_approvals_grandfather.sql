-- COPS-08: deals already in flight when the approval engine arrives are not blocked by it
-- (Aditya, 2026-10-13: blocking a customer who has signed or paid is worse than a missed approval).
-- An opportunity is grandfathered when, at the moment this migration runs, it has a proposal that
-- was sent, a signed contract or a paid payment request. Drafts follow the new rules.
--
-- migration-safety: the columns are additive. The INSERT is a one-time backfill of marker rows in
-- commercial_gates; it changes no existing value except the two new columns, and it does nothing
-- once any row is marked, so running the file again does not grandfather later deals.

ALTER TABLE "commercial_gates" ADD COLUMN IF NOT EXISTS "approvals_grandfathered_at" timestamptz;
ALTER TABLE "commercial_gates" ADD COLUMN IF NOT EXISTS "approvals_grandfathered_reason" text;

INSERT INTO "commercial_gates" ("opportunity_id", "workspace_id", "approvals_grandfathered_at", "approvals_grandfathered_reason")
SELECT s.opportunity_id, s.workspace_id, now(), string_agg(DISTINCT s.reason, ',' ORDER BY s.reason)
FROM (
  SELECT p.opportunity_id, p.workspace_id, 'proposal_sent' AS reason
    FROM "proposals" p JOIN "proposal_versions" v ON v.proposal_id = p.id WHERE v.sent_at IS NOT NULL
  UNION ALL
  SELECT c.opportunity_id, c.workspace_id, 'contract_signed' FROM "contracts" c WHERE c.status = 'signed'
  UNION ALL
  SELECT r.opportunity_id, r.workspace_id, 'payment_paid' FROM "payment_requests" r WHERE r.status = 'paid' AND r.opportunity_id IS NOT NULL
) s
WHERE NOT EXISTS (SELECT 1 FROM "commercial_gates" g WHERE g.approvals_grandfathered_at IS NOT NULL)
GROUP BY s.opportunity_id, s.workspace_id
ON CONFLICT ("opportunity_id") DO UPDATE
  SET "approvals_grandfathered_at" = EXCLUDED."approvals_grandfathered_at",
      "approvals_grandfathered_reason" = EXCLUDED."approvals_grandfathered_reason";
