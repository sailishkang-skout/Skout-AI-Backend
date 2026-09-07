-- SS-08 — activation rules can now optionally require a minimum stack-weight (confidence *
-- strength * recency) on the matching signal, not just its bare presence. Null preserves the
-- original R13.4 behavior for every existing rule.
ALTER TABLE "activation_rules" ADD COLUMN "min_signal_strength" real;
