/**
 * Domain constants and enumerations shared by every application.
 * Kept framework-free so it can be imported by the web app, the bot and workers alike.
 */

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export const PROVIDER_CODES = ['mock', 'simulator', 'raja'] as const;
export type ProviderCode = (typeof PROVIDER_CODES)[number];

/** Provider compliance status gates automation (see docs/provider-research.md § 8). */
export const COMPLIANCE_STATUSES = ['APPROVED', 'NOT_REVIEWED', 'PROHIBITED'] as const;
export type ComplianceStatus = (typeof COMPLIANCE_STATUSES)[number];

export const PROVIDER_TRANSPORTS = ['HTTP_JSON', 'BROWSER', 'HYBRID'] as const;
export type ProviderTransport = (typeof PROVIDER_TRANSPORTS)[number];

export const CAPTCHA_FREQUENCIES = ['NEVER', 'SOMETIMES', 'ALWAYS', 'UNKNOWN'] as const;
export type CaptchaFrequency = (typeof CAPTCHA_FREQUENCIES)[number];

// ---------------------------------------------------------------------------
// Booking domain
// ---------------------------------------------------------------------------

/** Full booking state machine (docs/booking-state-machine.md). */
export const BOOKING_STATES = [
  'CREATED',
  'VALIDATING',
  'SCHEDULED',
  'QUEUED',
  'SEARCHING',
  'WAITING',
  'AVAILABLE',
  'LOCKED',
  'RESERVING',
  'HUMAN_VERIFICATION_REQUIRED',
  'PASSENGER_FORM',
  'READY_FOR_CHECKOUT',
  'AWAITING_USER_APPROVAL',
  'RESERVED',
  'BOOKED',
  'FAILED',
  'EXPIRED',
  'CANCELLED',
] as const;
export type BookingState = (typeof BOOKING_STATES)[number];

export const TERMINAL_BOOKING_STATES: readonly BookingState[] = ['BOOKED', 'FAILED', 'EXPIRED', 'CANCELLED'];

export function isTerminalBookingState(state: BookingState): boolean {
  return TERMINAL_BOOKING_STATES.includes(state);
}

/** States in which a booking holds a live reservation and must never be re-submitted. */
export const ACTIVE_RESERVATION_STATES: readonly BookingState[] = [
  'LOCKED',
  'RESERVING',
  'HUMAN_VERIFICATION_REQUIRED',
  'PASSENGER_FORM',
  'READY_FOR_CHECKOUT',
  'AWAITING_USER_APPROVAL',
  'RESERVED',
  'BOOKED',
];

export const AUTOMATION_MODES = ['MONITOR_ONLY', 'AUTO_FILL', 'AUTO_HOLD', 'AUTHORIZED_AUTO_BOOKING'] as const;
export type AutomationMode = (typeof AUTOMATION_MODES)[number];

/** Modes above AUTO_FILL require provider automation approval + explicit user consent. */
export const AUTOMATION_MODE_RANK: Record<AutomationMode, number> = {
  MONITOR_ONLY: 0,
  AUTO_FILL: 1,
  AUTO_HOLD: 2,
  AUTHORIZED_AUTO_BOOKING: 3,
};

export const MATCHING_MODES = ['STRICT', 'FLEXIBLE'] as const;
export type MatchingMode = (typeof MATCHING_MODES)[number];

export const MONITORING_STRATEGIES = [
  'FIXED',
  'JITTERED',
  'PRIORITY_BASED',
  'EXPONENTIAL_BACKOFF',
  'RELEASE_TIME',
  'ADAPTIVE',
] as const;
export type MonitoringStrategy = (typeof MONITORING_STRATEGIES)[number];

export const LEGS = ['OUTBOUND', 'RETURN'] as const;
export type Leg = (typeof LEGS)[number];

export const MONITOR_STATUSES = ['ACTIVE', 'PAUSED', 'SATISFIED', 'CANCELED', 'EXPIRED'] as const;
export type MonitorStatus = (typeof MONITOR_STATUSES)[number];

export const QUEUE_LEVELS = ['LOW', 'NORMAL', 'HIGH', 'PREMIUM', 'RELEASE_CRITICAL'] as const;
export type QueueLevel = (typeof QUEUE_LEVELS)[number];

