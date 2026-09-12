/**
 * Explicit permission catalogue and role matrix (spec § 54, TM-02).
 *
 * Rules:
 *  - deny by default: a permission is granted only if it appears in the role's explicit set
 *  - finance roles never receive `pii:read`; support sees masked data only
 *  - `pii:read` is deliberately separate from every read permission and must be paired with a
 *    recorded justification when used (see docs/security.md)
 */

import { ROLES, type Role } from './constants';

export const PERMISSIONS = [
  // ---- self-service (owner scope, always bound to the authenticated principal) ----
  'profile:read',
  'profile:write',
  'passenger:manage',
  'booking:manage:own',
  'monitor:manage:own',
  'wallet:read:own',
  'wallet:deposit:own',
  'subscription:read:own',
  'invoice:read:own',
  'notification:read:own',
  'notification:preferences:own',
  'support:create:own',
  'referral:manage:own',
  'telegram:link:own',
  'session:manage:own',
  'data:export:own',
  'data:delete:own',
  'approval:grant:own',
  'verification:complete:own',

  // ---- support (cross-tenant reads are still masked + audited) ----
  'user:read:any',
  'user:read:masked',
  'booking:read:any',
  'support:read:any',
  'support:write:any',
  'notification:send:any',
  'session:revoke:any',
  'provider:session:inspect:masked',

  // ---- operations ----
  'provider:manage',
  'provider:account:manage',
  'proxy:manage',
  'worker:manage',
  'queue:manage',
  'release:manage',
  'maintenance:manage',
  'feature_flag:manage',
  'system_setting:manage',
  'diagnostics:read',

  // ---- finance ----
  'wallet:read:any',
  'wallet:adjust',
  'invoice:read:any',
  'invoice:manage',
  'payment:read:any',
  'payment:refund',
  'subscription:manage',
  'plan:manage',
  'coupon:manage',
  'reconciliation:run',
  'referral:review',
  'quota:adjust',
  'analytics:read:financial',

  // ---- administration ----
  'user:suspend',
  'user:restore',
  'audit:read',
  'fraud:review',
  'pii:read',
  'admin:grant_role',
  'kill_switch:manage',
  'analytics:read',
  'system:superuser',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const SELF_PERMISSIONS: Permission[] = [
  'profile:read',
  'profile:write',
  'passenger:manage',
  'booking:manage:own',
  'monitor:manage:own',
  'wallet:read:own',
  'wallet:deposit:own',
  'subscription:read:own',
  'invoice:read:own',
  'notification:read:own',
  'notification:preferences:own',
  'support:create:own',
  'referral:manage:own',
  'telegram:link:own',
  'session:manage:own',
  'data:export:own',
  'data:delete:own',
  'approval:grant:own',
  'verification:complete:own',
];

const SUPPORT_PERMISSIONS: Permission[] = [
  ...SELF_PERMISSIONS,
  'user:read:any',
  'user:read:masked',
  'booking:read:any',
  'support:read:any',
  'support:write:any',
  'notification:send:any',
  'session:revoke:any',
  'provider:session:inspect:masked',
];

const OPERATOR_PERMISSIONS: Permission[] = [
  ...SUPPORT_PERMISSIONS,
  'provider:manage',
  'provider:account:manage',
  'proxy:manage',
  'worker:manage',
  'queue:manage',
  'release:manage',
  'maintenance:manage',
  'feature_flag:manage',
  'system_setting:manage',
  'diagnostics:read',
];

const FINANCE_PERMISSIONS: Permission[] = [
  ...SELF_PERMISSIONS,
  'user:read:any',
  'user:read:masked',
  'support:read:any',
  'wallet:read:any',
  'wallet:adjust',
  'invoice:read:any',
  'invoice:manage',
  'payment:read:any',
  'payment:refund',
  'subscription:manage',
  'plan:manage',
  'coupon:manage',
  'reconciliation:run',
  'referral:review',
  'quota:adjust',
  'analytics:read:financial',
  'audit:read',
];

const ADMIN_PERMISSIONS: Permission[] = dedupe([
  ...OPERATOR_PERMISSIONS,
  ...FINANCE_PERMISSIONS,
  'user:suspend',
  'user:restore',
  'audit:read',
  'fraud:review',
  'pii:read',
  'admin:grant_role',
  'kill_switch:manage',
  'analytics:read',
]);

const SUPER_ADMIN_PERMISSIONS: Permission[] = dedupe([...ADMIN_PERMISSIONS, 'system:superuser']);

function dedupe(values: Permission[]): Permission[] {
  return [...new Set(values)];
}

/** Authoritative role → permission matrix. */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  USER: SELF_PERMISSIONS,
  SUPPORT: SUPPORT_PERMISSIONS,
  OPERATOR: OPERATOR_PERMISSIONS,
  FINANCE_ADMIN: FINANCE_PERMISSIONS,
  ADMIN: ADMIN_PERMISSIONS,
  SUPER_ADMIN: SUPER_ADMIN_PERMISSIONS,
};

export function permissionsForRole(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Permission check for a principal with the given role and optional explicit grants.
 * Explicit grants can only *add* permissions (never remove), and only privileged actors may
 * create them (enforced in the auth service).
 */
export function hasPermission(
  role: Role,
  permission: Permission,
  grants: readonly Permission[] = [],
): boolean {
  return ROLE_PERMISSIONS[role].includes(permission) || grants.includes(permission);
}

export interface Principal {
  readonly userId: string;
  readonly tenantId: string;
  readonly role: Role;
  readonly grants: readonly Permission[];
  readonly isPlatformStaff: boolean;
}

export function principalCan(principal: Principal, permission: Permission): boolean {
  return hasPermission(principal.role, permission, principal.grants);
}

/** Permissions that must never be handed to a non-staff role, used by validation tests. */
export const PLATFORM_ONLY_PERMISSIONS: readonly Permission[] = [
  'pii:read',
  'admin:grant_role',
  'kill_switch:manage',
  'system:superuser',
  'wallet:adjust',
  'payment:refund',
  'audit:read',
];

export const MASKED_FIELD_PLACEHOLDER = '••••••';

/** Mask a value for display while keeping a support-useful hint. */
export function maskValue(value: string | null | undefined, visible = 4): string {
  if (!value) return '';
  if (value.length <= visible) return MASKED_FIELD_PLACEHOLDER;
  return `${MASKED_FIELD_PLACEHOLDER}${value.slice(-visible)}`;
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return MASKED_FIELD_PLACEHOLDER;
  const head = local.slice(0, 1);
  return `${head}${MASKED_FIELD_PLACEHOLDER}@${domain}`;
}

/** Iranian national id (کد ملی) masking: keep nothing but the length hint. */
export function maskNationalId(value: string): string {
  return `کد ملی: ${MASKED_FIELD_PLACEHOLDER} (${value.length} رقم)`;
}
