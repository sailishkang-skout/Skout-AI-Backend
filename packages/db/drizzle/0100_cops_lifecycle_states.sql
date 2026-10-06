CREATE TABLE "cops_lifecycle_states" (
	"workspace_id" uuid NOT NULL,
	"dimension" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"state" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cops_lifecycle_states_workspace_id_dimension_entity_id_pk" PRIMARY KEY("workspace_id","dimension","entity_id")
);
--> statement-breakpoint
ALTER TABLE "cops_lifecycle_states" ADD CONSTRAINT "cops_lifecycle_states_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "cops_lifecycle_workspace_dimension_idx" ON "cops_lifecycle_states" USING btree ("workspace_id","dimension");
