# Threat Model

> Method: STRIDE applied per trust boundary + domain-specific abuse cases (financial, provider
> compliance, multi-tenant isolation, personal data).
> Scale: **Impact** = CIA + financial + legal. **Likelihood** = post-mitigation.
> Each threat has an ID used in code comments, tests, and PR descriptions (`TM-xx`).
> Security review workflow: Architect → Security review → Developer → Tests → Adversarial review →
> Fix → Regression tests → Merge (see [security.md](security.md) § Review workflow).

## 0. Assets

| Asset | Why it matters |
| --- | --- |
| A1 Passenger PII (national ID, passport, DOB, phone) | Legal exposure, identity theft, irreversible harm |
| A2 Provider credentials + session cookies | Account takeover on provider, ticket fraud, user's money |
| A3 Wallet ledger + payment records | Direct monetary loss, legal/tax exposure |
| A4 Provider goodwill / compliance status | Platform shutdown risk, contractual breach — **a first-class security asset** |
| A5 Booking integrity (no duplicates, no phantom bookings) | User trust, refunds, cost |
| A6 Platform availability & rate-limit budget | All users lose core value if the provider blocks us |
| A7 Audit trail | Dispute resolution, regulatory, forensics |
| A8 Secrets (DB, JWT, encryption keys, bot token) | Total compromise if leaked |

## 1. Trust boundaries

```
B1 browser/Telegram client  → API             (untrusted input, untrusted identity)
B2 API/worker               → provider site   (untrusted responses, untrusted HTML/JS, legal gate)
B3 payment provider         → webhook         (untrusted input until signature verified)
B4 platform staff           → admin surface   (authenticated but must be least-privilege + audited)
B5 data plane               → metrics/logs/exports (redaction boundary)
B6 scheduler                → workers         (queue payloads must be re-authorized)
B7 proxy/egress             → provider        (third-party infrastructure, no credential leak)
```

---

## 2. Threat catalogue

### TM-01 Cross-tenant data disclosure (IDOR / missing scope)
* **Attack path**: Tenant B guesses/enumerates an id (`booking`, `passenger`, `invoice`) and calls
  `/api/v1/.../{id}`; or a repository method omits `tenant_id`.
* **Impact**: Critical (PII of other customers, financial data).
* **Mitigation**: scope-typed repository API (missing scope = compile error); generated SQL always
  carries `tenant_id`; `assertScopedSql` runtime guard; composite FKs prevent cross-tenant links;
  queue payloads re-verified against the row's tenant; automated IDOR sweep test over every
  repository + HTTP endpoint (`packages/testing/src/tenant-isolation.spec.ts`).
* **Residual risk**: Low (a new repository method added incorrectly — mitigated by the sweep gate in CI).

### TM-02 Privilege escalation via role/permission confusion
* **Attack path**: self-service role change, forged role claim in JWT, admin endpoint reachable by
  `SUPPORT`, finance role reading passenger PII.
* **Impact**: High.
* **Mitigation**: role/permission claims are **never** trusted from the client; authorization reads
  the current DB role (with a short-TTL cache); explicit permission matrix with deny-by-default;
  `finance` lacks `pii:read`; admin endpoints bound to permissions, not roles; every sensitive
  admin action writes an audit event; tests assert the full role × endpoint matrix
  (`packages/auth/src/__tests__/rbac.matrix.spec.ts`).
* **Residual risk**: Low.

### TM-03 Refresh-token theft / replay
* **Attack path**: XSS or device compromise steals the refresh token; attacker rotates it forever.
* **Impact**: High (full account access).
* **Mitigation**: refresh tokens are opaque, stored **hashed** (SHA-256) with a family id; **rotation
  on every use**; reuse of an old token revokes the whole family and emits a security notification;
  refresh cookie is `HttpOnly` + `SameSite=Strict` + `Secure` (web uses cookie-held refresh,
  memory-held access token); device/UA binding hash stored for anomaly detection; session
  revocation endpoints; short access-token TTL (15 min).
* **Residual risk**: Medium-Low (token theft is partially unavoidable; blast radius is bounded).

### TM-04 Credential stuffing / brute force on login
* **Mitigation**: Argon2id (64 MiB, t=3); per-IP + per-account rate limits with progressive delay;
  lockout after N failures (configurable); uniform error responses (no user enumeration);
  breached-password check hook; security notification on new login from new IP-hash.
* **Residual risk**: Medium (password reuse is a user-side risk; MFA is planned, hooks present).

### TM-05 Telegram account-linking takeover
* **Attack path**: attacker convinces a user to link the attacker's Telegram account, or supplies
  someone else's Telegram numeric id, or replays a linking code.