export const QUEUE_LEVEL_RANK: Record<QueueLevel, number> = {
  RELEASE_CRITICAL: 0,
  PREMIUM: 1,
  HIGH: 2,
  NORMAL: 3,
  LOW: 4,
};

export const COACH_CLASSES = ['FIRST', 'SECOND', 'ECONOMY', 'SLEEPER', 'COUPE', 'BED', 'ANY'] as const;
export type CoachClass = (typeof COACH_CLASSES)[number];

export const SEAT_PREFERENCES = ['ANY', 'WINDOW', 'AISLE', 'MIDDLE', 'LOWER_BERTH', 'UPPER_BERTH', 'SAME_COMPARTMENT'] as const;
export type SeatPreference = (typeof SEAT_PREFERENCES)[number];

export const GENDERS = ['MALE', 'FEMALE', 'ANY'] as const;
export type Gender = (typeof GENDERS)[number];

export const PASSENGER_CATEGORIES = ['ADULT', 'CHILD', 'INFANT', 'SENIOR', 'STUDENT'] as const;
export type PassengerCategory = (typeof PASSENGER_CATEGORIES)[number];

export const TRAIN_PREFERENCE_KINDS = ['ANY', 'PREFERRED', 'EXCLUDED'] as const;
export type TrainPreferenceKind = (typeof TRAIN_PREFERENCE_KINDS)[number];

