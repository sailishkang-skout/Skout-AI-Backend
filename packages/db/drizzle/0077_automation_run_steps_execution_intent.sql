ALTER TABLE automation_run_steps
  ADD COLUMN idempotency_key text,
  ADD COLUMN lease_owner text,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0;

UPDATE automation_run_steps
  SET idempotency_key = automation_run_id::text || ':' || node_id
  WHERE idempotency_key IS NULL;

ALTER TABLE automation_run_steps
  ALTER COLUMN idempotency_key SET NOT NULL;

CREATE UNIQUE INDEX automation_run_steps_idempotency_uidx ON automation_run_steps (idempotency_key);

ALTER TABLE automation_run_steps
  DROP COLUMN attempt,
  DROP COLUMN claimed_at,
  DROP COLUMN claimed_by_worker,
  DROP COLUMN heartbeat_at,
  DROP COLUMN next_retry_at;
