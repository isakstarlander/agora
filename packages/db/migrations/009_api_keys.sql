CREATE TABLE api_keys (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  key_prefix      TEXT        NOT NULL UNIQUE,  -- first 8 chars after "agora_", for display
  key_hash        TEXT        NOT NULL UNIQUE,  -- SHA-256(full_raw_key), hex-encoded
  email           TEXT        NOT NULL,
  description     TEXT,                         -- stated use case from consumer
  tier            TEXT        NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'paid')),
  is_active       BOOLEAN     NOT NULL DEFAULT true,
  rate_limit_rpm  INT         NOT NULL DEFAULT 120,
  request_count   BIGINT      NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at    TIMESTAMPTZ
);

CREATE INDEX idx_api_keys_hash     ON api_keys (key_hash);
CREATE INDEX idx_api_keys_prefix   ON api_keys (key_prefix);
CREATE INDEX idx_api_keys_email    ON api_keys (email);
CREATE INDEX idx_api_keys_active   ON api_keys (is_active) WHERE is_active = true;

-- RLS: no public read — keys table is server-only (service role only)
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
-- No public read policy: only service role can access this table
