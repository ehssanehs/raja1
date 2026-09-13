/**
 * @raja/proxy — admin-managed egress proxy pool.
 *
 * Posture (ADR-0008): routing + respect, never evasion.
 *  - admins curate a catalogue of proxies; the pool hands leases to workers (sticky per worker)
 *  - rotation follows admin-defined per-proxy schedules (≥ 5 min), evenly wearing the pool
 *  - provider restriction signals (429, block page, repeated CAPTCHA, 403/407) put the affected
 *    proxy to *rest* (quarantine) with an exponentially growing window and a tightened budget —
 *    they never trigger rotation to a fresh IP
 *  - credentials are envelope-encrypted at rest and only decrypted inside an active lease
 *  - `egressMode=REQUIRED` fails closed when no healthy proxy exists
 */
export * from './types';
export * from './errors';
export * from './rotation';
export * from './quarantine';
export * from './admin';
export * from './pool';
export * from './transport';
export * from './prober';
export * from './settings';
export * from './selector.sql';
export * from './retention';
