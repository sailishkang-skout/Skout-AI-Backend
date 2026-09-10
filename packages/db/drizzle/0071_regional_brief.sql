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
ALTER TABLE "countries" ADD CONSTRAINT "countries_region_id_regions_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."regions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "regional_brief_slots" ADD CONSTRAINT "regional_brief_slots_region_id_regions_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."regions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "regional_brief_slots" ADD CONSTRAINT "regional_brief_slots_country_id_countries_id_fk" FOREIGN KEY ("country_id") REFERENCES "public"."countries"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "regional_brief_slots" ADD CONSTRAINT "regional_brief_slots_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "regional_brief_versions" ADD CONSTRAINT "regional_brief_versions_slot_id_regional_brief_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."regional_brief_slots"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "regional_brief_versions" ADD CONSTRAINT "regional_brief_versions_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "regional_brief_versions" ADD CONSTRAINT "regional_brief_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
