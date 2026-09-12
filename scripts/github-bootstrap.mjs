#!/usr/bin/env node
/**
 * Idempotent GitHub bootstrap: labels, milestones and the issue programme.
 * Mirrors docs/github-plan.md.
 *
 *   node scripts/github-bootstrap.mjs --repo ehssanehs/raja1 [--dry-run]
 *
 * Safe to re-run: existing labels/milestones/issues (matched by title) are skipped.
 */
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const repoIdx = args.indexOf('--repo');
const REPO = repoIdx >= 0 ? args[repoIdx + 1] : 'ehssanehs/raja1';
const DRY = args.includes('--dry-run');

const gh = (argv, input) => {
  if (DRY) {
    console.log(`[dry-run] gh ${argv.join(' ')}`);
    return '';
  }
  return execFileSync('gh', [...argv, '--repo', REPO], {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
};

const LABELS = [
  ['type:feature', '1D76DB', 'New capability'],
  ['type:bug', 'D73A4A', 'Something is broken'],
  ['type:docs', '0075CA', 'Documentation'],
  ['type:test', 'FBCA04', 'Testing'],
  ['type:security', 'B60205', 'Security work'],
  ['type:chore', 'C5DEF5', 'Maintenance'],
  ['area:api', '5319E7', 'API service'],
  ['area:web', '5319E7', 'Web application'],
  ['area:bot', '5319E7', 'Telegram bot'],
  ['area:worker', '5319E7', 'Worker'],
  ['area:scheduler', '5319E7', 'Scheduler'],
  ['area:db', '5319E7', 'Database'],
  ['area:billing', '5319E7', 'Billing/wallet'],
  ['area:provider', '5319E7', 'Provider integration'],
  ['area:security', '5319E7', 'Security'],
  ['area:devops', '5319E7', 'DevOps/deployment'],
  ['priority:critical', 'B60205', 'Critical priority'],
  ['priority:high', 'D93F0B', 'High priority'],
  ['priority:medium', 'FBCA04', 'Medium priority'],
  ['priority:low', '0E8A16', 'Low priority'],
  ['risk:pii', '8B4789', 'Personal data involved'],
  ['risk:financial', '8B4789', 'Financial integrity involved'],
  ['risk:compliance', '8B4789', 'Provider compliance involved'],
  ['status:blocked', '000000', 'Blocked'],
  ['status:needs-review', '000000', 'Needs review'],
];

const MILESTONES = [
  ['M0 — Research & Compliance Gate', 'Provider research documented; compliance gate + exit criteria published.', 'Research & compliance'],
  ['M1 — Architecture & Threat Model', 'Architecture, domain model, state machine, threat model, ADRs reviewed and merged.', 'Architecture'],
  ['M2 — Platform Foundation', 'Monorepo, config, logging, crypto, DB + migrations, CI, Docker skeleton.', 'Foundation'],
  ['M3 — Authentication & Tenancy', 'AuthN (Argon2id, JWT + refresh rotation), RBAC, tenant isolation, sessions, audit.', 'Security'],
  ['M4 — Booking Domain', 'Booking requests, monitors, state machine, matching/scoring, timeline, passengers.', 'Booking'],
  ['M5 — Provider Framework', 'Provider SDK, capability flags, mock + simulator adapters, contract tests.', 'Providers'],
  ['M6 — Monitoring Engine', 'Scheduler, strategies, rate limiter, fairness, breaker, health scores, release mode.', 'Monitoring'],
  ['M7 — Telegram Bot', 'Bilingual bot, linking, wizard, notifications, approval callbacks.', 'Telegram'],
  ['M8 — Web Application', 'Next.js app: dashboard, wizard, monitors, passengers, wallet, invoices, settings.', 'Web'],
  ['M9 — SaaS Billing', 'Plans, entitlements, quotas, wallet ledger, payments, invoices, coupons, referrals.', 'Billing'],
  ['M10 — Admin & Operations', 'Admin dashboards, release console, kill switch, maintenance, support, flags.', 'Admin'],
  ['M11 — Security Hardening', 'Threat-model fixes, abuse controls, webhook hardening, security tests, review.', 'Security'],
  ['M12 — Testing & Chaos', 'E2E, chaos/failure, billing edge cases, provider simulator scenarios.', 'Quality'],
  ['M13 — Deployment', 'Docker/compose, reverse proxy, backups/restore, DR, release workflow.', 'Deployment'],
  ['M14 — Production Readiness', 'Checklist, load test, adversarial review, readiness report.', 'Production'],
];

/** @type {{key:string,title:string,labels:string[],milestone:string,criteria:string[],docs?:string}[]} */
const ISSUES = [
  { key: 'M0-01', title: 'Provider research document (availability, auth, sessions, booking flow, limits)', labels: ['type:docs', 'area:provider', 'risk:compliance', 'priority:critical'], milestone: 'M0', criteria: ['Documented API availability (none public) with sources', 'Auth/session behaviour mapped incl. national-ID + OTP verification', 'Release-window pattern verified from official announcements', 'Rate-limit/throttling policy defined and conservative by default', 'Open questions Q1–Q10 tracked with owners'], docs: 'docs/provider-research.md' },
  { key: 'M0-02', title: 'Compliance gate + provider capability flags', labels: ['type:feature', 'area:provider', 'risk:compliance', 'priority:critical'], milestone: 'M0', criteria: ['Capability flags defined (seat selection, hold, auto-booking, captcha, return trips, price filtering)', 'Compliance review status gates adapter enablement', 'Automation above MONITOR_ONLY impossible without APPROVED status', 'Exit criteria G1–G10 published'], docs: 'docs/provider-adapter.md' },
  { key: 'M0-03', title: 'Open research questions register with owners', labels: ['type:docs', 'area:provider', 'priority:medium'], milestone: 'M0', criteria: ['Q1–Q10 listed with owner and blocking gate', 'Reviewed each milestone for progress'], docs: 'docs/provider-research.md#10' },
  { key: 'M0-04', title: 'Abstention policy: no CAPTCHA bypass, no evasion, no account rotation', labels: ['type:docs', 'type:security', 'risk:compliance', 'priority:critical'], milestone: 'M0', criteria: ['Policy documented in architecture + security docs', 'Codified as tests that fail if evasion features are added', 'ADR recorded'], docs: 'docs/adr/0008-no-captcha-bypass-no-evasion.md' },

  { key: 'M1-01', title: 'System architecture document with diagrams', labels: ['type:docs', 'priority:critical'], milestone: 'M1', criteria: ['Context, container, module, tenancy, deployment diagrams', 'Module dependency rule stated and enforced', 'Failure/degradation strategy table'], docs: 'docs/architecture.md' },
  { key: 'M1-02', title: 'Domain model, tenant isolation rules and index plan', labels: ['type:docs', 'area:db', 'priority:critical'], milestone: 'M1', criteria: ['Entity catalogue for all required entities', 'Isolation rules per layer (API/DB/cache/queue/notifications/logs)', 'Encryption map for sensitive fields', 'Index plan for hot paths'], docs: 'docs/domain-model.md' },
  { key: 'M1-03', title: 'Booking state machine with guards and concurrency model', labels: ['type:docs', 'area:worker', 'priority:critical'], milestone: 'M1', criteria: ['All states and transitions with guards', 'Six-layer duplicate-booking protection', 'Error classification → retry policy mapping'], docs: 'docs/booking-state-machine.md' },
  { key: 'M1-04', title: 'Threat model (TM-01..TM-28) with residual risk register', labels: ['type:docs', 'type:security', 'risk:pii', 'risk:financial', 'priority:critical'], milestone: 'M1', criteria: ['STRIDE per trust boundary', 'Domain threats (ledger, provider compliance, scalping) covered', 'Each threat mapped to test artifacts', 'Residual risks accepted explicitly'], docs: 'docs/threat-model.md' },
  { key: 'M1-05', title: 'ADRs 0001–0008 (monolith, provider boundary, ledger, dry-run, money, scheduler, abstention)', labels: ['type:docs', 'priority:high'], milestone: 'M1', criteria: ['Each ADR has context, decision, consequences, rejected alternatives'], docs: 'docs/adr/' },
  { key: 'M1-06', title: 'Scheduler and high-demand mode design', labels: ['type:docs', 'area:scheduler', 'priority:high'], milestone: 'M1', criteria: ['Strategies, fairness algorithm, token buckets, breaker documented', 'Release-window lifecycle + warm-up + capacity protection documented'], docs: 'docs/scheduler.md' },

  { key: 'M2-01', title: 'Monorepo workspaces, strict TypeScript, lint and formatting', labels: ['type:chore', 'priority:high'], milestone: 'M2', criteria: ['npm workspaces with 12 packages + 6 apps', 'Strict TS with noUncheckedIndexedAccess', 'ESLint + Prettier configured and green'] },
  { key: 'M2-02', title: 'Zod-validated configuration with fail-closed production guards', labels: ['type:feature', 'priority:critical', 'risk:compliance'], milestone: 'M2', criteria: ['Every env var validated with types and defaults', 'DRY_RUN defaults true; production live-booking requires explicit multi-signal config', 'Weak/default secrets rejected in production mode', 'Config summary is loggable with secrets redacted'], docs: 'docs/architecture.md' },
  { key: 'M2-03', title: 'Structured PII-redacting logger with correlation IDs', labels: ['type:feature', 'area:security', 'risk:pii', 'priority:critical'], milestone: 'M2', criteria: ['pino JSON logs with bound correlationId/tenantId/userId', 'Redaction of nationalId/passport/cookies/tokens/passwords/card data', 'Regression test: synthetic PII payload never appears in output'], docs: 'docs/security.md' },
  { key: 'M2-04', title: 'Crypto: Argon2id password hashing, AES-256-GCM envelope encryption, key ring, HMAC lookup hashes', labels: ['type:feature', 'type:security', 'risk:pii', 'priority:critical'], milestone: 'M2', criteria: ['Versioned envelope format enc:v1:keyId:iv:ct:tag', 'Key-ring rotation support', 'Constant-time comparisons', 'Deterministic HMAC for equality lookups (national ID dedup)'] },
  { key: 'M2-05', title: 'Database layer: pool, transaction helper, tenancy-typed repositories, PGlite test harness, migration runner', labels: ['type:feature', 'area:db', 'priority:critical'], milestone: 'M2', criteria: ['TenantScope required by repository signatures (compile-time)', 'assertScopedSql runtime guard raising TenantScopeViolation', 'Forward-only migration runner with checksums + advisory lock', 'Integration tests run against real Postgres semantics without a server'], docs: 'docs/domain-model.md' },
  { key: 'M2-06', title: 'Migration 0001: full schema (platform, tenancy, provider, booking, billing, ops) with indexes', labels: ['type:feature', 'area:db', 'priority:critical'], milestone: 'M2', criteria: ['All entities from the domain model created', 'tenant_id NOT NULL on tenant tables with composite FKs', 'Hot-path indexes incl. partial indexes', 'Money as bigint minor units + currency'] },
  { key: 'M2-07', title: 'Migration 0002: hardening (CHECK constraints, append-only guards, hash-chained audit)', labels: ['type:feature', 'area:db', 'type:security', 'risk:financial', 'priority:critical'], milestone: 'M2', criteria: ['Ledger immutability triggers (UPDATE/DELETE blocked)', 'Audit chain (prev_hash/entry_hash) + verification function', 'Amount/direction CHECK constraints', 'Quota and credit non-negative checks'] },
  { key: 'M2-08', title: 'Migration 0003: seed plans, feature flags, system settings, providers, stations, routes', labels: ['type:feature', 'area:db', 'priority:high'], milestone: 'M2', criteria: ['Five plans (FREE/STANDARD/PRO/PREMIUM/BUSINESS) with entitlements and prices', 'Feature flags incl. autoFillEnabled/highDemandEnabled/walletEnabled/referralsEnabled', 'Mock + simulator providers registered with compliance status', 'Station catalogue with fa/en names and aliases'] },
  { key: 'M2-09', title: 'CI workflow: lint, typecheck, unit, integration, build, dependency audit', labels: ['type:chore', 'area:devops', 'priority:high'], milestone: 'M2', criteria: ['Runs on push + PR', 'No network/provider access required', 'Coverage uploaded', 'Fails on lint/type/test errors'] },

  { key: 'M3-01', title: 'Password hashing and strength policy', labels: ['type:feature', 'area:security', 'priority:high'], milestone: 'M3', criteria: ['Argon2id with documented parameters', 'Strength validation + common-password rejection', 'Rehash-on-login hook'] },
  { key: 'M3-02', title: 'Access/refresh JWT with rotation, hashed storage and family revocation', labels: ['type:feature', 'area:security', 'priority:critical'], milestone: 'M3', criteria: ['Access token 15 min, refresh rotated on every use', 'Refresh tokens stored SHA-256 hashed with family id', 'Reuse detection revokes the whole family + notifies user'], docs: 'docs/security.md' },
  { key: 'M3-03', title: 'Session management, revocation and login-anomaly notification', labels: ['type:feature', 'area:security', 'priority:high'], milestone: 'M3', criteria: ['List/revoke sessions per user', 'New-IP-hash login triggers security notification', 'Admin can revoke all sessions of a user'] },
  { key: 'M3-04', title: 'RBAC: roles, permission catalogue, deny-by-default guards and matrix tests', labels: ['type:feature', 'area:security', 'type:security', 'priority:critical'], milestone: 'M3', criteria: ['USER/SUPPORT/OPERATOR/FINANCE_ADMIN/ADMIN/SUPER_ADMIN with explicit permissions', 'Finance role cannot read passenger PII; support sees masked data', 'Full role × permission matrix asserted by tests'], docs: 'docs/security.md' },
  { key: 'M3-05', title: 'Tenant scoping in repositories + automated IDOR sweep', labels: ['type:feature', 'area:db', 'type:security', 'priority:critical'], milestone: 'M3', criteria: ['Every tenant repository method requires a scope', 'Cross-tenant read/update/delete attempts fail', 'Sweep test over all repositories and HTTP endpoints'] },
  { key: 'M3-06', title: 'Auth endpoint rate limiting (per IP and per account)', labels: ['type:feature', 'area:security', 'priority:high'], milestone: 'M3', criteria: ['Login/reset/register limited with sliding windows', 'Lockout semantics documented and tested', 'Uniform responses preventing user enumeration'] },
  { key: 'M3-07', title: 'Audit events for auth lifecycle and sensitive operations', labels: ['type:feature', 'area:security', 'priority:high'], milestone: 'M3', criteria: ['login/logout/refresh-reuse/password-change/link events', 'Immutable rows with correlation id', 'No secret material in audit payloads'] },

  { key: 'M4-01', title: 'Booking request model and validation pipeline', labels: ['type:feature', 'area:worker', 'priority:critical'], milestone: 'M4', criteria: ['Origin/destination/dates/return/preferences/passengers/class/price ceiling validated', 'Provider sale-window and route validation', 'Entitlement + quota checks server-side', 'Idempotency key honoured'] },
  { key: 'M4-02', title: 'Multi-date monitors, priorities and automatic lower-priority cancellation', labels: ['type:feature', 'area:worker', 'priority:high'], milestone: 'M4', criteria: ['One monitor per date/leg with priority ordering', 'After success, lower-priority monitors cancelled and users told', 'Configurable via booking request option'] },
  { key: 'M4-03', title: 'Booking state machine implementation with transition log and property tests', labels: ['type:feature', 'area:worker', 'priority:critical'], milestone: 'M4', criteria: ['Central transition validation; no direct status writes', 'Transition + timeline row per change', 'Property tests for invariants (terminal states, money pairing)'], docs: 'docs/booking-state-machine.md' },
  { key: 'M4-04', title: 'Matching and scoring engine (STRICT/FLEXIBLE) with preference weights', labels: ['type:feature', 'area:worker', 'priority:high'], milestone: 'M4', criteria: ['Score components: departure proximity, arrival preference, class, train, seat, price, duration, date priority', 'STRICT rejects anything outside constraints; FLEXIBLE ranks candidates', 'Explained score breakdown persisted'] },
  { key: 'M4-05', title: 'Price monitoring, maximum-price enforcement and price-change detection', labels: ['type:feature', 'area:worker', 'risk:financial', 'priority:high'], milestone: 'M4', criteria: ['Observations stored with integer minor units + currency', 'Never book above user maximum', 'Price-drop and price-increase notifications with dedup'] },
  { key: 'M4-06', title: 'Result deduplication via normalized availability fingerprint', labels: ['type:feature', 'area:worker', 'priority:medium'], milestone: 'M4', criteria: ['Fingerprint stable across cosmetic response changes', 'Duplicate results never re-notify', 'Unique index enforces per-request uniqueness'] },
  { key: 'M4-07', title: 'Booking timeline events and user-visible timeline', labels: ['type:feature', 'priority:medium'], milestone: 'M4', criteria: ['Phases: warmup, activated, check, discovered, locked, submitted, approval, complete', 'Immutable rows ordered by time', 'Rendered identically in web and Telegram'] },
  { key: 'M4-08', title: 'Passenger profiles with encrypted PII, export and deletion', labels: ['type:feature', 'area:api', 'risk:pii', 'priority:critical'], milestone: 'M4', criteria: ['Fields: names, national ID, passport, DOB, gender, nationality, contact, category, discount, loyalty', 'Values encrypted at rest; masked in reads/logs', 'Export + delete workflows with audit'], docs: 'docs/privacy.md' },

  { key: 'M5-01', title: 'Provider interface, domain types and capability flags', labels: ['type:feature', 'area:provider', 'priority:critical'], milestone: 'M5', criteria: ['All required methods (stations, routes, login, validateSession, search, trip details, reservation steps, status, cancel)', 'Capability flags incl. supportsSeatSelection/Hold/AutoBooking/ReturnTrips/PriceFiltering/requiresLogin/requiresCaptcha'], docs: 'docs/provider-adapter.md' },
  { key: 'M5-02', title: 'Provider registry with compliance gate', labels: ['type:feature', 'area:provider', 'type:security', 'risk:compliance', 'priority:critical'], milestone: 'M5', criteria: ['Real providers refuse to operate unless compliance APPROVED', 'Capability-driven feature gating with tests', 'Registry exposes health and capability metadata'] },
  { key: 'M5-03', title: 'Mock provider with scriptable scenarios', labels: ['type:test', 'area:provider', 'priority:high'], milestone: 'M5', criteria: ['Deterministic results, seedable', 'Scenario injection: sold out → appears, price change, captcha, failure, session expiry'] },
  { key: 'M5-04', title: 'Provider simulator app (search, booking, captcha, failures, price changes, session expiry)', labels: ['type:feature', 'area:provider', 'type:test', 'priority:high'], milestone: 'M5', criteria: ['HTTP service used by CI instead of a live provider', 'Simulates stations/search/availability/login/passenger form/captcha/reservation/failure/price change', 'Latency and error injection controls'] },
  { key: 'M5-05', title: 'Simulator-backed adapter and shared provider contract test suite', labels: ['type:test', 'area:provider', 'priority:high'], milestone: 'M5', criteria: ['Contract suite runs against mock + simulator', 'Normalization validated with Zod', 'Adapter output never leaks provider-specific shapes'] },
  { key: 'M5-06', title: 'Target-provider template: disabled, UNVERIFIED markers and NotApproved guard', labels: ['type:chore', 'area:provider', 'risk:compliance', 'priority:high'], milestone: 'M5', criteria: ['Folder structure per spec (routes/stations/auth/availability/passengers/reservation/checkout/parser/selectors)', 'Every selector/endpoint marked UNVERIFIED', 'All methods throw NotApprovedError until the gate passes'] },
  { key: 'M5-07', title: 'Station/route synchronisation with fa/en names, aliases and autocomplete', labels: ['type:feature', 'area:provider', 'priority:high'], milestone: 'M5', criteria: ['Sync job populates stations/routes with caching', 'Autocomplete supports Persian, English and aliases', 'Identical data exposed to Telegram and Web'] },

  { key: 'M6-01', title: 'Scheduler with Redis lease and fencing token', labels: ['type:feature', 'area:scheduler', 'priority:critical'], milestone: 'M6', criteria: ['Single active scheduler with HA failover', 'Stale lease holders rejected by fencing token', 'Tick loop with adaptive interval'] },
  { key: 'M6-02', title: 'Monitoring strategies (FIXED/JITTERED/PRIORITY_BASED/EXPONENTIAL_BACKOFF/RELEASE_TIME/ADAPTIVE)', labels: ['type:feature', 'area:scheduler', 'priority:high'], milestone: 'M6', criteria: ['Each strategy unit tested with deterministic clocks', 'Server-side interval floors enforced', 'Jitter bounded and documented'] },
  { key: 'M6-03', title: 'Token-bucket rate limiter: provider, account, proxy, worker, user, release window', labels: ['type:feature', 'area:scheduler', 'risk:compliance', 'priority:critical'], milestone: 'M6', criteria: ['Atomic multi-bucket acquire via Lua', 'Hard ceilings in code that config cannot exceed', '429/throttle handling reduces global load factor'], docs: 'docs/scheduler.md' },
  { key: 'M6-04', title: 'Weighted fair scheduling with per-tenant caps and anti-starvation tests', labels: ['type:feature', 'area:scheduler', 'priority:high'], milestone: 'M6', criteria: ['Deficit round-robin with plan weights', 'No tenant starves; no tenant monopolises a tick', 'Documented algorithm + property tests'] },
  { key: 'M6-05', title: 'Circuit breaker and provider/account/proxy health scores', labels: ['type:feature', 'area:scheduler', 'priority:high'], milestone: 'M6', criteria: ['CLOSED/OPEN/HALF_OPEN with configurable thresholds', 'Health scores persisted and exposed to admin', 'Quarantine of failing proxies/accounts without automatic evasion'] },
  { key: 'M6-06', title: 'Availability burst validation (0s/+3s/+10s) within rate limits', labels: ['type:feature', 'area:scheduler', 'priority:medium'], milestone: 'M6', criteria: ['Bounded extra requests per observation', 'Skips when budget exhausted', 'Volatility recorded for analytics'] },
  { key: 'M6-07', title: 'Queue topology, job contracts, idempotency and retry policies', labels: ['type:feature', 'area:worker', 'priority:critical'], milestone: 'M6', criteria: ['8 queues: availability, booking, provider-sync, notifications, billing, session-refresh, maintenance, analytics', 'Zod-validated payloads with tenantId', 'Per-error-class retry/backoff policies'] },
  { key: 'M6-08', title: 'Release windows, session warm-up, admission control, waiting room and capacity leases', labels: ['type:feature', 'area:scheduler', 'priority:high'], milestone: 'M6', criteria: ['Configurable release windows with warm-up offsets', 'Warm-up can never book (guarded by tests)', 'Capacity admission with explicit refusals and refund handling'], docs: 'docs/high-demand-mode.md' },

  { key: 'M7-01', title: 'grammY bot skeleton with conversation state and fa/en i18n', labels: ['type:feature', 'area:bot', 'priority:high'], milestone: 'M7', criteria: ['Long-polling with graceful shutdown', 'Per-Telegram-user conversation state', 'All strings from translation catalogues (fa/en)'] },
  { key: 'M7-02', title: 'Telegram linking flow with single-use codes and revocation', labels: ['type:feature', 'area:bot', 'type:security', 'priority:critical'], milestone: 'M7', criteria: ['Numeric Telegram user id only (never username)', 'Single-use code, 5-minute TTL, hashed at rest', 'Revoke + re-link requires re-authentication', 'Audit + notification on link/unlink'], docs: 'docs/telegram.md' },
  { key: 'M7-03', title: 'Booking wizard with inline keyboards (origin → … → start monitoring)', labels: ['type:feature', 'area:bot', 'priority:high'], milestone: 'M7', criteria: ['Full wizard incl. date flexibility, preferences and priority', 'Review step before creation', 'Back/cancel at every step'] },
  { key: 'M7-04', title: 'Bot commands: /new /bookings /passengers /wallet /subscription /history /status /settings /support /help', labels: ['type:feature', 'area:bot', 'priority:high'], milestone: 'M7', criteria: ['All commands localized and permission-aware', 'Wallet/subscription display matches web numbers', 'Errors are actionable, never raw stack traces'] },
  { key: 'M7-05', title: 'Notification delivery and signed approval/verification callbacks', labels: ['type:feature', 'area:bot', 'priority:high'], milestone: 'M7', criteria: ['Events: ticket_found, price_change, booking_started, verification_required, approval_required, booking_success, booking_failure, subscription_expiring, wallet_low', 'Callbacks carry signed, single-use tokens', 'Deduplicated per notification'] },
  { key: 'M7-06', title: 'Bot rate limiting and abuse guards', labels: ['type:feature', 'area:bot', 'type:security', 'priority:medium'], milestone: 'M7', criteria: ['Per-user command rate limit', 'Link attempt throttling', 'Suspicious activity raises fraud signals'] },

  { key: 'M8-01', title: 'Next.js app shell with i18n (fa/en), RTL/LTR and design tokens', labels: ['type:feature', 'area:web', 'priority:high'], milestone: 'M8', criteria: ['Mobile-first responsive layout', 'RTL for fa, LTR for en, persisted per user', 'No hardcoded UI strings'] },
  { key: 'M8-02', title: 'Authentication pages wired to the API', labels: ['type:feature', 'area:web', 'priority:high'], milestone: 'M8', criteria: ['Login, register, email verification, password reset', 'Access token in memory, refresh in HttpOnly cookie', 'Error states localized'] },
  { key: 'M8-03', title: 'Dashboard with monitors, matches, bookings, wallet, subscription, quota and activity', labels: ['type:feature', 'area:web', 'priority:high'], milestone: 'M8', criteria: ['Live counts and recent activity', 'Empty/loading/error states', 'Links to booking detail'] },
  { key: 'M8-04', title: 'Create-booking wizard with all preferences and live validation', labels: ['type:feature', 'area:web', 'priority:high'], milestone: 'M8', criteria: ['Origin/destination autocomplete (fa/en/aliases)', 'Date range + return trip, times, class, seat, price ceiling, passengers, priority', 'Capability-driven UI (unsupported features hidden)'] },
  { key: 'M8-05', title: 'Active monitors and booking detail with timeline', labels: ['type:feature', 'area:web', 'priority:high'], milestone: 'M8', criteria: ['Monitor list with next search time and strategy', 'Timeline rendering identical to bot', 'Cancel/priority controls'] },
  { key: 'M8-06', title: 'Passengers, wallet/transactions, invoices, notifications, profile, referral, settings, support pages', labels: ['type:feature', 'area:web', 'priority:medium'], milestone: 'M8', criteria: ['All pages functional against the API', 'Masked PII with explicit reveal + audit', 'Downloadable invoices via renderer interface'] },
  { key: 'M8-07', title: 'Human-verification and approval UI surfaces', labels: ['type:feature', 'area:web', 'priority:high'], milestone: 'M8', criteria: ['Clear "Verification Required" state with instructions', 'Approval screen shows train, passengers, price, fee, terms, automation mode', 'Consent recorded on approval'] },

  { key: 'M9-01', title: 'Plans, features, prices and entitlement resolver (no hardcoded plan logic)', labels: ['type:feature', 'area:billing', 'priority:critical'], milestone: 'M9', criteria: ['Entitlements resolved from plan_features with overrides', 'plan.features.x / plan.limits.y API', 'Price changes require data change only'], docs: 'docs/subscriptions.md' },
  { key: 'M9-02', title: 'Quota engine with monthly/daily/lifetime meters and reset jobs', labels: ['type:feature', 'area:billing', 'priority:high'], milestone: 'M9', criteria: ['Meters: searches, monitoring hours, booking attempts, successful reservations, priority jobs', 'Server-side enforcement with typed denial reasons', 'Period rollover job'] },
  { key: 'M9-03', title: 'Wallet ledger: append-only, idempotent, concurrency-safe, credits with expiry', labels: ['type:feature', 'area:billing', 'type:security', 'risk:financial', 'priority:critical'], milestone: 'M9', criteria: ['Types: DEPOSIT/REFUND/SERVICE_CHARGE/BOOKING_CHARGE/BONUS/PROMO/ADMIN_ADJUSTMENT', 'No balance write without a ledger row', 'Concurrent operation tests conserve total money', 'Credits tracked separately with expiry'], docs: 'docs/wallet.md' },
  { key: 'M9-04', title: 'Charge authorization lifecycle: authorize → settle/release → refund', labels: ['type:feature', 'area:billing', 'risk:financial', 'priority:critical'], milestone: 'M9', criteria: ['Pending charge before the operation, settle or release after', 'Idempotent by (bookingAttemptId, purpose)', 'Automatic refunds on failure after prepayment'] },
  { key: 'M9-05', title: 'Payment provider abstraction, test gateway and hardened webhooks', labels: ['type:feature', 'area:billing', 'type:security', 'risk:financial', 'priority:critical'], milestone: 'M9', criteria: ['PaymentProvider interface with create/verify/refund', 'States: CREATED/PENDING/PAID/FAILED/EXPIRED/REFUNDED/PARTIALLY_REFUNDED', 'Signature verification + replay protection + server-side re-verification', 'No card data ever stored'], docs: 'docs/billing.md' },
  { key: 'M9-06', title: 'Invoices with lines, numbering and replaceable renderer', labels: ['type:feature', 'area:billing', 'priority:high'], milestone: 'M9', criteria: ['Invoices for subscriptions, top-ups and booking charges', 'Immutable once issued; corrections via credit note', 'Renderer interface (HTML now, PDF later)'] },
  { key: 'M9-07', title: 'Coupons: percent, fixed, wallet bonus, free days, feature unlock', labels: ['type:feature', 'area:billing', 'risk:financial', 'priority:high'], milestone: 'M9', criteria: ['Admin-defined with limits (max uses, per-user, eligible plans, min purchase, window)', 'Transactional validation preventing over-redemption', 'Race-condition tests'] },
  { key: 'M9-08', title: 'Referrals with qualification, anti-abuse and ledger rewards', labels: ['type:feature', 'area:billing', 'risk:financial', 'priority:medium'], milestone: 'M9', criteria: ['No self-referral (email/phone/national-ID hash checks)', 'Reward only after qualification', 'All rewards via ledger entries'] },
  { key: 'M9-09', title: 'Reconciliation job: ledger ↔ invoices ↔ payments with discrepancy report', labels: ['type:feature', 'area:billing', 'risk:financial', 'priority:high'], milestone: 'M9', criteria: ['Runs on schedule and on demand', 'Reports orphaned/duplicate/mismatched records', 'Never mutates historical entries (creates adjustments)'] },

  { key: 'M10-01', title: 'Admin API with permission gates and masked views', labels: ['type:feature', 'area:api', 'type:security', 'priority:critical'], milestone: 'M10', criteria: ['Search users by id/email/Telegram id/phone (hashed lookup)', 'Sensitive values masked unless pii:read with justification', 'Every sensitive action audited'] },
  { key: 'M10-02', title: 'Admin dashboards: users, plans, subscriptions, wallets, payments, invoices, jobs, providers, proxies, flags', labels: ['type:feature', 'area:api', 'priority:high'], milestone: 'M10', criteria: ['Read models for each area', 'Provider/worker/queue health endpoints', 'No cross-tenant leakage in aggregates'] },
  { key: 'M10-03', title: 'Release console: windows, admissions, capacity, burst metrics', labels: ['type:feature', 'area:scheduler', 'priority:high'], milestone: 'M10', criteria: ['Upcoming windows with provider-local + UTC times', 'Prepared sessions and CAPTCHA-blocked accounts surfaced', 'Arm/disarm + budget adjustments within hard ceilings'], docs: 'docs/high-demand-mode.md' },
  { key: 'M10-04', title: 'Kill switch and maintenance modes (full, provider, booking-disabled, monitoring-only)', labels: ['type:feature', 'area:api', 'priority:critical'], milestone: 'M10', criteria: ['Immediate effect on new submissions', 'Monitoring continues where safe', 'Users notified with honest reason', 'Audited with actor and reason'], docs: 'docs/operations.md' },
  { key: 'M10-05', title: 'Feature flags: global, plan-specific, user-specific with expiry', labels: ['type:feature', 'priority:high'], milestone: 'M10', criteria: ['Resolution order: user > plan > global default', 'Expiring overrides', 'Flag list configurable without deploy'] },
  { key: 'M10-06', title: 'Support tickets with agent workflow and internal notes', labels: ['type:feature', 'priority:medium'], milestone: 'M10', criteria: ['Categories: billing, booking, technical, provider', 'Assign/reply/status transitions', 'Internal notes never visible to users'] },
  { key: 'M10-07', title: 'Fraud signal queue with human review workflow', labels: ['type:feature', 'area:security', 'priority:medium'], milestone: 'M10', criteria: ['Signals: unusual signup, coupon abuse, referral farming, rapid wallet ops, excessive monitors, repeated failed payments', 'Never auto-accuse: statuses OPEN/REVIEWED/DISMISSED', 'Actions recorded in audit'] },
  { key: 'M10-08', title: 'Admin promotions: wallet credit, subscription days, targeted campaigns', labels: ['type:feature', 'area:billing', 'risk:financial', 'priority:medium'], milestone: 'M10', criteria: ['All grants create ledger entries', 'Threshold above which a reason is mandatory', 'Audited; never silently modifies balances'] },

  { key: 'M11-01', title: 'API rate limiting (per-IP/per-user) with correct 429 semantics', labels: ['type:feature', 'area:api', 'type:security', 'priority:high'], milestone: 'M11', criteria: ['Buckets for login, reset, booking creation, search, payment ops, Telegram actions', 'Retry-After header emitted', 'Denials observable via metrics'] },
  { key: 'M11-02', title: 'Security test suite: IDOR, privilege escalation, webhook forgery/replay, injection, XSS', labels: ['type:test', 'type:security', 'priority:critical'], milestone: 'M11', criteria: ['Automated adversarial tests in CI', 'Regression tests added for every fixed finding', 'Coverage for every risk-labelled module'] },
  { key: 'M11-03', title: 'Secret scanning and dependency audit workflows', labels: ['type:chore', 'area:devops', 'type:security', 'priority:high'], milestone: 'M11', criteria: ['gitleaks + npm audit jobs on push/PR and schedule', 'SBOM generated on release', 'No secrets committed (verified)'] },
  { key: 'M11-04', title: 'Log and error redaction regression tests', labels: ['type:test', 'type:security', 'risk:pii', 'priority:critical'], milestone: 'M11', criteria: ['Synthetic payload with all sensitive keys produces no leakage', 'Error filter redacts upstream details', 'Diagnostics snapshots strip cookies/CSRF/input values'] },
  { key: 'M11-05', title: 'Adversarial security review: findings, fixes and regression tests', labels: ['type:security', 'priority:critical'], milestone: 'M11', criteria: ['Independent review pass documented', 'Each finding has severity, repro, fix, test', 'Residual risks published'], docs: 'docs/security.md' },
  { key: 'M11-06', title: 'SECURITY.md, vulnerability disclosure policy and hardening checklist', labels: ['type:docs', 'type:security', 'priority:high'], milestone: 'M11', criteria: ['Reporting channel + SLA', 'Hardening checklist per environment', 'Rotation procedures documented'] },

  { key: 'M12-01', title: 'Unit test suites across all packages', labels: ['type:test', 'priority:critical'], milestone: 'M12', criteria: ['State machine, scoring, ledger, quotas, entitlements, rate limiter, fairness, crypto, redaction', 'Deterministic clocks and seeds', 'Meaningful assertions (no snapshot-only tests)'] },
  { key: 'M12-02', title: 'Integration tests on real Postgres semantics', labels: ['type:test', 'area:db', 'priority:critical'], milestone: 'M12', criteria: ['Migrations applied in test harness', 'Ledger immutability and audit chain verified in SQL', 'Race conditions exercised with concurrent connections'] },
  { key: 'M12-03', title: 'Provider simulator scenario tests (sold out → appears, CAPTCHA, failure, price change, session expiry)', labels: ['type:test', 'area:provider', 'priority:high'], milestone: 'M12', criteria: ['End-to-end monitor → find → notify → (dry-run) reservation', 'CAPTCHA pauses and resumes after human step', 'Failure classes produce correct retry policies'] },
  { key: 'M12-04', title: 'Booking chaos tests: crash after lock, duplicate delivery, recovery protocol', labels: ['type:test', 'area:worker', 'priority:critical'], milestone: 'M12', criteria: ['Crash after lock leaves exactly one reservation and one charge', 'Duplicate queue delivery is a no-op', 'Recovery re-verifies provider state before retry'] },
  { key: 'M12-05', title: 'Billing edge cases: concurrent wallet ops, duplicate callbacks, coupon race, expiry', labels: ['type:test', 'area:billing', 'risk:financial', 'priority:critical'], milestone: 'M12', criteria: ['Money conserved under concurrency', 'Duplicate payment callbacks idempotent', 'Coupon over-redemption impossible', 'Refund/create charge failure paths tested'] },
  { key: 'M12-06', title: 'API end-to-end suite against a booted application', labels: ['type:test', 'area:api', 'priority:high'], milestone: 'M12', criteria: ['Bootstraps the Nest app with PGlite + fake Redis', 'Covers register → link → booking → monitor → dashboard', 'RBAC and tenant isolation asserted over HTTP'] },

  { key: 'M13-01', title: 'Multi-stage Dockerfiles for api, web, worker, scheduler, bot, simulator (non-root)', labels: ['type:chore', 'area:devops', 'priority:high'], milestone: 'M13', criteria: ['Slim runtime images, non-root user, healthchecks', 'Deterministic builds from lockfile', 'No secrets baked in'] },
  { key: 'M13-02', title: 'docker-compose dev + production + .env.example', labels: ['type:chore', 'area:devops', 'priority:high'], milestone: 'M13', criteria: ['Services: web, api, worker, scheduler, telegram, simulator, postgres, redis, reverse-proxy', 'Dev uses safe defaults (DRY_RUN/MOCK_PROVIDER/PAYMENT_MODE=test)', 'Production compose requires explicit secrets'], docs: 'docs/deployment.md' },
  { key: 'M13-03', title: 'Reverse proxy with TLS, security headers and edge rate limiting', labels: ['type:chore', 'area:devops', 'type:security', 'priority:high'], milestone: 'M13', criteria: ['HSTS, CSP, X-Content-Type-Options, Referrer-Policy', 'Body size limits and timeouts', 'WebSocket/SSE ready for live updates'] },
  { key: 'M13-04', title: 'Backup, restore and DR scripts with verification', labels: ['type:chore', 'area:devops', 'risk:financial', 'priority:critical'], milestone: 'M13', criteria: ['pg_dump + WAL archiving guidance, Redis expectations', 'Restore script verifies row counts, ledger checksum, audit chain', 'Documented restore drill evidence'], docs: 'docs/deployment.md' },
  { key: 'M13-05', title: 'Release workflow: tag → build/push images (no automatic production deploy)', labels: ['type:chore', 'area:devops', 'priority:high'], milestone: 'M13', criteria: ['Manual approval gate for production', 'Images tagged by semver + commit sha', 'Release notes generated'] },

  { key: 'M14-01', title: 'Production readiness checklist executed with evidence', labels: ['type:docs', 'priority:critical'], milestone: 'M14', criteria: ['Tenant isolation, financial consistency, rate limits, provider compliance, backup restore, worker recovery, queue resilience, monitoring, alerting, security review, load test', 'Each item has evidence or an explicit gap'], docs: 'docs/production-readiness.md' },
  { key: 'M14-02', title: 'Load test of scheduler and queues with published results', labels: ['type:test', 'priority:high'], milestone: 'M14', criteria: ['Thousands of monitors due simultaneously stay within budget', 'Queue latency and fairness measured', 'Results recorded with environment details'] },
  { key: 'M14-03', title: 'Production readiness report and residual risk statement', labels: ['type:docs', 'priority:high'], milestone: 'M14', criteria: ['Verified test results (commands + counts)', 'Open risks with owners and mitigations', 'Explicit statement of what is not production-ready (real provider)'], docs: 'docs/production-readiness.md' },
  { key: 'M14-04', title: 'Operations runbooks (kill switch, degradation, reconciliation, incidents)', labels: ['type:docs', 'area:devops', 'priority:high'], milestone: 'M14', criteria: ['Runbooks for each failure mode in the architecture doc', 'On-call escalation and communication templates', 'Verified against the code paths'], docs: 'docs/operations.md' },
];

function ensureLabels() {
  for (const [name, color, desc] of LABELS) {
    try {
      gh(['label', 'create', name, '--color', color, '--description', desc, '--force']);
    } catch (e) {
      console.warn(`label ${name}: ${e.message}`);
    }
  }
  console.log(`✔ labels ensured (${LABELS.length})`);
}

function ensureMilestones() {
  let created = 0;
  for (const [title, description] of MILESTONES) {
    try {
      const json = gh(['api', `repos/${REPO}/milestones`, '--paginate', '--jq', '.[].title']);
      if (json.split('\n').includes(title)) continue;
    } catch { /* first call may fail if listing unsupported */ }
    try {
      // milestone creation needs the REST API with a JSON body
      execFileSync('gh', ['api', `repos/${REPO}/milestones`, '-f', `title=${title}`, '-f', `description=${description}`, '-f', 'state=open'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      created++;
    } catch (e) {
      console.warn(`milestone ${title}: ${e.message}`);
    }
  }
  console.log(`✔ milestones ensured (created ${created})`);
}

function issueBody(issue) {
  return [
    `**Milestone:** ${issue.milestone}`,
    `**Plan key:** \`${issue.key}\``,
    `**Labels:** ${issue.labels.map((l) => `\`${l}\``).join(' ')}`,
    '',
    `> Labels and milestone are declared here because some automation tokens cannot assign them;`,
    `> run \`node scripts/github-bootstrap.mjs --link-only\` with an owner-capable token to attach them.`,
    '',
    '## Definition of done',
    '',
    ...issue.criteria.map((c) => `- [ ] ${c}`),
    '',
    '## Engineering standard (docs/README.md § Definition of Done)',
    '',
    '- [ ] Implementation complete, errors handled, logs + metrics emitted',
    '- [ ] Tests written and **actually executed** (evidence: command + result in the PR/commit)',
    '- [ ] Security review completed where `risk:pii` / `risk:financial` / `risk:compliance` apply',
    '- [ ] Documentation and configuration updated',
    '- [ ] No hardcoded secrets, no hardcoded monetary values, no hardcoded plan logic',
    issue.docs ? `\n**Docs:** \`${issue.docs}\`` : '',
  ].filter(Boolean).join('\n');
}

function ensureIssues() {
  let created = 0, skipped = 0;
  const existing = new Set();
  try {
    const out = gh(['issue', 'list', '--state', 'all', '--limit', '400', '--json', 'title', '--jq', '.[].title']);
    out.split('\n').filter(Boolean).forEach((t) => existing.add(t));
  } catch (e) {
    console.warn(`issue list: ${e.message}`);
  }
  for (const issue of ISSUES) {
    const title = `[${issue.key}] ${issue.title}`;
    if (existing.has(title)) { skipped++; continue; }
    const labelArgs = issue.labels.flatMap((l) => ['--label', l]);
    try {
      gh(['issue', 'create', '--title', title, '--body', issueBody(issue), '--milestone', `${issue.milestone} — ${MILESTONE_TITLES[issue.milestone] ?? ''}`.trim(), ...labelArgs]);
      created++;
    } catch (e) {
      console.warn(`issue ${issue.key}: ${e.message}`);
    }
  }
  console.log(`✔ issues ensured (created ${created}, skipped ${skipped}/${ISSUES.length})`);
}

const MILESTONE_TITLES = Object.fromEntries(MILESTONES.map(([t]) => [t.split(' ')[0], t.replace(/^M\d+ — /, '')]));

/**
 * Link existing issues to their milestone + labels.
 * Needed because some automation tokens can create issues but not update them
 * (REST PATCH / issue-labels return "Resource not accessible by integration").
 * Run with an owner/admin token: node scripts/github-bootstrap.mjs --link-only
 */
function linkIssues() {
  const byTitle = new Map();
  const out = gh(['issue', 'list', '--state', 'all', '--limit', '400', '--json', 'number,title,labels,milestone']);
  for (const row of JSON.parse(out)) byTitle.set(row.title, row);

  let linked = 0, failed = 0;
  for (const issue of ISSUES) {
    const title = `[${issue.key}] ${issue.title}`;
    const existing = byTitle.get(title);
    if (!existing) { console.warn(`missing issue: ${issue.key}`); failed++; continue; }
    const hasAllLabels = issue.labels.every((l) => (existing.labels ?? []).some((x) => x.name === l));
    const milestoneTitle = `${issue.milestone} — ${MILESTONE_TITLES[issue.milestone] ?? ''}`.trim();
    if (hasAllLabels && existing.milestone?.title === milestoneTitle) continue;
    const labelArgs = issue.labels.flatMap((l) => ['--add-label', l]);
    try {
      gh(['issue', 'edit', String(existing.number), '--milestone', milestoneTitle, ...labelArgs]);
      linked++;
    } catch (e) {
      console.warn(`link ${issue.key}: ${e.message}`);
      failed++;
    }
  }
  console.log(`✔ linking done (updated ${linked}, failed ${failed})`);
}

if (args.includes('--labels-only')) { ensureLabels(); process.exit(0); }
if (args.includes('--link-only')) { ensureLabels(); ensureMilestones(); linkIssues(); process.exit(0); }
ensureLabels();
ensureMilestones();
ensureIssues();
console.log('done');
