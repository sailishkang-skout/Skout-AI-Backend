CREATE TABLE "cops_notification_routes" (
	"workspace_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"role_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cops_notification_routes_workspace_id_event_type_pk" PRIMARY KEY("workspace_id","event_type")
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "source_event_id" uuid;--> statement-breakpoint
ALTER TABLE "cops_notification_routes" ADD CONSTRAINT "cops_notification_routes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cops_notification_routes" ADD CONSTRAINT "cops_notification_routes_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cops_notification_routes_workspace_idx" ON "cops_notification_routes" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_cops_event_recipient_idx" ON "notifications" USING btree ("workspace_id","user_id","source_event_id") WHERE "notifications"."source_event_id" is not null;