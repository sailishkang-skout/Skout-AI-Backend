CREATE TABLE "warmup_tool_sync_state" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"last_event_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meeting_attendees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"email" text NOT NULL,
	"contact_id" uuid,
	"rsvp_status" text DEFAULT 'needs-action' NOT NULL,
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meeting_attendees_meeting_id_email_unique" UNIQUE("meeting_id","email")
);
--> statement-breakpoint
CREATE TABLE "promotion_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"prospect_id" text NOT NULL,
	"score" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promotion_candidates_workspace_id_prospect_id_unique" UNIQUE("workspace_id","prospect_id")
);
--> statement-breakpoint
CREATE TABLE "countries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"region_id" uuid NOT NULL,
	"iso_code" text NOT NULL,
	"name" text NOT NULL,
	"currency_code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "countries_iso_code_unique" UNIQUE("iso_code")
);
--> statement-breakpoint
CREATE TABLE "regional_brief_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"layer_type" text NOT NULL,
	"region_id" uuid,
	"country_id" uuid,
	"industry" text,
	"workspace_id" uuid,
	"field_category" text NOT NULL,
	"scope_key" text NOT NULL,
	"current_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "regional_brief_slots_scope_key_unique" UNIQUE("scope_key")
);
--> statement-breakpoint
CREATE TABLE "regional_brief_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slot_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content" jsonb NOT NULL,
	"source" text NOT NULL,
	"effective_date" timestamp with time zone NOT NULL,
	"confidence" integer NOT NULL,
	"evidence" text NOT NULL,
	"expiry_date" timestamp with time zone,
	"status" text DEFAULT 'draft' NOT NULL,
	"supersedes_id" uuid,
	"reviewer_id" uuid,
	"reviewed_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "regional_brief_versions_slot_id_version_unique" UNIQUE("slot_id","version")
);
--> statement-breakpoint
CREATE TABLE "regions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "regions_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "deal_promotion_threshold" integer DEFAULT 80 NOT NULL;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "ics_uid" text;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "ics_sequence" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "warmup_tool_sync_state" ADD CONSTRAINT "warmup_tool_sync_state_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_attendees" ADD CONSTRAINT "meeting_attendees_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_attendees" ADD CONSTRAINT "meeting_attendees_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_candidates" ADD CONSTRAINT "promotion_candidates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "countries" ADD CONSTRAINT "countries_region_id_regions_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."regions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regional_brief_slots" ADD CONSTRAINT "regional_brief_slots_region_id_regions_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."regions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regional_brief_slots" ADD CONSTRAINT "regional_brief_slots_country_id_countries_id_fk" FOREIGN KEY ("country_id") REFERENCES "public"."countries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regional_brief_slots" ADD CONSTRAINT "regional_brief_slots_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regional_brief_versions" ADD CONSTRAINT "regional_brief_versions_slot_id_regional_brief_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."regional_brief_slots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regional_brief_versions" ADD CONSTRAINT "regional_brief_versions_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regional_brief_versions" ADD CONSTRAINT "regional_brief_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meeting_attendees_meeting_id_idx" ON "meeting_attendees" USING btree ("meeting_id");--> statement-breakpoint
CREATE INDEX "promotion_candidates_workspace_status_idx" ON "promotion_candidates" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "pipelines_workspace_default_unique_idx" ON "pipelines" USING btree ("workspace_id") WHERE "pipelines"."is_default" = true;