* **Impact**: High (attacker receives booking/PII notifications, can trigger approvals).
* **Mitigation**: linking requires (a) an authenticated web session, (b) a single-use code with
  short TTL (5 min) bound to the user id and stored hashed, (c) the bot only accepts the **numeric**
  Telegram user id from the update context — conversation state is keyed to the Telegram user id,
  never the username, (d) pending link is shown on the web with "was this you?" + one-click revoke,
  (e) re-linking requires re-authentication, (f) any link/unlink writes an audit event and
  notification.
* **Residual risk**: Low.

### TM-06 Passenger PII exposure via logs, errors, telemetry
* **Attack path**: passenger form payload logged by a debug statement, error serializer, or APM.
* **Impact**: Critical (regulatory + identity theft).
* **Mitigation**: pino redaction paths for a fixed key list (`nationalId`, `passport`, `cookies`,
  `tokens`, `password`, `authorization`, `cardNumber`, …) applied at the logger **and** in the HTTP
  error filter; request bodies are never logged wholesale (`logBody: false` default); provider
  adapter logs redact element values for passenger inputs; a redaction test asserts a synthetic
  payload with every sensitive key never appears in log output; PII never leaves the process in
  metrics (labels are enum-like only).
* **Residual risk**: Low.

### TM-07 Provider credential / session theft
* **Attack path**: DB dump exposes provider passwords or session cookies; log leak; admin UI leak.
* **Mitigation**: AES-256-GCM envelope encryption with a KEK/DEK key ring (key id versioned);
  credentials are **write-only** through the API (never returned, not even to owners);
  sessions encrypted with TTL and destroyed on invalidation; decryption only in worker memory;
  DB read access alone is insufficient without the master key; admin views are masked; audit on read
  of any secret-bearing record.
* **Residual risk**: Medium (requires key + DB compromise simultaneously).

### TM-08 Wallet/ledger manipulation (money creation, balance tampering)
* **Attack path**: race condition double-spend; direct balance update; negative amounts; replaying a
  charge; refunding twice.
* **Impact**: Critical.
* **Mitigation**: append-only ledger, derived balances, DB transaction + `SELECT … FOR UPDATE` on the
  wallet row, unique `idempotency_key` per financial operation, signed-amount checks, `CHECK`
  constraints (`amount_minor <> 0`; direction rules per type), reconciliation job comparing ledger
  sum vs cached balance vs payment records, `REVOKE UPDATE/DELETE` for the app role in production,
  property tests for concurrency (100 parallel operations must conserve total money).
* **Residual risk**: Low.

### TM-09 Payment webhook forgery / replay
* **Attack path**: attacker POSTs a fake "PAID" callback; or replays a valid callback.
* **Mitigation**: HMAC signature verification with constant-time compare + timestamp window;
  `(provider_code, external_event_id)` unique for replay; server-side re-verification by calling the
  payment provider (never trust callback fields); amount/currency match against the invoice;
  state machine on the payment row; idempotent credit posting; webhook endpoint is rate-limited and
  rejects unknown content types; sanitized event logging only.
* **Residual risk**: Low.

### TM-10 Coupon / referral abuse (economic fraud)
* **Attack path**: multi-account coupon farming, self-referral, referral rings, coupon race condition.
* **Mitigation**: redemption insert inside a transaction with usage counters under row lock;
  per-user limits; self-referral blocked by email/phone hash/national-id-hash and first-party
  cookie+payment-fingerprint heuristics; referral reward only after qualification (first paid
  subscription or first successful booking); velocity limits on account creation; fraud signals
  (`fraud_signals`) queue for **human** review — never automatic accusation; new-account payouts
  held in `PENDING` state.
* **Residual risk**: Medium (economic fraud is an arms race; human review is the backstop).

### TM-11 Duplicate booking (double reservation / double charge)
* **Attack path**: crash + retry, two workers pick the same job, redelivered queue message, user
  double-click.
* **Impact**: High (user pays twice; provider relationship damage).
* **Mitigation**: the six-layer protection in [booking-state-machine.md](booking-state-machine.md) § 5;
  crash recovery re-queries provider status; chaos tests (worker killed after lock) assert a single
  reservation and a single ledger charge.
* **Residual risk**: Low.

### TM-12 Provider ToS / compliance breach (regulatory & contractual)
* **Attack path**: operator enables a provider adapter whose ToS forbids automation, or someone
  configures aggressive polling; or an operator asks for account rotation to evade limits.
* **Impact**: Critical (platform ban, legal exposure, customers lose service).
* **Mitigation**: provider registry carries `compliance.review_status` + `compliance.notes` +
  evidence links; adapters cannot be enabled without `APPROVED`; automation above `MONITOR_ONLY`
  additionally requires `automation_approved` capability; global rate limits cannot be raised above
  a hard ceiling in config; account/proxy rotation strategies **exclude** any "evade restriction"
  behaviour by design and are reviewed in code; admin UI shows compliance status next to the enable
  toggle; the architecture documents the abstention policy (we would rather not run than violate).