/** Error/retry classification (docs/booking-state-machine.md § 6). */
export const FAILURE_CLASSES = [
  'NETWORK',
  'TIMEOUT',
  'AUTH',
  'VALIDATION',
  'SOLD_OUT',
  'PAYMENT',
  'CAPTCHA',
  'RATE_LIMIT',
  'SCHEMA',
  'BUDGET',
  'CAPACITY',
  'UNKNOWN',
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

// ---------------------------------------------------------------------------
// Identity / access
// ---------------------------------------------------------------------------

export const ROLES = ['USER', 'SUPPORT', 'OPERATOR', 'FINANCE_ADMIN', 'ADMIN', 'SUPER_ADMIN'] as const;
export type Role = (typeof ROLES)[number];

export const USER_STATUSES = ['ACTIVE', 'SUSPENDED', 'PENDING_VERIFICATION', 'DELETION_PENDING', 'DELETED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const TENANT_STATUSES = ['ACTIVE', 'SUSPENDED', 'DELETED'] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

export const LOCALES = ['fa', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

export const LEDGER_TYPES = [
  'DEPOSIT',
  'REFUND',
  'SERVICE_CHARGE',
  'BOOKING_CHARGE',
  'BONUS',
  'PROMO',
  'ADMIN_ADJUSTMENT',
  'CHARGE_HOLD',
  'CHARGE_RELEASE',
  'REVERSAL',
] as const;
export type LedgerType = (typeof LEDGER_TYPES)[number];

export const LEDGER_STATUSES = ['PENDING', 'POSTED', 'RELEASED', 'REVERSED'] as const;
export type LedgerStatus = (typeof LEDGER_STATUSES)[number];

/** Types that move real balance immediately (PENDING holds do not). */
export const LEDGER_POSTING_TYPES: readonly LedgerType[] = [
  'DEPOSIT',
  'REFUND',
  'SERVICE_CHARGE',
  'BOOKING_CHARGE',
  'BONUS',
  'PROMO',
  'ADMIN_ADJUSTMENT',
  'REVERSAL',
];

export const PAYMENT_STATUSES = [
  'CREATED',
  'PENDING',
  'PAID',
  'FAILED',
  'EXPIRED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const INVOICE_STATUSES = ['DRAFT', 'ISSUED', 'PAID', 'VOID', 'REFUNDED'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const SUBSCRIPTION_STATUSES = ['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const BILLING_INTERVALS = ['MONTHLY', 'QUARTERLY', 'YEARLY'] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

export const PLAN_CODES = ['FREE', 'STANDARD', 'PRO', 'PREMIUM', 'BUSINESS'] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

/** Plan tier weight for fair scheduling (docs/scheduler.md § 4). */
export const PLAN_SCHEDULING_WEIGHT: Record<PlanCode, number> = {
  FREE: 1,
  STANDARD: 2,
  PRO: 4,
  PREMIUM: 8,
  BUSINESS: 8,
};

export const COUPON_TYPES = ['PERCENT', 'FIXED', 'WALLET_BONUS', 'FREE_DAYS', 'FEATURE_UNLOCK'] as const;
export type CouponType = (typeof COUPON_TYPES)[number];

export const REFERRAL_STATUSES = ['PENDING', 'QUALIFIED', 'REWARDED', 'REJECTED'] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];

export const REFERRAL_REWARD_TYPES = ['WALLET_CREDIT', 'SUBSCRIPTION_DAYS', 'PERCENT_BONUS'] as const;
export type ReferralRewardType = (typeof REFERRAL_REWARD_TYPES)[number];

/** Entitlement feature keys — plan behaviour is data, never `if (plan === 'PRO')` (spec § 31). */
export const FEATURE_KEYS = [
  'telegramNotifications',
  'webNotifications',
  'emailNotifications',
  'autoFill',
  'autoHold',
  'authorizedAutoBooking',
  'highDemandMode',
  'sessionWarmup',
  'advancedMatching',
  'priceMonitoring',
  'multiDateMonitoring',
  'priorityQueue',
  'seatSelection',
  'returnTrips',
  'apiAccess',
  'supportPriority',
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

/** Metered quota keys (spec § 32). */
export const QUOTA_METERS = [
  'searches',
  'monitoring_hours',
  'booking_attempts',
  'successful_reservations',
  'priority_jobs',
  'sms_notifications',
  'high_demand_windows',
] as const;
export type QuotaMeter = (typeof QUOTA_METERS)[number];

export const QUOTA_PERIODS = ['DAILY', 'MONTHLY', 'LIFETIME'] as const;
export type QuotaPeriod = (typeof QUOTA_PERIODS)[number];

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export const NOTIFICATION_EVENTS = [
  'ticket_found',
  'price_increased',
  'price_dropped',
  'booking_started',
  'verification_required',
  'approval_required',
  'booking_success',
  'booking_failure',
  'booking_expired',
  'booking_canceled',
  'subscription_expiring',
  'subscription_expired',
  'wallet_low',
  'payment_success',
  'payment_failed',
  'quota_warning',
  'security_login_new_device',
  'security_refresh_reuse',
  'telegram_linked',
  'telegram_unlinked',
  'referral_rewarded',
  'release_window_armed',
  'release_window_started',
  'maintenance_notice',
  'support_reply',
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

export const NOTIFICATION_CHANNELS = ['telegram', 'web', 'email', 'sms', 'push'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_CATEGORIES = ['availability', 'price', 'booking', 'billing', 'security', 'system', 'support'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/** Categories that may not be disabled (security/financial obligations, spec § 47). */
export const MANDATORY_NOTIFICATION_CATEGORIES: readonly NotificationCategory[] = ['security'];

export const NOTIFICATION_EVENT_META: Record<NotificationEvent, { category: NotificationCategory; mandatory?: boolean }> = {
  ticket_found: { category: 'availability' },
  price_increased: { category: 'price' },
  price_dropped: { category: 'price' },
  booking_started: { category: 'booking' },
  verification_required: { category: 'booking', mandatory: true },
  approval_required: { category: 'booking', mandatory: true },
  booking_success: { category: 'booking' },
  booking_failure: { category: 'booking' },
  booking_expired: { category: 'booking' },
  booking_canceled: { category: 'booking' },
  subscription_expiring: { category: 'billing' },
  subscription_expired: { category: 'billing', mandatory: true },
  wallet_low: { category: 'billing' },
  payment_success: { category: 'billing', mandatory: true },
  payment_failed: { category: 'billing', mandatory: true },
  quota_warning: { category: 'billing' },
  security_login_new_device: { category: 'security', mandatory: true },
  security_refresh_reuse: { category: 'security', mandatory: true },
  telegram_linked: { category: 'security', mandatory: true },
  telegram_unlinked: { category: 'security', mandatory: true },
  referral_rewarded: { category: 'billing' },
  release_window_armed: { category: 'availability' },
  release_window_started: { category: 'availability' },
  maintenance_notice: { category: 'system' },
  support_reply: { category: 'support' },
};

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export const MAINTENANCE_MODES = ['NONE', 'MONITORING_ONLY', 'BOOKING_DISABLED', 'PROVIDER', 'FULL'] as const;
export type MaintenanceMode = (typeof MAINTENANCE_MODES)[number];

export const BREAKER_STATES = ['CLOSED', 'OPEN', 'HALF_OPEN'] as const;
export type BreakerState = (typeof BREAKER_STATES)[number];

export const PROXY_PROTOCOLS = ['HTTP', 'HTTPS', 'SOCKS5'] as const;
export type ProxyProtocol = (typeof PROXY_PROTOCOLS)[number];

export const PROXY_STRATEGIES = ['DIRECT', 'STATIC', 'ROUND_ROBIN', 'WEIGHTED', 'HEALTH_BASED', 'REGION_BASED'] as const;
export type ProxyStrategy = (typeof PROXY_STRATEGIES)[number];

/**
 * Account assignment strategies.
 * Note: none of these may be used to evade provider restrictions (TM-12) — the interface
 * intentionally exposes no counter tied to restriction signals.
 */
export const ACCOUNT_ASSIGNMENT_STRATEGIES = ['ROUND_ROBIN', 'LEAST_RECENTLY_USED', 'STICKY_PER_USER', 'DEDICATED'] as const;
export type AccountAssignmentStrategy = (typeof ACCOUNT_ASSIGNMENT_STRATEGIES)[number];

export const PROVIDER_ACCOUNT_STATUSES = ['ACTIVE', 'COOLDOWN', 'QUARANTINED', 'DISABLED'] as const;
export type ProviderAccountStatus = (typeof PROVIDER_ACCOUNT_STATUSES)[number];

export const SESSION_STATUSES = ['VALID', 'EXPIRED', 'INVALIDATED'] as const;
export type ProviderSessionStatus = (typeof SESSION_STATUSES)[number];

export const SUPPORT_TICKET_CATEGORIES = ['billing', 'booking', 'technical', 'provider'] as const;
export type SupportTicketCategory = (typeof SUPPORT_TICKET_CATEGORIES)[number];

export const SUPPORT_TICKET_STATUSES = ['OPEN', 'PENDING', 'RESOLVED', 'CLOSED'] as const;
export type SupportTicketStatus = (typeof SUPPORT_TICKET_STATUSES)[number];

export const FRAUD_SIGNAL_TYPES = [
  'UNUSUAL_SIGNUP_VELOCITY',
  'COUPON_ABUSE',
  'REFERRAL_FARMING',
  'RAPID_WALLET_OPERATIONS',
  'EXCESSIVE_MONITOR_CREATION',
  'REPEATED_FAILED_PAYMENTS',
  'IMPOSSIBLE_TRAVEL_PATTERN',
] as const;
export type FraudSignalType = (typeof FRAUD_SIGNAL_TYPES)[number];

export const FRAUD_SIGNAL_STATUSES = ['OPEN', 'REVIEWED', 'DISMISSED'] as const;
export type FraudSignalStatus = (typeof FRAUD_SIGNAL_STATUSES)[number];

// ---------------------------------------------------------------------------
// Queue topology (spec § 62)
// ---------------------------------------------------------------------------

export const QUEUE_NAMES = [
  'availability',
  'booking',
  'provider-sync',
  'notifications',
  'billing',
  'session-refresh',
  'maintenance',
  'analytics',
] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

// ---------------------------------------------------------------------------
// Miscellaneous limits
// ---------------------------------------------------------------------------

export const LIMITS = {
  /** Absolute server-side floor for a monitor interval, whatever the plan says. */
  MIN_MONITOR_INTERVAL_SECONDS: 20,
  MAX_MONITOR_INTERVAL_SECONDS: 3600,
  MAX_DATE_RANGE_DAYS: 62,
  MAX_PASSENGERS_PER_BOOKING: 10,
  MAX_ACTIVE_MONITORS_ABSOLUTE: 200,
  MAX_PAGE_SIZE: 100,
  DEFAULT_PAGE_SIZE: 20,
  /** Jittered scheduling default (spec § 12: 60 s ± 15 s). */
  DEFAULT_MONITOR_INTERVAL_SECONDS: 60,
  DEFAULT_JITTER_RATIO: 0.25,
  /** Burst validation offsets after an availability observation (spec § 15). */
  BURST_VALIDATION_OFFSETS_SECONDS: [0, 3, 10] as const,
  /** Approval window before an awaiting-user approval expires. */
  DEFAULT_APPROVAL_WINDOW_MINUTES: 10,
  /** Human verification window (spec § 21). */
  DEFAULT_VERIFICATION_WINDOW_MINUTES: 15,
} as const;
