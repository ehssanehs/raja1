/**
 * Security invariants that must hold as the permission matrix and localization evolve.
 * These encode decisions from the threat model (TM-02, TM-05, TM-06) so a careless edit fails CI.
 */
import { describe, expect, it } from 'vitest';
import { MESSAGE_KEYS, en, fa, t, translator } from '../i18n';
import {
  MASKED_FIELD_PLACEHOLDER,
  PERMISSIONS,
  PLATFORM_ONLY_PERMISSIONS,
  ROLE_PERMISSIONS,
  hasPermission,
  maskEmail,
  maskNationalId,
  maskValue,
  permissionsForRole,
} from '../permissions';
import { isValidIranianNationalId, normalizeIranianMobile } from '../validation';
import { availabilityFingerprint, notificationDedupKey, searchResultFingerprint } from '../fingerprint';
import { ROLES, NOTIFICATION_EVENTS, NOTIFICATION_EVENT_META, MANDATORY_NOTIFICATION_CATEGORIES } from '../constants';

describe('RBAC matrix', () => {
  it('grants every permission to SUPER_ADMIN only', () => {
    const superAdmin = new Set(ROLE_PERMISSIONS.SUPER_ADMIN);
    for (const permission of PERMISSIONS) {
      expect(superAdmin.has(permission), `SUPER_ADMIN missing ${permission}`).toBe(true);
    }
  });

  it('never grants platform-only permissions to non-staff roles', () => {
    const nonStaff = ROLES.filter((r) => r === 'USER');
    for (const role of nonStaff) {
      for (const permission of PLATFORM_ONLY_PERMISSIONS) {
        expect(hasPermission(role, permission), `${role} must not have ${permission}`).toBe(false);
      }
    }
  });

  it('keeps passenger PII away from finance roles (spec § 54)', () => {
    expect(hasPermission('FINANCE_ADMIN', 'pii:read')).toBe(false);
    expect(hasPermission('FINANCE_ADMIN', 'passenger:manage')).toBe(true); // own passengers only
    expect(hasPermission('FINANCE_ADMIN', 'wallet:adjust')).toBe(true);
    expect(hasPermission('SUPPORT', 'pii:read')).toBe(false);
    expect(hasPermission('OPERATOR', 'pii:read')).toBe(false);
    expect(hasPermission('ADMIN', 'pii:read')).toBe(true);
  });

  it('keeps every role able to manage its own account', () => {
    for (const role of ROLES) {
      expect(hasPermission(role, 'session:manage:own')).toBe(true);
      expect(hasPermission(role, 'data:export:own')).toBe(true);
    }
  });

  it('grants nothing for an unknown permission (deny by default)', () => {
    for (const role of ROLES) {
      const permissions = permissionsForRole(role);
      expect(Array.isArray(permissions)).toBe(true);
      expect(hasPermission(role, 'nonexistent:permission' as never)).toBe(false);
    }
  });

  it('supports explicit grants additively', () => {
    expect(hasPermission('SUPPORT', 'pii:read')).toBe(false);
    expect(hasPermission('SUPPORT', 'pii:read', ['pii:read'])).toBe(true);
  });
});

describe('masking helpers', () => {
  it('masks emails while keeping the domain', () => {
    expect(maskEmail('user@example.com')).toBe(`u${MASKED_FIELD_PLACEHOLDER}@example.com`);
  });

  it('masks secrets and national ids without revealing digits', () => {
    expect(maskValue('abcdef123456')).toContain(MASKED_FIELD_PLACEHOLDER);
    expect(maskValue('')).toBe('');
    const masked = maskNationalId('1234567890');
    expect(masked).not.toContain('1234567890');
    expect(masked).toContain('10');
  });
});