* **Residual risk**: Medium (provider terms can change; monitored via research doc refresh policy).

### TM-13 CAPTCHA bypass pressure / anti-bot arms race
* **Mitigation**: no solver integration exists; no fingerprint spoofing; no stealth plugins; on
  verification we pause, notify, and hand control to the human with the preserved context; design
  docs and code comments state this explicitly; any PR adding evasion tooling is rejected by policy
  (documented in CONTRIBUTING/ADR-0008).
* **Residual risk**: Low (by abstention).

### TM-14 Scheduler overload / self-inflicted DoS on provider
* **Attack path**: 10k monitors become due at the same second; a release window triggers a thundering
  herd; jitter disabled by misconfiguration.
* **Mitigation**: token-bucket rate limits at provider/account/proxy/worker/user scopes; fair queueing;
  admission control per release window; capacity leases for browser contexts; hard caps on
  per-tenant concurrency; burst validation bounded (0s/+3s/+10s only); circuit breaker on error rate;
  load-shedding with honest user messaging; monitor interval floors enforced server-side.
* **Residual risk**: Low.

### TM-15 Malicious provider content / browser RCE
* **Attack path**: provider page (or a MITM) exploits the browser or navigates to attacker-controlled
  content; drive-by download; SSRF via crafted URLs.
* **Mitigation**: Playwright runs sandboxed in the worker container with a non-root user, read-only
  root FS where possible, no persistent profile, `acceptDownloads: false`, navigation allow-list to
  the provider's registrable domain, block requests to non-allow-listed origins (log + count),
  ignore HTTPS errors disabled, container network egress restricted to the proxy/provider.
* **Residual risk**: Medium (browser attack surface; containment is the control).

### TM-16 Queue payload tampering / privilege confusion
* **Attack path**: a job crafted with a different `tenantId` or elevated `priority`.
* **Mitigation**: queue is internal-only (Redis on a private network, no external exposure); payloads
  are validated with Zod schemas; the worker re-reads the entity under the payload's `tenantId` and
  compares stored `tenant_id`; priority is derived from plan **server-side at enqueue**, never read
  from user input; mismatches raise a security alert + audit event.
* **Residual risk**: Low.

### TM-17 Proxy configuration abuse (SSRF, credential leak, evasion)
* **Mitigation**: proxies are admin-managed only; hostname validated (no IP literals in internal
  ranges, no loopback/link-local/metadata IPs); credentials encrypted; health checks use an
  allow-listed endpoint; proxies are never used to circumvent geographic restrictions (documented);
  per-proxy egress allow-list.
* **Residual risk**: Low.

### TM-18 Insider abuse (operator reading PII, admin granting credit)
* **Mitigation**: least privilege (finance ≠ PII), masked views by default, `pii:read` permission for
  unmasked access with mandatory justification, immutable audit for every sensitive read/write,
  dual-control guidance for large adjustments (configurable threshold), anomaly report on
  admin adjustments, no direct DB access in production (break-glass account audited).
* **Residual risk**: Medium (insider risk can only be reduced, not eliminated).

### TM-19 Audit-trail tampering / repudiation
* **Mitigation**: append-only table with `REVOKE UPDATE, DELETE`; hash-chained rows
  (`prev_hash`, `entry_hash`) so deletion/alteration is detectable; audit writes occur in the same
  transaction as the action where feasible; verification job reports chain breaks; retention purge
  only via policy job that records a purge audit event.
* **Residual risk**: Low.

### TM-20 Secret leakage via repository/config/CI
* **Mitigation**: `.env*` ignored, only `.env.example` committed with placeholder values; config
  module fails fast on missing/weak secrets in production mode; CI secret scanning job (gitleaks)
  + `npm audit`; no secrets in Docker images (build args empty); runtime secrets injected by the
  orchestrator; rotation runbook; tests assert that no file in `git ls-files` matches secret
  patterns for the test fixtures.
* **Residual risk**: Low.

### TM-21 API abuse / resource exhaustion (DoS)
* **Mitigation**: per-IP and per-user token buckets at the edge and in the API; body-size limits;
  pagination caps; expensive endpoints (search, export, PDF) quota-limited or queued; Redis-backed
  counters with sliding windows; 429 with `Retry-After`; timeouts everywhere; worker pool isolation
  so API thread starvation cannot happen.
* **Residual risk**: Medium (a sustained DDoS is an infrastructure concern; edge provider absorbs).

