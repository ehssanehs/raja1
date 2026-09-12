/**
 * Authorization at the service boundary (TM-02).
 *
 * Every service method that touches tenant data takes an authenticated `Principal` and asserts a
 * permission before doing anything else. Two structural rules are enforced here:
 *
 *  1. **Deny by default** — the permission catalogue and role matrix live in `@raja/shared`; an
 *     unknown permission is a programming error, never a bypass.
 *  2. **Scope is not a privilege** — staff with `tenant:read:any`-style permissions do not get
 *     cross-tenant *writes*; cross-tenant access requires an explicit `platform` principal and is
 *     recorded by the caller in the audit trail.
 */
import {
  AppError,
  forbidden,
  hasPermission,
  isPermission,
  permissionsForRole,
  tenantScopeViolation,
  type Permission,
  type Principal,
  type Role,
} from '@raja/shared';

export function can(principal: Principal, permission: Permission): boolean {
  return hasPermission(principal.role, permission, principal.grants);
}

export function canAll(principal: Principal, permissions: readonly Permission[]): boolean {
  return permissions.every((permission) => can(principal, permission));
}

export function canAny(principal: Principal, permissions: readonly Permission[]): boolean {
  return permissions.some((permission) => can(principal, permission));
}

export function assertPermission(principal: Principal, permission: Permission): void {
  if (!isPermission(permission)) {
    // A typo in a permission string must fail closed, loudly, and never grant access.
    throw new AppError('INTERNAL_ERROR', `unknown permission requested: ${String(permission)}`, {
      userMessageKey: 'error.internal',
    });
  }
  if (!can(principal, permission)) {
    // The permission name is diagnostic detail, not a user-facing message: clients localize
    // `error.forbidden`, and logs get the machine-readable code.
    throw forbidden('permission denied', { permission, role: principal.role });
  }
}

export function assertAnyPermission(principal: Principal, permissions: readonly Permission[]): void {
  if (!canAny(principal, permissions)) {
    throw forbidden('permission denied', { permissions: [...permissions], role: principal.role });
  }
}

/**
 * Ensure the principal may act on the given tenant. A normal user is bound to their own tenant;
 * platform staff must be explicitly flagged and the caller must record a justification.
 */
export function assertTenantAccess(principal: Principal, tenantId: string): void {
  if (principal.isPlatformStaff) {
    if (!can(principal, 'system:superuser') && !can(principal, 'audit:read')) {
      throw tenantScopeViolation({ reason: 'platform staff without an audit/superuser permission' });
    }
    return;
  }
  if (principal.tenantId !== tenantId) {
    throw tenantScopeViolation({ reason: 'principal tenant does not match the requested tenant' });
  }
}

/** Convenience: assert a permission *and* a tenant match in one call (used by API guards). */
export function authorize(principal: Principal, tenantId: string, permission: Permission): void {
  assertPermission(principal, permission);
  assertTenantAccess(principal, tenantId);
}

export interface PrincipalSnapshot {
  userId: string;
  tenantId: string;
  role: Role;
  grants: Permission[];
  isPlatformStaff: boolean;
}

export function snapshotPrincipal(principal: Principal): PrincipalSnapshot {
  return {
    userId: principal.userId,
    tenantId: principal.tenantId,
    role: principal.role,
    grants: [...principal.grants],
    isPlatformStaff: principal.isPlatformStaff,
  };
}

/**
 * Effective permissions of a principal (role matrix + explicit grants), deduplicated. Used by the
 * web app to render menus and by the API to answer `/me`.
 */
export function effectivePermissions(principal: Principal): Permission[] {
  const base = permissionsForRole(principal.role);
  return [...new Set<Permission>([...base, ...principal.grants])];
}
