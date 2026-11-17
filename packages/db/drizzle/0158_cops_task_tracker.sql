-- Work tracker for every Skout department (GitHub Projects / Jira style): projects with a key
-- (ENG, SAL...), issues numbered per project (ENG-12), a board by status, comments.
-- History lives in audit_logs (entity_type tracker_issue).
CREATE TABLE IF NOT EXISTS "cops_tracker_projects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "key" text NOT NULL CHECK ("key" ~ '^[A-Z][A-Z0-9]{1,9}$'),
  "name" text NOT NULL,
  "department" text NOT NULL CHECK ("department" ~ '^[a-z][a-z0-9_]{1,39}$'),
  "description" text,
  "next_number" integer NOT NULL DEFAULT 1,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "archived_at" timestamp with time zone,
  CONSTRAINT "cops_tracker_projects_key_unique" UNIQUE ("workspace_id","key")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cops_tracker_issues" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "project_id" uuid NOT NULL REFERENCES "cops_tracker_projects"("id") ON DELETE CASCADE,
  "number" integer NOT NULL,
  "title" text NOT NULL,
  "description" text,
  "type" text NOT NULL DEFAULT 'task' CHECK ("type" IN ('task','bug','story','request')),
  "status" text NOT NULL DEFAULT 'todo' CHECK ("status" IN ('backlog','todo','in_progress','in_review','blocked','done')),
  "priority" text NOT NULL DEFAULT 'medium' CHECK ("priority" IN ('low','medium','high','urgent')),
  "assignee_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "reporter_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "labels" text[] NOT NULL DEFAULT '{}',
  "due_date" date,
  "account_id" uuid REFERENCES "companies"("id") ON DELETE SET NULL,
  "parent_id" uuid REFERENCES "cops_tracker_issues"("id") ON DELETE SET NULL,
  "position" double precision NOT NULL DEFAULT 0,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "cops_tracker_issues_number_unique" UNIQUE ("project_id","number")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cops_tracker_issues_board_idx" ON "cops_tracker_issues" ("workspace_id","project_id","status","position");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cops_tracker_issues_assignee_idx" ON "cops_tracker_issues" ("workspace_id","assignee_id","status");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cops_tracker_comments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "issue_id" uuid NOT NULL REFERENCES "cops_tracker_issues"("id") ON DELETE CASCADE,
  "author_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "body" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cops_tracker_comments_issue_idx" ON "cops_tracker_comments" ("issue_id","created_at");

-- Departments a workspace adds on top of the built-in ones (Support, HR...).
CREATE TABLE IF NOT EXISTS "cops_tracker_departments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "key" text NOT NULL CHECK ("key" ~ '^[a-z][a-z0-9_]{1,39}$'),
  "name" text NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "cops_tracker_departments_key_unique" UNIQUE ("workspace_id", "key")
);

-- Who works in which department (built-in or added); a person can be in several.
CREATE TABLE IF NOT EXISTS "cops_tracker_department_members" (
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "department" text NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "cops_tracker_department_members_pk" PRIMARY KEY ("workspace_id", "department", "user_id")
);
