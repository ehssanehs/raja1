/**
 * RBAC matrix invariants (TM-02, spec § 54).
 *
 * The role→permission matrix is data, but the *rules about the matrix* are behaviour and must be
 * tested: escalation containment, finance/PII separation, deny-by-default for unknown permissions,
 * and tenant binding for non-staff principals.
 */
import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  ROLES,
  isPermission,
  permissionsForRole,
  type Permission,
  type Principal,
  type Role,
} from '@raja/shared';
import {
  assertAnyPermission,
  assertPermission,
  assertTenantAccess,
  can,
  effectivePermissions,
  snapshotPrincipal,
} from '../rbac';

function principal(role: Role, overrides: Partial<Principal> = {}): Principal {
  return {
    userId: '00000000-0000-4000-8000-000000000001',
    tenantId: '00000000-0000-4000-8000-00000000000a',
    role,
    grants: [],
    isPlatformStaff: false,
    ...overrides,
  };
}

const SELF_PERMISSIONS: Permission[] = [
  'profile:read',
  'profile:write',
  'passenger:manage',
  'booking:manage:own',
  'wallet:read:own',
];

describe('role matrix shape', () => {
  it('only contains declared permissions', () => {
    for (const role of ROLES) {
      for (const permission of permissionsForRole(role)) {
        expect(isPermission(permission), `${role} → ${permission}`).toBe(true);
      }
    }
  });

  it('gives every role the self-service permissions it needs', () => {
    for (const role of ROLES) {
      for (const permission of SELF_PERMISSIONS) {
        expect(can(principal(role), permission), `${role} lacks ${permission}`).toBe(true);
      }
    }
  });

  it('never lets a lower role hold a permission that a higher role lacks (no gaps)', () => {
    const order: Role[] = ['USER', 'SUPPORT', 'OPERATOR', 'ADMIN', 'SUPER_ADMIN'];
    for (let index = 1; index < order.length; index += 1) {
      const lower = order[index - 1] as Role;
      const higher = order[index] as Role;
      for (const permission of permissionsForRole(lower)) {
        expect(can(principal(higher), permission), `${higher} lacks ${permission} held by ${lower}`).toBe(true);
      }
    }
  });

  it('keeps finance and passenger PII separate', () => {
    const finance = principal('FINANCE_ADMIN');
    expect(can(finance, 'wallet:adjust')).toBe(true);
    expect(can(finance, 'payment:refund')).toBe(true);
    expect(can(finance, 'reconciliation:run')).toBe(true);
    // Finance never sees raw passenger identifiers; support sees masked data only.
    expect(can(finance, 'pii:read')).toBe(false);
    expect(can(principal('SUPPORT'), 'pii:read')).toBe(false);
    expect(can(principal('ADMIN'), 'pii:read')).toBe(true);
  });

  it('reserves destructive platform controls for administrators', () => {
    for (const role of ['USER', 'SUPPORT', 'OPERATOR', 'FINANCE_ADMIN'] as Role[]) {
      for (const permission of ['kill_switch:manage', 'admin:grant_role', 'system:superuser'] as Permission[]) {
        expect(can(principal(role), permission), `${role} → ${permission}`).toBe(false);
      }
    }
    expect(can(principal('ADMIN'), 'kill_switch:manage')).toBe(true);
    expect(can(principal('ADMIN'), 'system:superuser')).toBe(false);
    expect(can(principal('SUPER_ADMIN'), 'system:superuser')).toBe(true);
  });

  it('keeps provider account handling away from users and finance', () => {
    for (const role of ['USER', 'FINANCE_ADMIN'] as Role[]) {
      expect(can(principal(role), 'provider:account:manage')).toBe(false);
    }
    expect(can(principal('OPERATOR'), 'provider:account:manage')).toBe(true);
  });

  it('treats explicit grants as additive only', () => {
    const granted = principal('USER', { grants: ['analytics:read'] });
    expect(can(granted, 'analytics:read')).toBe(true);
    expect(can(granted, 'system:superuser')).toBe(false);
    expect(effectivePermissions(granted)).toContain('analytics:read');
    // Grants never silently expand beyond the catalogue.
    expect(effectivePermissions(granted).every(isPermission)).toBe(true);
  });
});

describe('assertion helpers fail closed', () => {
  it('throws FORBIDDEN for a permission the role lacks', () => {
    expect(() => assertPermission(principal('USER'), 'wallet:adjust')).toThrowError(/permission denied/i);
    expect(() => assertAnyPermission(principal('SUPPORT'), ['kill_switch:manage', 'admin:grant_role'])).toThrowError(
      /permission denied/i,
    );
  });

  it('throws an internal error for an unknown permission string (typo safety)', () => {
    expect(() => assertPermission(principal('SUPER_ADMIN'), 'wallet:adjustt' as Permission)).toThrowError(
      /unknown permission/i,
    );
  });

  it('binds non-staff principals to their own tenant', () => {
    const user = principal('USER');
    expect(() => assertTenantAccess(user, user.tenantId)).not.toThrow();
    expect(() => assertTenantAccess(user, '00000000-0000-4000-8000-00000000000b')).toThrowError(
      /tenant scope violation/i,
    );
  });

  it('requires a staff-appropriate permission for platform access', () => {
    const staff = principal('ADMIN', { isPlatformStaff: true });
    expect(() => assertTenantAccess(staff, '00000000-0000-4000-8000-00000000000b')).not.toThrow();

    const fakeStaff = principal('USER', { isPlatformStaff: true });
    expect(() => assertTenantAccess(fakeStaff, '00000000-0000-4000-8000-00000000000b')).toThrowError(
      /tenant scope violation/i,
    );
  });

  it('snapshots a principal without sharing mutable arrays', () => {
    const original = principal('OPERATOR', { grants: ['analytics:read'] });
    const snapshot = snapshotPrincipal(original);
    snapshot.grants.push('system:superuser');
    expect(original.grants).toEqual(['analytics:read']);
  });

  it('keeps every permission reachable by at least one role (no dead catalogue entries)', () => {
    const reachable = new Set<Permission>();
    for (const role of ROLES) for (const permission of ROLE_PERMISSIONS[role]) reachable.add(permission);
    const unreachable = PERMISSIONS.filter((permission) => !reachable.has(permission));
    expect(unreachable).toEqual([]);
  });
});
