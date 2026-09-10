ALTER TABLE linkedin_outreach_jobs
  ADD COLUMN lease_owner text,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0;

UPDATE linkedin_outreach_jobs SET status = 'claimed' WHERE status = 'processing';
UPDATE linkedin_outreach_jobs SET status = 'succeeded' WHERE status = 'completed';
