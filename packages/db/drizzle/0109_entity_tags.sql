CREATE TABLE "entity_tags" (
	"workspace_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entity_tags_unique" UNIQUE("workspace_id","tag_id","entity_type","entity_id")
);
--> statement-breakpoint
ALTER TABLE "entity_tags" ADD CONSTRAINT "entity_tags_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_tags" ADD CONSTRAINT "entity_tags_tag_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entity_tags_entity_idx" ON "entity_tags" USING btree ("workspace_id","entity_type","entity_id");
