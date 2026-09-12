/**
 * SQL helpers shared by the pool/prober. Kept in one place so the due-set semantics stay
 * consistent between the scheduler and the prober.
 */

/** Proxies that need a probe right now (see ProxyProber.probeDue / docs/proxy-pool.md). */
export const PROXIES_DUE_FOR_PROBE_SQL = `
  SELECT * FROM proxies p
  WHERE p.enabled
    AND p.status <> 'DEAD'
    AND (
      (p.quarantined_until IS NOT NULL AND p.quarantined_until <= now())
      OR (p.probe_after IS NOT NULL AND p.probe_after <= now())
      OR (p.last_success_at IS NULL AND p.last_failure_at IS NULL)
    )
  ORDER BY p.health_score ASC
`;

/** Proxies whose rotation window has elapsed (admin-defined schedule, per row). */
export const PROXIES_ROTATION_DUE_SQL = `
  SELECT * FROM proxies p
  WHERE p.enabled
    AND p.status = 'ACTIVE'
    AND (p.quarantined_until IS NULL OR p.quarantined_until <= now())
    AND (
      p.assigned_worker_id IS NOT NULL
      AND p.last_rotated_at IS NOT NULL
      AND now() - p.last_rotated_at >= make_interval(secs => p.rotation_seconds)
    )
  ORDER BY p.last_rotated_at ASC
`;
