CREATE TABLE "enrichment_workbook_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workbook_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"list_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"target_prospect_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"batch_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"processed_rows" integer DEFAULT 0 NOT NULL,
	"succeeded_rows" integer DEFAULT 0 NOT NULL,
	"failed_rows" integer DEFAULT 0 NOT NULL,
	"credits_budget" integer,
	"credits_used" integer DEFAULT 0 NOT NULL,
	"rerun_of_run_id" uuid,
	"error_message" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "enrichment_workbooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"fields" text[] DEFAULT '{"company","email","validation"}' NOT NULL,
	"email_quality_threshold" numeric(3, 2),
	"budget_credits_per_run" integer,
	"status" text DEFAULT 'draft' NOT NULL,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE "report_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"cadence" text DEFAULT 'weekly' NOT NULL,
	"recipient_emails" text[] DEFAULT '{}' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_sent_at" timestamp with time zone,
	"next_send_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid,
	"workspace_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"rollup" jsonb NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revenue_forecasts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"period_label" text NOT NULL,
	"model_amount" numeric(14, 2) NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"manager_adjusted_amount" numeric(14, 2),
	"manager_adjusted_reason" text,
	"manager_adjusted_by" uuid,
	"rep_committed_amount" numeric(14, 2),
	"rep_committed_reason" text,
	"rep_committed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "revenue_forecasts_workspace_id_period_label_unique" UNIQUE("workspace_id","period_label")
);
--> statement-breakpoint
CREATE TABLE "model_decision_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"surface" text NOT NULL,
	"suggested_value" text,
	"outcome" text NOT NULL,
	"confidence" real,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"type" text NOT NULL,
	"basis" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"recorded_by" uuid
);
--> statement-breakpoint
CREATE TABLE "entitlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"key" text PRIMARY KEY NOT NULL,
	"description" text NOT NULL,
	"category" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_id" uuid NOT NULL,
	"permission_key" text NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_key_pk" PRIMARY KEY("role_id","permission_key")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_workspaces" (
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_workspaces_tenant_id_workspace_id_pk" PRIMARY KEY("tenant_id","workspace_id"),
	CONSTRAINT "tenant_workspaces_workspace_id_unique" UNIQUE("workspace_id")
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "workspace_member_roles" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"granted_by" uuid,
	CONSTRAINT "workspace_member_roles_workspace_id_user_id_role_id_pk" PRIMARY KEY("workspace_id","user_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "evidence_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"attribute" text NOT NULL,
	"value" jsonb NOT NULL,
	"source" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"retrieved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"method" text,
	"region" text,
	"authority" text,
	"corroboration_count" integer DEFAULT 1 NOT NULL,
	"validation" text,
	"confidence" real NOT NULL,
	"freshness_expires_at" timestamp with time zone,
	"chosen_value" jsonb,
	"resolution_rule_or_model_version" text,
	"alternatives" jsonb,
	"resolution_reason" text,
	"reviewer_id" uuid,
	"permitted_purpose" text,
	"consent_basis" text,
	"channel_constraints" jsonb,
	"retention_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity_merge_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"proposal_id" uuid,
	"entity_type" text NOT NULL,
	"action" text NOT NULL,
	"primary_entity_id" text NOT NULL,
	"merged_entity_id" text NOT NULL,
	"before_snapshot" jsonb NOT NULL,
	"after_snapshot" jsonb,
	"performed_by" uuid,
	"performed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reversed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "identity_merge_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"left_entity_id" text NOT NULL,
	"right_entity_id" text NOT NULL,
	"score" real NOT NULL,
	"signals" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "buying_committee_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"committee_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"role" text DEFAULT 'unknown' NOT NULL,
	"influence" integer DEFAULT 3 NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "buying_committee_members_committee_contact_unique" UNIQUE("committee_id","contact_id")
);
--> statement-breakpoint
CREATE TABLE "buying_committees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"deal_id" uuid,
	"company_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "buying_committees_deal_unique" UNIQUE("deal_id")
);
--> statement-breakpoint
CREATE TABLE "retention_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"classification" text NOT NULL,
	"entity_type" text NOT NULL,
	"criteria" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"severity" text DEFAULT 'medium' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"source" text NOT NULL,
	"description" text,
	"related_entity_type" text,
	"related_entity_id" uuid,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"resolution_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"version_label" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_versions_name_version_unique" UNIQUE("name","version_label")
);
--> statement-breakpoint
CREATE TABLE "prompt_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"content" text NOT NULL,
	"model_version_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prompt_versions_name_version_unique" UNIQUE("name","version")
);
--> statement-breakpoint
CREATE TABLE "data_subject_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"request_type" text NOT NULL,
	"subject_email" text NOT NULL,
	"subject_type" text DEFAULT 'prospect' NOT NULL,
	"subject_id" text,
	"status" text DEFAULT 'received' NOT NULL,
	"fulfillment_mode" text DEFAULT 'manual' NOT NULL,
	"sla_due_at" timestamp with time zone,
	"export_payload" text,
	"export_completed_at" timestamp with time zone,
	"notes" text,
	"requested_by" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "deal_promotion_threshold" integer DEFAULT 80 NOT NULL;--> statement-breakpoint
