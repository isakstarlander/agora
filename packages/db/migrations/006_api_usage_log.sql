-- Write-only usage log for observability. Never exposed as an API endpoint.
-- No RLS needed: inserted only via secret key from server-side API routes.

CREATE TABLE api_usage_log (
  id           BIGSERIAL PRIMARY KEY,
  endpoint     TEXT         NOT NULL,   -- e.g. "/api/v1/accountability"
  params_hash  TEXT,                    -- SHA-256 of sorted, non-PII query params
  duration_ms  INT,
  status_code  INT          NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_api_usage_endpoint  ON api_usage_log (endpoint, created_at DESC);
CREATE INDEX idx_api_usage_status    ON api_usage_log (status_code, created_at DESC);
