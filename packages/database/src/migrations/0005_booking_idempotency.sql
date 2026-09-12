-- 0005 — Booking idempotency scope and monitor hygiene.
--
-- Why: `booking_requests.idempotency_key` was globally unique, which (a) lets one tenant consume an
-- idempotency key another tenant may want to use, and (b) makes the service's replay lookup
-- (tenant-scoped) disagree with the database constraint. Idempotency is a *tenant-scoped* concept in
-- a multi-tenant platform (spec § 6, § 10), so the uniqueness must be tenant-scoped too.
--
-- The old constraint was created inline (`idempotency_key text UNIQUE`), so it carries the implicit
-- name PostgreSQL generates for that column.

ALTER TABLE booking_requests DROP CONSTRAINT IF EXISTS booking_requests_idempotency_key_key;

CREATE UNIQUE INDEX IF NOT EXISTS booking_requests_tenant_idempotency_uq
  ON booking_requests (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Monitors are due-ordered per tenant; the scheduler claims work with a status + next_search_at scan.
CREATE INDEX IF NOT EXISTS booking_monitors_tenant_due_idx
  ON booking_monitors (tenant_id, next_search_at)
  WHERE status = 'ACTIVE';

-- A search result must never be attached to a request of another tenant (defence in depth on top of
-- the service-layer check): the composite foreign key makes a cross-tenant reference impossible.
-- PostgreSQL needs a unique index on the referenced columns before it will accept the composite FK.
CREATE UNIQUE INDEX IF NOT EXISTS booking_requests_id_tenant_uq ON booking_requests (id, tenant_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'booking_results_request_tenant_fk'
  ) THEN
    ALTER TABLE booking_results
      ADD CONSTRAINT booking_results_request_tenant_fk
      FOREIGN KEY (booking_request_id, tenant_id)
      REFERENCES booking_requests (id, tenant_id)
      ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'booking_monitors_request_tenant_fk'
  ) THEN
    ALTER TABLE booking_monitors
      ADD CONSTRAINT booking_monitors_request_tenant_fk
      FOREIGN KEY (booking_request_id, tenant_id)
      REFERENCES booking_requests (id, tenant_id)
      ON DELETE CASCADE;
  END IF;
END $$;
