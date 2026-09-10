-- Phase 3 ICS meeting invites: stable per-meeting calendar UID/SEQUENCE for RFC 5545 invite
-- revisions, plus a meeting_attendees table tracking RSVP status per invitee. Independent of
-- the existing Google Calendar integration (calendar_connections/google_event_id) — this is a
-- fallback channel for meetings whose organizer has no connected Google Calendar.

ALTER TABLE "meetings" ADD COLUMN IF NOT EXISTS "ics_uid" text;
--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN IF NOT EXISTS "ics_sequence" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "meeting_attendees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL REFERENCES "meetings"("id") ON DELETE CASCADE,
	"email" text NOT NULL,
	"contact_id" uuid REFERENCES "contacts"("id") ON DELETE SET NULL,
	"rsvp_status" text DEFAULT 'needs-action' NOT NULL,
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meeting_attendees_meeting_id_email_unique" UNIQUE("meeting_id","email")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "meeting_attendees_meeting_id_idx" ON "meeting_attendees" ("meeting_id");
