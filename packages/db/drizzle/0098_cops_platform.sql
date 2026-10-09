CREATE TABLE "cops_idempotency_keys" (
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"status" integer,
	"response" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cops_idempotency_keys_workspace_id_key_pk" PRIMARY KEY("workspace_id","key"),
	CONSTRAINT "cops_idempotency_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "actor_type" text DEFAULT 'user' NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "actor_ref" text;
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "impersonator_id" text;
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "reason" text;
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "is_override" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "correlation_id" text;
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "source_channel" text;
--> statement-breakpoint
CREATE INDEX "cops_idempotency_expires_idx" ON "cops_idempotency_keys" USING btree ("expires_at");
