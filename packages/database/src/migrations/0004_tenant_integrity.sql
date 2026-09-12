-- =============================================================================
-- 0004_tenant_integrity — close the last nullable tenant columns and pin down
-- ledger sign conventions (TM-01 tenant isolation, TM-08 financial integrity)
-- =============================================================================

-- Tenant-owned rows must always carry their tenant. A nullable tenant_id is an isolation hole:
-- a buggy query that forgets the predicate silently returns global rows and a platform-level
-- write can be attributed to no tenant at all.
--
-- `audit_events` is the single intentional exception: platform/SUPER_ADMIN actions (feature-flag
-- changes, migrations, kill switch) are not attributable to one tenant. It stays nullable and is
-- allow-listed in `verify.ts` / the tenant-columns integrity check.
ALTER TABLE availability_observations ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE fraud_signals ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE diagnostics_artifacts ALTER COLUMN tenant_id SET NOT NULL;

-- If the platform ever needs observations shared across tenants, that data must live in a
-- separate, non-tenant table with no user identifiers (documented in docs/domain-model.md).

-- ------------------------------------------------------------ ledger signs ---
-- The ledger is append-only and signed. Sign is not free-form: a refund can never be recorded as
-- a debit, and a service charge can never be recorded as a credit. This turns a whole class of
-- bookkeeping bugs (and a class of fraud) into a constraint violation.
ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_transactions_sign_by_type CHECK (
  (type IN ('DEPOSIT','REFUND','BONUS','PROMO','CHARGE_RELEASE') AND amount_minor > 0)
  OR (type IN ('SERVICE_CHARGE','BOOKING_CHARGE','CHARGE_HOLD') AND amount_minor < 0)
  OR (type IN ('ADMIN_ADJUSTMENT','REVERSAL') AND amount_minor <> 0)
);

-- A reversal entry must always point at the entry it reverses, and only a reversal may do so.
ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_transactions_reversal_linked
  CHECK ((type = 'REVERSAL') = (reversal_of IS NOT NULL));

-- Posted rows must carry the resulting balance snapshot; pending holds are allowed to omit it.
ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_transactions_posted_snapshot
  CHECK (status <> 'POSTED' OR balance_after_minor IS NOT NULL);

-- A released/reversed row must reference the original posting it releases.
ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_transactions_release_links
  CHECK (status NOT IN ('RELEASED','REVERSED') OR reference_id IS NOT NULL);

-- --------------------------------------------------- booking result scoring ---
ALTER TABLE booking_results ADD CONSTRAINT booking_results_score_range
  CHECK (score >= 0 AND score <= 100);

-- An attempt that reached a terminal state must carry a failure class when it failed.
ALTER TABLE booking_attempts ADD CONSTRAINT booking_attempts_failed_needs_class
  CHECK (state NOT IN ('FAILED','EXPIRED') OR failure_class IS NOT NULL);

-- Reservation money must be non-negative when present.
ALTER TABLE reservations ADD CONSTRAINT reservations_price_non_negative
  CHECK (total_price_minor IS NULL OR total_price_minor >= 0);

-- Payments: amounts are positive and always accompanied by a currency.
ALTER TABLE payments ADD CONSTRAINT payments_amount_positive
  CHECK (amount_minor > 0);

-- ------------------------------------------------------------- inbox typing ---
ALTER TABLE support_tickets ADD CONSTRAINT support_tickets_subject_present
  CHECK (length(subject) > 0);