ALTER TABLE "async_jobs" ADD COLUMN "progress" integer;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "strength" real;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "evidence_id" uuid;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "activation_paths" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "lists" ADD COLUMN "source_filters" jsonb;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "retention_classification" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "retention_classification" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "retention_classification" text;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "ics_uid" text;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "ics_sequence" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tams" ADD COLUMN "data_source" text;--> statement-breakpoint
ALTER TABLE "enrichment_workbook_runs" ADD CONSTRAINT "enrichment_workbook_runs_workbook_id_enrichment_workbooks_id_fk" FOREIGN KEY ("workbook_id") REFERENCES "public"."enrichment_workbooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrichment_workbook_runs" ADD CONSTRAINT "enrichment_workbook_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrichment_workbook_runs" ADD CONSTRAINT "enrichment_workbook_runs_batch_id_enrichment_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."enrichment_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrichment_workbooks" ADD CONSTRAINT "enrichment_workbooks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
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
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_snapshots" ADD CONSTRAINT "report_snapshots_schedule_id_report_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."report_schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_snapshots" ADD CONSTRAINT "report_snapshots_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_forecasts" ADD CONSTRAINT "revenue_forecasts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_forecasts" ADD CONSTRAINT "revenue_forecasts_manager_adjusted_by_users_id_fk" FOREIGN KEY ("manager_adjusted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_forecasts" ADD CONSTRAINT "revenue_forecasts_rep_committed_by_users_id_fk" FOREIGN KEY ("rep_committed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_decision_events" ADD CONSTRAINT "model_decision_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_key_permissions_key_fk" FOREIGN KEY ("permission_key") REFERENCES "public"."permissions"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_workspaces" ADD CONSTRAINT "tenant_workspaces_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_workspaces" ADD CONSTRAINT "tenant_workspaces_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_member_roles" ADD CONSTRAINT "workspace_member_roles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_member_roles" ADD CONSTRAINT "workspace_member_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_member_roles" ADD CONSTRAINT "workspace_member_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_member_roles" ADD CONSTRAINT "workspace_member_roles_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_ledger" ADD CONSTRAINT "evidence_ledger_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_ledger" ADD CONSTRAINT "evidence_ledger_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_merge_events" ADD CONSTRAINT "identity_merge_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_merge_events" ADD CONSTRAINT "identity_merge_events_proposal_id_identity_merge_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."identity_merge_proposals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_merge_events" ADD CONSTRAINT "identity_merge_events_performed_by_users_id_fk" FOREIGN KEY ("performed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_merge_proposals" ADD CONSTRAINT "identity_merge_proposals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_merge_proposals" ADD CONSTRAINT "identity_merge_proposals_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buying_committee_members" ADD CONSTRAINT "buying_committee_members_committee_id_buying_committees_id_fk" FOREIGN KEY ("committee_id") REFERENCES "public"."buying_committees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buying_committee_members" ADD CONSTRAINT "buying_committee_members_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buying_committees" ADD CONSTRAINT "buying_committees_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buying_committees" ADD CONSTRAINT "buying_committees_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buying_committees" ADD CONSTRAINT "buying_committees_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_rules" ADD CONSTRAINT "retention_rules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_rules" ADD CONSTRAINT "retention_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_versions" ADD CONSTRAINT "prompt_versions_model_version_id_model_versions_id_fk" FOREIGN KEY ("model_version_id") REFERENCES "public"."model_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_versions" ADD CONSTRAINT "prompt_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_requests" ADD CONSTRAINT "data_subject_requests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_requests" ADD CONSTRAINT "data_subject_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meeting_attendees_meeting_id_idx" ON "meeting_attendees" USING btree ("meeting_id");--> statement-breakpoint
CREATE INDEX "promotion_candidates_workspace_status_idx" ON "promotion_candidates" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "report_schedules_workspace_idx" ON "report_schedules" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "report_snapshots_schedule_idx" ON "report_snapshots" USING btree ("schedule_id","version");--> statement-breakpoint
CREATE INDEX "report_snapshots_workspace_idx" ON "report_snapshots" USING btree ("workspace_id","generated_at");--> statement-breakpoint
CREATE INDEX "revenue_forecasts_workspace_idx" ON "revenue_forecasts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "model_decision_events_workspace_idx" ON "model_decision_events" USING btree ("workspace_id","surface","created_at");--> statement-breakpoint
CREATE INDEX "consents_workspace_subject_idx" ON "consents" USING btree ("workspace_id","subject_type","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "entitlements_workspace_key_idx" ON "entitlements" USING btree ("workspace_id","key");--> statement-breakpoint
CREATE INDEX "roles_workspace_id_idx" ON "roles" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "workspace_member_roles_workspace_user_idx" ON "workspace_member_roles" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "evidence_ledger_workspace_entity_idx" ON "evidence_ledger" USING btree ("workspace_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "evidence_ledger_workspace_entity_attr_idx" ON "evidence_ledger" USING btree ("workspace_id","entity_type","entity_id","attribute");--> statement-breakpoint
CREATE INDEX "identity_merge_events_workspace_idx" ON "identity_merge_events" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "identity_merge_proposals_workspace_status_idx" ON "identity_merge_proposals" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "buying_committee_members_committee_id_idx" ON "buying_committee_members" USING btree ("committee_id");--> statement-breakpoint
CREATE INDEX "buying_committees_workspace_id_idx" ON "buying_committees" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "buying_committees_deal_id_idx" ON "buying_committees" USING btree ("deal_id");--> statement-breakpoint
CREATE INDEX "buying_committees_company_id_idx" ON "buying_committees" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "retention_rules_workspace_id_idx" ON "retention_rules" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "retention_rules_workspace_active_idx" ON "retention_rules" USING btree ("workspace_id","is_active");--> statement-breakpoint
CREATE INDEX "incidents_workspace_id_idx" ON "incidents" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "incidents_workspace_status_idx" ON "incidents" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "incidents_workspace_entity_idx" ON "incidents" USING btree ("workspace_id","related_entity_type","related_entity_id");--> statement-breakpoint
CREATE INDEX "prompt_versions_name_active_idx" ON "prompt_versions" USING btree ("name","is_active");--> statement-breakpoint
CREATE INDEX "dsar_workspace_status_idx" ON "data_subject_requests" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "dsar_subject_email_idx" ON "data_subject_requests" USING btree ("subject_email");--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_evidence_id_evidence_ledger_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence_ledger"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pipelines_workspace_default_unique_idx" ON "pipelines" USING btree ("workspace_id") WHERE "pipelines"."is_default" = true;