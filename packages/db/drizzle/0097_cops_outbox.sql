CREATE TABLE "cops_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"envelope" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"published_at" timestamp with time zone,
	"dead_lettered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cops_processed_events" (
	"consumer" text NOT NULL,
	"event_id" uuid NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cops_processed_events_consumer_event_id_pk" PRIMARY KEY("consumer","event_id")
);
--> statement-breakpoint
CREATE INDEX "cops_outbox_pending_idx" ON "cops_outbox" USING btree ("next_attempt_at") WHERE published_at is null and dead_lettered_at is null;--> statement-breakpoint
CREATE INDEX "cops_outbox_tenant_created_idx" ON "cops_outbox" USING btree ("tenant_id","created_at");
