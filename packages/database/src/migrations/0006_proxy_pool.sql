-- =============================================================================
-- 0006_proxy_pool — admin-managed egress proxy pool (docs/proxy-pool.md).
--
-- Posture (ADR-0008): the pool routes traffic and *respects* provider signals.
-- It deliberately has NO "rotate on block" mode: restriction signals put the
-- affected proxy to rest (quarantine) instead. Rotation is admin-scheduled and
-- slow (>= 5 minutes), sticky per worker, with even wear across the pool.
-- =============================================================================

-- Extend the existing catalogue table (created in 0001_init) with the new
-- operational columns. Credentials (username_enc/password_enc) stay AES-256-GCM
-- envelopes from @raja/crypto.
ALTER TABLE proxies ADD COLUMN IF NOT EXISTS status            text NOT NULL DEFAULT 'ACTIVE'
  CHECK (status IN ('ACTIVE','QUARANTINED','DEAD'));
ALTER TABLE proxies ADD COLUMN IF NOT EXISTS consecutive_failures int NOT NULL DEFAULT 0;
ALTER TABLE proxies ADD COLUMN IF NOT EXISTS last_error_class   text;
ALTER TABLE proxies ADD COLUMN IF NOT EXISTS quarantine_count   int  NOT NULL DEFAULT 0;
ALTER TABLE proxies ADD COLUMN IF NOT EXISTS rotation_seconds   int  NOT NULL DEFAULT 3600
  CHECK (rotation_seconds BETWEEN 300 AND 86400);
ALTER TABLE proxies ADD COLUMN IF NOT EXISTS assigned_worker_id text;
ALTER TABLE proxies ADD COLUMN IF NOT EXISTS assigned_at        timestamptz;
ALTER TABLE proxies ADD COLUMN IF NOT EXISTS last_rotated_at    timestamptz;
ALTER TABLE proxies ADD COLUMN IF NOT EXISTS requests_per_minute int NOT NULL DEFAULT 10
  CHECK (requests_per_minute BETWEEN 1 AND 60);
ALTER TABLE proxies ADD COLUMN IF NOT EXISTS rate_budget_multiplier_pct int NOT NULL DEFAULT 100
  CHECK (rate_budget_multiplier_pct BETWEEN 12 AND 100);
ALTER TABLE proxies ADD COLUMN IF NOT EXISTS updated_at         timestamptz NOT NULL DEFAULT now();
ALTER TABLE proxies ADD COLUMN IF NOT EXISTS probe_after        timestamptz;

-- A worker holds at most one proxy; a proxy serves at most one worker.
CREATE UNIQUE INDEX IF NOT EXISTS proxies_worker_assignment_uq ON proxies (assigned_worker_id) WHERE assigned_worker_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS proxies_status_idx       ON proxies (status, enabled);
CREATE INDEX IF NOT EXISTS proxies_probe_due_idx    ON proxies (probe_after) WHERE enabled AND status <> 'DEAD';
CREATE INDEX IF NOT EXISTS proxies_quarantine_idx   ON proxies (quarantined_until) WHERE quarantined_until IS NOT NULL;

-- Audit trail of administrative and automatic decisions (who/what/why, no secrets).
-- Audit events SURVIVE proxy removal (proxy_id becomes NULL): history is never deleted with the
-- thing it describes. The append-only trigger below refuses UPDATE/DELETE outright.
CREATE TABLE IF NOT EXISTS proxy_events (
  id          uuid PRIMARY KEY,
  proxy_id    uuid REFERENCES proxies(id) ON DELETE SET NULL,
  event_type  text NOT NULL CHECK (event_type IN
    ('CREATED','UPDATED','REMOVED','ENABLED','DISABLED',
     'PROBE_OK','PROBE_FAILED','QUARANTINED','QUARANTINE_RELEASED','MARKED_DEAD','RECOVERED',
     'LEASE_ACQUIRED','LEASE_RELEASED','ROTATED','BUDGET_TIGHTENED')),
  source      text NOT NULL DEFAULT 'system',
  reason      text NOT NULL DEFAULT '',
  details     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS proxy_events_proxy_idx ON proxy_events (proxy_id, created_at DESC);

-- Health samples: append-only evidence behind health_score moves (probes + real traffic).
CREATE TABLE IF NOT EXISTS proxy_health_samples (
  id              uuid PRIMARY KEY,
  proxy_id        uuid REFERENCES proxies(id) ON DELETE SET NULL,
  source          text NOT NULL CHECK (source IN ('PROBE','TRAFFIC')),
  ok              boolean NOT NULL,
  latency_ms      int,
  http_status     int,
  error_class     text,
  block_page      boolean NOT NULL DEFAULT false,
  captcha_seen    boolean NOT NULL DEFAULT false,
  correlation_id  text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS proxy_health_samples_proxy_idx ON proxy_health_samples (proxy_id, created_at DESC);

-- Lease hygiene: expire assignments whose worker died without releasing (defensive; the pool
-- treats an assignment older than the max lease as free). Kept as data for the admin UI.
CREATE INDEX IF NOT EXISTS proxies_assignment_idx ON proxies (assigned_at) WHERE assigned_worker_id IS NOT NULL;

-- Health samples and events are append-only evidence: no direct edits, no rewrites, ever.
-- FK maintenance actions (ON DELETE SET NULL when the proxy row itself is removed) run at a
-- deeper trigger depth and ARE allowed — the audit rows survive with proxy_id NULLed, they are
-- never deleted. Direct UPDATE/DELETE from clients (depth 1) is refused.
CREATE OR REPLACE FUNCTION forbid_mutation_direct() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'table % is append-only (attempted %)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER proxy_events_append_only
  BEFORE UPDATE OR DELETE ON proxy_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation_direct();
CREATE TRIGGER proxy_health_samples_append_only
  BEFORE UPDATE OR DELETE ON proxy_health_samples
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation_direct();

-- Pool-wide settings live in system_settings under key 'proxy_pool' (egressMode, minHealthScore,
-- probeIntervalSeconds, allowDirectFallback). No schema needed; defaults are fail-closed (OFF).
INSERT INTO system_settings (key, value, description)
VALUES ('proxy_pool', '{"egressMode":"OFF","minHealthScore":0,"probeIntervalSeconds":300,"allowDirectFallback":true}'::jsonb,
        'Egress proxy pool settings (docs/proxy-pool.md)')
ON CONFLICT (key) DO NOTHING;
