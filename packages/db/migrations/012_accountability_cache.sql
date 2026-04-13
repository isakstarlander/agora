-- 012_accountability_cache.sql
-- Persistent cache for AI-generated accountability summaries.
-- Keyed by (party, topic_hash) where topic_hash is the SHA-256 of
-- the lowercased and whitespace-trimmed topic string.
-- TTL is enforced at the application layer (7 days).

CREATE TABLE IF NOT EXISTS accountability_cache (
  party          text        NOT NULL,
  topic_hash     text        NOT NULL,  -- SHA-256 hex of normalised topic
  topic_raw      text        NOT NULL,  -- original topic text for debugging
  summary        text,                  -- null means synthesis returned nothing
  generated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (party, topic_hash)
);

-- Index for TTL sweeps (find stale rows).
CREATE INDEX idx_accountability_cache_generated_at
  ON accountability_cache (generated_at);

-- Optional: allow Supabase's auto-cleanup job to purge rows older than 30 days.
-- Application logic enforces the 7-day freshness check; this is a safety net.
COMMENT ON TABLE accountability_cache IS
  'AI summary cache for /api/v1/accountability. Application TTL: 7 days.';
