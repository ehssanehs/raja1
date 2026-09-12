/**
 * Availability fingerprints (spec § 105).
 *
 * A fingerprint is a stable, normalized identity of an observed ticket. Two observations of the
 * same train/class/date/price produce the same fingerprint even when cosmetic response fields
 * change, so the same match never notifies a user twice.
 *
 * Implementation notes:
 *  - input fields are normalized (digits, casing, whitespace, price rounding to the currency's
 *    minor unit) before hashing
 *  - `cyrb53` is used: fast, dependency-free, deterministic across Node and the browser, with a
 *    collision probability that is irrelevant for this use case (dedup, not security)
 *  - this is *not* a security boundary: an attacker who can forge provider responses already owns
 *    the booking path (see TM-15)
 */

export interface AvailabilityFingerprintInput {
  providerCode: string;
  origin: string;
  destination: string;
  departureAt: string; // ISO instant (UTC)
  trainNumber?: string | null;
  coachClass?: string | null;
  travelDate?: string | null; // YYYY-MM-DD when known
  priceMinor?: number | null;
  currency?: string | null;
}

function normalizeToken(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** cyrb53 string hash → 53-bit integer rendered as base36. */
export function cyrb53(input: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const value = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return value.toString(36);
}

export function availabilityFingerprint(input: AvailabilityFingerprintInput): string {
  const parts = [
    normalizeToken(input.providerCode),
    normalizeToken(input.origin),
    normalizeToken(input.destination),
    input.departureAt.slice(0, 16), // minute precision: schedules are published to the minute
    normalizeToken(input.travelDate ?? input.departureAt.slice(0, 10)),
    normalizeToken(input.trainNumber ?? ''),
    normalizeToken(input.coachClass ?? ''),
    input.priceMinor != null ? String(Math.trunc(input.priceMinor)) : '',
    normalizeToken(input.currency ?? ''),
  ];
  return `av1:${cyrb53(parts.join('|'))}`;
}

/** Fingerprint for a whole search tick, used to detect "same result set" cheaply. */
export function searchResultFingerprint(fingerprints: readonly string[]): string {
  return `sr1:${cyrb53([...fingerprints].sort().join(','))}`;
}

/** Dedup key for notifications derived from an event + subject (spec § 46). */
export function notificationDedupKey(input: {
  event: string;
  userId: string;
  subjectId: string;
  discriminator?: string;
}): string {
  const parts = [normalizeToken(input.event), input.userId, input.subjectId, input.discriminator ?? ''];
  return `nd1:${cyrb53(parts.join('|'))}`;
}
