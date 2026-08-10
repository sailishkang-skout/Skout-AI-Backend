-- R13.3 — free-text notes a rep attaches to a logged call, source material for the call_note
-- auto-fill pipeline (call-notes-extraction.service.ts).

ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "notes" text;
