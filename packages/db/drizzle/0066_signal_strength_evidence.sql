ALTER TABLE "signals" ADD COLUMN "strength" real;
--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "evidence_id" uuid;
--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_evidence_id_evidence_ledger_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence_ledger"("id") ON DELETE set null ON UPDATE no action;
