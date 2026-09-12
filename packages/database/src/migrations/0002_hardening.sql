-- =============================================================================
-- 0002_hardening — append-only guarantees, audit hash chain, invariant checks
-- (TM-08 ledger integrity, TM-19 audit tampering, TM-11 duplicate booking)
-- =============================================================================

-- ------------------------------------------------- append-only enforcement ---
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only (attempted %)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

-- Financial ledger, state history, audit trail and verified webhook events are immutable.
-- Corrections happen by inserting compensating rows (REVERSAL / new transition), never by
-- mutating history.
CREATE TRIGGER wallet_transactions_append_only
  BEFORE UPDATE OR DELETE ON wallet_transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER booking_transitions_append_only
  BEFORE UPDATE OR DELETE ON booking_transitions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER booking_timeline_events_append_only
  BEFORE UPDATE OR DELETE ON booking_timeline_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER payment_events_append_only
  BEFORE UPDATE OR DELETE ON payment_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER credit_consumptions_append_only
  BEFORE UPDATE OR DELETE ON credit_consumptions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER consent_records_append_only
  BEFORE UPDATE OR DELETE ON consent_records
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ------------------------------------------------------- audit hash chain ---
-- entry_hash = sha256(prev_hash | action | target | digests | correlation | created_at)
-- Tampering (or deleting an interior row) breaks the chain and is detected by
-- verify_audit_chain() which the restore/backup verification script runs.
CREATE OR REPLACE FUNCTION audit_chain_hash() RETURNS trigger AS $$
DECLARE
  prev text;
BEGIN
  IF NEW.created_at IS NULL THEN
    NEW.created_at := now();
  END IF;
  SELECT entry_hash INTO prev FROM audit_events ORDER BY id DESC LIMIT 1;
  NEW.prev_hash := prev;
  NEW.entry_hash := encode(sha256(convert_to(
      coalesce(prev, '') || '|' || NEW.action || '|' || NEW.target_type || '|' || NEW.target_id ||
      '|' || coalesce(NEW.before_digest, '') || '|' || coalesce(NEW.after_digest, '') ||
      '|' || coalesce(NEW.correlation_id, '') || '|' || NEW.created_at::text, 'UTF8')), 'hex');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_chain
  BEFORE INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_chain_hash();

CREATE OR REPLACE FUNCTION verify_audit_chain()
RETURNS TABLE (ok boolean, checked bigint, first_broken_id bigint) AS $$
DECLARE
  rec record;
  prev text := NULL;
  expected text;
BEGIN
  ok := true;
  checked := 0;
  FOR rec IN SELECT * FROM audit_events ORDER BY id ASC LOOP
    checked := checked + 1;
    expected := encode(sha256(convert_to(
      coalesce(prev, '') || '|' || rec.action || '|' || rec.target_type || '|' || rec.target_id ||
      '|' || coalesce(rec.before_digest, '') || '|' || coalesce(rec.after_digest, '') ||
      '|' || coalesce(rec.correlation_id, '') || '|' || rec.created_at::text, 'UTF8')), 'hex');
    IF rec.prev_hash IS DISTINCT FROM prev OR rec.entry_hash <> expected THEN
      ok := false;
      first_broken_id := rec.id;
      RETURN NEXT;
      RETURN;
    END IF;
    prev := rec.entry_hash;
  END LOOP;
  first_broken_id := NULL;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql;

-- ------------------------------------------------------------ updated_at -----
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'plans','providers','tenants','users','provider_accounts','booking_requests','booking_monitors',
    'booking_attempts','reservations','wallets','invoices','payments','subscriptions','support_tickets',
    'release_windows','fraud_signals','provider_health_samples'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_touch BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION touch_updated_at()',
      tbl, tbl);
  END LOOP;
END $$;

-- ------------------------------------------- duplicate-booking protection ----
-- At most one *live* attempt per booking request (TM-11 layer 4).
CREATE UNIQUE INDEX booking_attempts_active_uq ON booking_attempts (booking_request_id)
  WHERE state IN ('LOCKED','RESERVING','HUMAN_VERIFICATION_REQUIRED','PASSENGER_FORM',
                  'READY_FOR_CHECKOUT','AWAITING_USER_APPROVAL');

-- At most one monitor per (request, leg, date) already enforced; add a "satisfied once" guarantee:
CREATE UNIQUE INDEX booking_results_selected_uq ON booking_results (booking_request_id)
  WHERE is_selected = true;

-- ------------------------------------------------------- extra constraints ---
ALTER TABLE quota_counters ADD CONSTRAINT quota_counters_limit_non_negative
  CHECK (limit_value IS NULL OR limit_value >= 0);

ALTER TABLE credits ADD CONSTRAINT credits_status_consistent
  CHECK ((status = 'CONSUMED') = (remaining_minor = 0) OR status IN ('EXPIRED','REVOKED'));

ALTER TABLE wallets ADD CONSTRAINT wallets_credit_le_balance
  CHECK (credit_minor <= balance_minor);

ALTER TABLE search_jobs ADD CONSTRAINT search_jobs_duration_non_negative
  CHECK (duration_ms IS NULL OR duration_ms >= 0);

ALTER TABLE notification_deliveries ADD CONSTRAINT delivery_attempts_non_negative
  CHECK (attempts >= 0);

ALTER TABLE idempotency_keys ADD CONSTRAINT idempotency_expiry_after_creation
  CHECK (expires_at > created_at);

-- Guard: a release window cannot be armed without a burst interval floor.
ALTER TABLE release_windows ADD CONSTRAINT release_windows_burst_floor
  CHECK (burst_interval_seconds = 0 OR burst_interval_seconds >= 1);

-- ------------------------------------------------------------- hot indexes ---
-- Scheduler fairness scan: due monitors ordered by priority; partial keeps the index tiny.
CREATE INDEX booking_monitors_priority_due_idx
  ON booking_monitors (priority, next_search_at)
  WHERE status = 'ACTIVE' AND backoff_until IS NULL;

-- Provider/account health scans
CREATE INDEX provider_accounts_status_idx ON provider_accounts (provider_code, status);
CREATE INDEX provider_accounts_cooldown_idx ON provider_accounts (cooldown_until)
  WHERE status = 'COOLDOWN';

-- Queue-observability scans
CREATE INDEX search_jobs_running_idx ON search_jobs (status, started_at)
  WHERE status IN ('PENDING','RUNNING');

-- Ledger reconciliation helpers
CREATE INDEX wallet_transactions_type_idx ON wallet_transactions (type, created_at DESC);
CREATE INDEX payments_status_idx ON payments (status, created_at DESC);

-- Support inbox style queries
CREATE INDEX support_tickets_assignee_idx ON support_tickets (assigned_to, status)
  WHERE status IN ('OPEN','PENDING');
