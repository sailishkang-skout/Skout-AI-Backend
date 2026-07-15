CREATE TABLE IF NOT EXISTS "email_verifications" (
  "workspace_id"          uuid NOT NULL REFERENCES "public"."workspaces"("id") ON DELETE CASCADE,
  "prospect_id"           text NOT NULL,
  "email"                 text NOT NULL,
  "status"                text NOT NULL,
  "deliverability_score"  integer NOT NULL DEFAULT 0,
  "catch_all"             boolean NOT NULL DEFAULT false,
  "risky"                 boolean NOT NULL DEFAULT false,
  "provider"              text,
  "verified_at"           timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "email_verifications_workspace_id_prospect_id_pk" PRIMARY KEY("workspace_id","prospect_id")
);
