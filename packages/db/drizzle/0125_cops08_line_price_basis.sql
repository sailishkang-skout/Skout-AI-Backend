-- COPS-08: what one proposal line amount covers (per_month, per_term or one_time), so total
-- contract value can be computed for the whole term. Additive and idempotent. NULL means the
-- default for the line kind (fee: one_time, anything else: per_term), so existing lines keep the
-- contract value they had and sent versions are not touched.

ALTER TABLE "proposal_line_items" ADD COLUMN IF NOT EXISTS "price_basis" text;