### TM-22 Abuse of monitoring for scalping / mass acquisition
* **Attack path**: a user creates hundreds of monitors to corner popular routes.
* **Mitigation**: plan limits on active monitors/date-range/passengers; per-tenant concurrency caps;
  per-account provider booking limits; velocity and anomaly detection with human review;
  compliance stance: the platform optimises for **legitimate personal/family travel**, and the
  pricing/limit design penalises industrial use; accept that complete prevention is impossible.
* **Residual risk**: Medium-High (accepted, monitored, and re-reviewed; documented as an accepted
  risk rather than silently ignored).

### TM-23 Price manipulation / dishonest price display
* **Mitigation**: prices come from the provider response, stored as integer minor units with
  currency; the UI always labels provider price vs service fee; the ledger records both; currency
  mismatch is a validation error; no client-supplied amounts are trusted for charging.
* **Residual risk**: Low.

### TM-24 Notification spoofing / spam
* **Mitigation**: notifications are generated only from internal events with a dedup key and a
  per-user rate cap; user-configurable preferences (except legally-required financial/security
  messages); Telegram messages are sent only to the linked chat id; templates are keyed and
  localized (no user-controlled markup); no HTML/parse-mode injection from user strings.
* **Residual risk**: Low.

### TM-25 Backup exposure / restore inconsistency
* **Mitigation**: encrypted backups (age/PGP or volume encryption), restricted bucket ACLs,
  restore drill documented and executed at least once per release train, WAL archiving for PITR,
  restore verification (row counts + ledger checksum + audit chain verification) as part of the
  restore script.
* **Residual risk**: Low.

### TM-26 Wrong-time booking (release-time timezone errors)
* **Attack path**: DST/offset confusion causes searches to start after the release window (lost
  tickets) or before it (wasted tokens, provider anger).
* **Mitigation**: all storage in UTC; provider timezone declared per provider and used for
  window computation; Asia/Tehran handling explicit (no DST since 2022); unit tests covering
  window boundaries, offsets, and DST-less assumptions with named TZ fixtures; admin UI shows both
  provider-local and UTC times.
* **Residual risk**: Low.

### TM-27 Dependency supply-chain compromise
* **Mitigation**: lockfile committed; `npm ci` in CI; automated dependency review + audit job;
  Dependabot alerts; no post-install scripts from unknown packages where avoidable
  (`--ignore-scripts` in CI where feasible); pinned major versions; SBOM generation in the release
  workflow.
* **Residual risk**: Medium (industry-wide).

### TM-28 Personal-data over-retention
* **Mitigation**: retention policy per table (see [privacy.md](privacy.md)), purge jobs with audit,
  export/delete endpoints, minimization (we do not store payment cards, do not store provider
  passwords for users who use our hosted-session flow), diagnostics artifacts auto-expire.
* **Residual risk**: Low.

---

## 3. Test coverage mapping

| Threat | Test artifact |
| --- | --- |
| TM-01 | `packages/testing` IDOR sweep + `apps/api/test/tenant-isolation.e2e.spec.ts` |
| TM-02 | `packages/auth` RBAC matrix spec + API authorization specs |
| TM-03/04 | `packages/auth` session/rotation/lockout specs |
| TM-05 | `apps/telegram-bot` linking specs (replay, wrong user, expired code) |
| TM-06 | `packages/logging` redaction spec (synthetic PII payload) |
| TM-07 | `packages/crypto` envelope specs + adapter credential-write-only specs |
| TM-08 | `packages/billing` ledger concurrency/property specs |
| TM-09 | `apps/api` webhook specs: bad signature, replay, amount mismatch |
| TM-10 | `packages/billing` coupon race + referral abuse specs |
| TM-11 | `packages/booking` chaos: crash after lock, duplicate delivery |
| TM-12/13 | `packages/provider-sdk` capability/compliance gate specs |
| TM-14 | `packages/booking` scheduler fairness + token bucket specs |
| TM-15 | `packages/provider-sdk` navigation allow-list specs |
| TM-16 | `packages/queue` payload validation + tenant re-check specs |
| TM-19 | `packages/database` audit chain verification spec |
| TM-26 | `packages/shared` time/window specs with provider TZ fixtures |

## 4. Residual risk register (accepted, with owners)

| Risk | Severity | Accepted because | Review trigger |
| --- | --- | --- | --- |
| Scalping via legitimate-looking accounts (TM-22) | Medium-High | Cannot be fully solved without harming legitimate multi-passenger/family use | Any abuse report or limit-breach metric |
| Provider terms change (TM-12) | Medium | Outside our control | Quarterly provider research refresh |
| Browser 0-day in worker (TM-15) | Medium | Contained by sandbox + egress allow-list | Any CVE in Playwright/Chromium |
| Insider PII access (TM-18) | Medium | Operational necessity | Quarterly access review |
| Password reuse (TM-04) | Medium | User-side | MFA rollout (M-milestone) |