describe('localization completeness', () => {
  it('has a Persian translation for every English key', () => {
    for (const key of MESSAGE_KEYS) {
      expect(fa[key], `missing fa translation for ${key}`).toBeTruthy();
    }
  });

  it('has identical key sets', () => {
    expect(Object.keys(fa).sort()).toEqual(Object.keys(en).sort());
  });

  it('interpolates parameters and falls back safely', () => {
    expect(t('en', 'notify.approval_required.body', { minutes: 10 })).toContain('10');
    expect(t('fa', 'bot.start.welcome')).toContain('رجا');
    expect(translator('en')('error.rate_limited')).toContain('Too many');
    // Unknown params stay visible instead of becoming "undefined"
    expect(t('en', 'bot.wizard.created')).toContain('{reference}');
  });

  it('has metadata for every notification event and marks security as mandatory', () => {
    for (const event of NOTIFICATION_EVENTS) {
      expect(NOTIFICATION_EVENT_META[event], `missing meta for ${event}`).toBeDefined();
      expect(NOTIFICATION_EVENT_META[event].category).toBeTruthy();
    }
    expect(MANDATORY_NOTIFICATION_CATEGORIES).toContain('security');
    for (const event of NOTIFICATION_EVENTS) {
      const meta = NOTIFICATION_EVENT_META[event];
      if (meta.category === 'security') expect(meta.mandatory).toBe(true);
    }
  });
});

describe('validation primitives', () => {
  it('validates Iranian national ids', () => {
    expect(isValidIranianNationalId('0499370899')).toBe(true);
    expect(isValidIranianNationalId('۰۴۹۹۳۷۰۸۹۹')).toBe(true); // Persian digits accepted
    expect(isValidIranianNationalId('1111111111')).toBe(false);
    expect(isValidIranianNationalId('1234567890')).toBe(false);
    expect(isValidIranianNationalId('12345')).toBe(false);
  });

  it('normalizes Iranian mobile numbers to E.164', () => {
    expect(normalizeIranianMobile('09123456789')).toBe('+989123456789');
    expect(normalizeIranianMobile('+98 912 345 6789')).toBe('+989123456789');
    expect(normalizeIranianMobile('989123456789')).toBe('+989123456789');
    expect(normalizeIranianMobile('12345')).toBeNull();
  });
});

describe('availability fingerprints', () => {
  const base = {
    providerCode: 'simulator',
    origin: 'THR',
    destination: 'MHD',
    departureAt: '2026-08-10T05:00:00.000Z',
    trainNumber: '201',
    coachClass: 'SECOND',
    travelDate: '2026-08-10',
    priceMinor: 1_850_000,
    currency: 'IRR',
  };

  it('is stable for the same observation, including cosmetic differences', () => {
    expect(availabilityFingerprint(base)).toBe(availabilityFingerprint({ ...base }));
    expect(availabilityFingerprint(base)).toBe(
      availabilityFingerprint({ ...base, origin: '  thr ', trainNumber: ' 201 ' }),
    );
  });

  it('changes when the material facts change', () => {
    expect(availabilityFingerprint(base)).not.toBe(availabilityFingerprint({ ...base, priceMinor: 1_851_000 }));
    expect(availabilityFingerprint(base)).not.toBe(availabilityFingerprint({ ...base, coachClass: 'FIRST' }));
    expect(availabilityFingerprint(base)).not.toBe(
      availabilityFingerprint({ ...base, departureAt: '2026-08-10T05:01:00.000Z' }),
    );
  });

  it('is order-independent for result sets', () => {
    const a = availabilityFingerprint(base);
    const b = availabilityFingerprint({ ...base, trainNumber: '202' });
    expect(searchResultFingerprint([a, b])).toBe(searchResultFingerprint([b, a]));
  });

  it('produces stable notification dedup keys', () => {
    const key = notificationDedupKey({ event: 'ticket_found', userId: 'u1', subjectId: 'r1' });
    expect(key).toBe(notificationDedupKey({ event: 'ticket_found', userId: 'u1', subjectId: 'r1' }));
    expect(key).not.toBe(notificationDedupKey({ event: 'ticket_found', userId: 'u1', subjectId: 'r2' }));
  });
});
