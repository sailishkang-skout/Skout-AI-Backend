CREATE DATABASE IF NOT EXISTS skout;

CREATE TABLE IF NOT EXISTS skout.skout_events (
  workspace_id String,
  event_type LowCardinality(String),
  event_time DateTime64(3, 'UTC'),
  amount Int32 DEFAULT 0,
  reference_id String DEFAULT '',
  metadata String DEFAULT '{}'
) ENGINE = MergeTree()
ORDER BY (workspace_id, event_type, event_time);
