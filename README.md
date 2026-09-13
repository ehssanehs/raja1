# Raja1 — Train-Ticket Monitoring & Assisted Reservation SaaS

> **Multi-tenant, provider-agnostic platform** for monitoring train-ticket availability and
> assisting — inside strict compliance, safety, and financial-integrity boundaries — with
> reservation workflows. Users interact through a **Telegram bot** or the **responsive web app**;
> operators manage the platform through an admin API and the **proxy admin console**.

![Node](https://img.shields.io/badge/node-%3E%3D20.11-339933)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)
![Tests](https://img.shields.io/badge/tests-337%20passing-2fbf71)
![License](https://img.shields.io/badge/license-proprietary-lightgrey)

---

## Table of contents

1. [What this is (and is not)](#1-what-this-is-and-is-not)
2. [Safety defaults (fail-closed)](#2-safety-defaults-fail-closed)
3. [Architecture at a glance](#3-architecture-at-a-glance)
4. [Repository layout](#4-repository-layout)
5. [Quick start (development)](#5-quick-start-development)
6. [Deployment](#6-deployment)
7. [Configuration reference](#7-configuration-reference)
8. [The egress proxy pool](#8-the-egress-proxy-pool)
9. [Admin API & web console](#9-admin-api--web-console)
10. [Testing](#10-testing)
11. [Database & migrations](#11-database--migrations)
12. [Operations runbook](#12-operations-runbook)
13. [Documentation map](#13-documentation-map)
14. [Compliance posture (read before enabling anything)](#14-compliance-posture-read-before-enabling-anything)
15. [Project status](#15-project-status)
16. [License](#16-license)

---

## 1. What this is (and is not)

| ✅ Is | ❌ Is not |
| --- | --- |
| An availability-monitoring product (the core, always-on capability) | A CAPTCHA-bypass or anti-bot-evasion tool |
| An **assisted** reservation workflow with explicit user consent at every irreversible step | A tool that purchases tickets without the account holder's authorisation |
| A provider-agnostic platform (first provider: an Iranian rail ticketing provider) | A provider-specific scraper welded into the business core |
| A commercially billable SaaS with wallet ledger, invoices, coupons, referrals, quotas | A hobby script with a database |
| A **compliance-gated** automation platform: automation modes above `MONITOR_ONLY` require provider permission, admin enablement, and explicit user consent | A tool that rotates accounts/proxies to circumvent provider restrictions |
| An admin-managed **egress routing** layer that *respects* provider signals (rest, never evade) | An IP-rotation engine for dodging blocks |

**Independence notice.** Raja1 is an independent product. It is **not** affiliated with,
endorsed by, or operated by any rail operator or ticketing provider. All provider names are
trademarks of their respective owners.

---

## 2. Safety defaults (fail-closed)

The platform is **fail-closed by construction**. The default development/CI configuration is:

```env
DRY_RUN=true            # no real reservation is ever submitted
MOCK_PROVIDER=true      # no real provider traffic
PAYMENT_MODE=test       # no real money movement
AUTO_BOOKING_GLOBAL=false
EGRESS_MODE=OFF         # the proxy pool is inert until an admin turns it on
```

Three independent guards must all be satisfied before a real reservation could ever be
submitted — see [`docs/booking-state-machine.md`](docs/booking-state-machine.md) and the
three-signal rule in `packages/config/src/index.ts`:

```
live booking armed ⇔ NODE_ENV=production ∧ DRY_RUN=false ∧ I_UNDERSTAND_LIVE_BOOKING=true ∧ PAYMENT_MODE=live
```

Any single-signal misconfiguration keeps the platform in dry-run, and unsafe configurations
(weak secrets, missing `DATABASE_URL`/`MASTER_KEYS` in production, `DRY_RUN=false` outside
production) **refuse to start** with a complete problem list.

The proxy pool follows the same philosophy: `EGRESS_MODE=OFF` by default, and `REQUIRED` mode
refuses provider traffic outright when no healthy egress proxy exists.

---

## 3. Architecture at a glance

```
                         ┌──────────────────────────────────────────────┐
   Telegram users ──────►│  apps/telegram-bot   (grammY, fa/en, inline) │──┐
                         └──────────────────────────────────────────────┘  │
                         ┌──────────────────────────────────────────────┐  │   same backend,
   Web users ──────────►│  apps/web            (Next.js 15, RTL/LTR)   │──┤   same tenancy,
                         └──────────────────────────────────────────────┘  │   same entitlements
                                                                           ▼
                         ┌──────────────────────────────────────────────┐
                         │  apps/api   admin surface (Fastify, /api/v1) │
                         │  proxies CRUD · pool settings · health · /admin console │
                         └───────┬──────────────┬───────────────┬───────┘
                                 │              │               │
                    ┌────────────▼───┐  ┌───────▼──────┐  ┌─────▼────────┐
                    │ apps/worker    │  │ apps/scheduler│  │ PostgreSQL   │
                    │ BullMQ + pools │  │ fairness +    │  │ (tenant-safe)│
                    │ egress leases  │  │ rate limiter  │  │ append-only  │
                    │ provider adapter│ │ proxy probing │  │ ledger       │
                    └────────┬───────┘  └───────┬───────┘  └──────────────┘
                             │                  │
                    ┌────────▼──────────────────▼───────┐
                    │ Redis: queues, locks, buckets      │
                    └────────┬──────────────────────────┘
                             ▼
        ┌────────────────────────────────────────────────────────┐
        │ Provider SDK (mock ● simulator ● target-provider)      │
        │ ProviderCallContext.egressProxyId → @raja/proxy lease  │
        └────────────────────────────────────────────────────────┘
```

Layer rules (enforced by tsconfig references):

```
shared → config → crypto → database → { auth, provider-sdk, queue, billing, notifications, proxy } → booking → apps
```

`@raja/shared` depends on nothing; `@raja/proxy` depends only on shared/config/crypto/database.
Applications never bypass packages to touch the database directly with raw connection logic.

---

## 4. Repository layout

```
apps/
  api/                 Admin API (Fastify): /api/v1/admin/proxies*, /admin console, /health/*
  web/                 Next.js 15 app router, fa/en, RTL/LTR, mobile-first (shell)
  telegram-bot/        grammY bot, bilingual wizard + inline keyboards (planned shell)
  worker/              BullMQ consumers: egress leases, provider calls, health reporting
  scheduler/           Fair scheduler, rate limiter, proxy probing + retention maintenance loop
  provider-simulator/  Local mock railway ticketing provider (CI + dev)
packages/
  shared/              Money, time, ids, result types, enums, i18n (en+fa), permissions
  config/              Zod-validated env config (fail-closed, refuses unsafe starts)
  logging/             Structured PII-redacting logger, correlation ids
  crypto/              Argon2id, AES-256-GCM envelope encryption, key ring, lookup hashes
  database/            Pool, forward-only migrations (checksum-verified), repositories, tenancy guard
  auth/                JWT access/refresh with rotation, RBAC, sessions
  provider-sdk/        Provider interface, capability flags, registry, compliance gate
  proxy/               Egress proxy pool: admin CRUD, leases, rotation, quarantine, probing
  queue/               Queue names, job contracts, idempotency, Redis locks
  billing/             Wallet ledger, subscriptions, entitlements, quotas, payments
  notifications/       Channel abstraction + dedup + preferences
  booking/             Domain: state machine, matching/scoring, monitors, orchestrator
  testing/             PGlite DB harness, fakes, fixtures, tenant-isolation matrix
docs/                  Architecture, threat model, domain, provider adapter, proxy pool, plans
```

---

## 5. Quick start (development)

### Prerequisites

- **Node.js ≥ 20.11** (22 recommended)
- **npm ≥ 10**
- *Optional*: Docker + Compose for the full stack; otherwise the platform runs on an embedded
  PostgreSQL (PGlite/WASM) with zero external services.

### 5.1 Install & run (no external services needed)

```bash
# 1. install
npm ci

# 2. configure (development defaults are already safe)
cp .env.example .env        # adjust as needed; every variable has a safe default

# 3. apply migrations + verify integrity (uses embedded PGlite when DATABASE_URL is empty)
npx tsx packages/database/src/cli/migrate.ts bootstrap

# 4. seed reference data + (optionally) a demo tenant
npx tsx packages/database/src/cli/seed.ts --demo

# 5. run the full test suite (337 tests, no network, no provider traffic)
npm test

# 6. start the admin API + proxy console
RAJA_BOOTSTRAP_ADMIN_API=1 npx tsx apps/api/src/index.ts
```

| Service | URL |
| --- | --- |
| **Proxy admin console** | http://localhost:3001/admin |
| Admin API base | http://localhost:3001/api/v1 |
| Health (live / ready) | http://localhost:3001/health/live · /health/ready |
| Web app (shell) | http://localhost:3000 |

Development tokens (change them anywhere non-local):

```
ADMIN_API_TOKEN=dev-admin-token-change-me
MASTER_KEYS={"k1":"<base64 of 32 random bytes>"}
```

Generate strong key material:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### 5.2 Start every app process

Each process is a plain Node entrypoint (safe defaults, no bundler needed in dev):

```bash
RAJA_BOOTSTRAP_ADMIN_API=1  npx tsx apps/api/src/index.ts        # admin API + console
RAJA_BOOTSTRAP_SCHEDULER=1  npx tsx apps/scheduler/src/index.ts  # proxy probing + retention loop
```

The worker runtime (`apps/worker/src/index.ts`) exports `startWorker()` and is wired into the
queue milestone; its egress lifecycle (lease → report health → re-acquire on rest) is already
fully implemented and tested.

### 5.3 Typecheck & tests

```bash
npm run typecheck        # strict, whole workspace, excludes specs
npm test                 # 337 unit + integration tests (PGlite: real PostgreSQL semantics)
npm run test:unit        # pure-logic suites only
npm run test:integration # real-schema suites (migrations, pool, admin API, scheduler)
```

---

## 6. Deployment

> The platform ships as **plain Node processes + PostgreSQL + (optionally) Redis**. Container
> definitions and compose files are tracked under milestone M13 in
> [`docs/github-plan.md`](docs/github-plan.md); the following is the supported manual path today.

### 6.1 What you need

| Component | Required | Notes |
| --- | --- | --- |
| PostgreSQL 14+ | ✅ | Append-only triggers, partial indexes, advisory locks are used — a real server (not SQLite-compatible) is required in production. |
| Redis 6+ | Optional | Required once queue consumers (worker/bot) are enabled; the admin API + scheduler run without it. |
| Node.js 20.11+ | ✅ | One process per app, or any process manager (systemd, Docker, k8s). |
| Outbound HTTPS | ✅ | Provider traffic; proxy probing (gstatic 204) and npm registry at install time. |

### 6.2 Build

```bash
npm ci
npm run typecheck && npm test          # gate the build
npm run build                          # tsc -b tsconfig.build.json → packages/*/dist, apps/*/dist
```

> **Known issue:** `npm run build` currently fails on `main` because referenced package
> tsconfigs lack `composite: true` (pre-existing, tracked for M13). Run apps from source with
> `tsx` today: `npx tsx apps/api/src/index.ts` works from the repo root with no build step.

### 6.3 Production environment

Start from `.env.example` and set **at least**:

```env
NODE_ENV=production
DATABASE_URL=postgres://user:pass@host:5432/raja1
REDIS_URL=redis://host:6379

JWT_ACCESS_SECRET=<48+ random chars>
JWT_REFRESH_SECRET=<48+ random chars>
PASSWORD_PEPPER=<32+ random chars>
PAYMENT_WEBHOOK_SECRET=<32+ random chars>
MASTER_KEYS={"k1":"<base64 32B>","k2":"<base64 32B>"}   # ≥1 key; 2 enables rotation
ACTIVE_KEY_ID=k1
LOOKUP_HASH_KEY=<32+ random chars>

ADMIN_API_TOKEN=<strong token for the admin surface>
EGRESS_MODE=OFF            # start OFF; flip to OPTIONAL/REQUIRED from the console after setup
```

The process **refuses to start** and prints every problem if any of these are weak/missing —
that is intentional (fail-closed config, TM-20).

### 6.4 Database bootstrap

```bash
# apply pending migrations, then run the full integrity suite (audit chain, ledger,
# append-only triggers, tenant columns, proxy-pool coherence, …)
npx tsx packages/database/src/cli/migrate.ts bootstrap --url "$DATABASE_URL"

# later: inspect state
npx tsx packages/database/src/cli/migrate.ts status --url "$DATABASE_URL"
npx tsx packages/database/src/cli/migrate.ts verify --url "$DATABASE_URL"
```

Properties: forward-only, checksum-verified (a drifted migration is a hard error),
advisory-locked (safe with multiple replicas booting at once), per-migration transactions.
Never edit an applied migration; always add `NNNN_name.sql` and run
`node scripts/embed-migrations.mjs`.

### 6.5 Process topology

| Process | Command | Health | Notes |
| --- | --- | --- | --- |
| api | `RAJA_BOOTSTRAP_ADMIN_API=1 npx tsx apps/api/src/index.ts` | `/health/ready` | Binds `0.0.0.0:$API_PORT`; put behind TLS (Caddy/Nginx). |
| scheduler | `RAJA_BOOTSTRAP_SCHEDULER=1 npx tsx apps/scheduler/src/index.ts` | logs | Proxy probing + retention; keep exactly **one** instance per database (leases make it safe, but probing is redundant). |
| worker (M+) | `startWorker()` entry | logs | Requires Redis; scales horizontally — each worker leases its own egress proxy. |
| web | Next.js `build && start` | `/` | Talks to the API; same-origin or CORS `CORS_ORIGINS`. |
| telegram-bot | (M+) | logs | Requires Redis + `TELEGRAM_BOT_TOKEN`. |

Run behind a reverse proxy with TLS, HSTS and rate limiting (Caddy example lives with the M13
milestone). The admin surface must not be reachable from the public internet without the
bearer token; prefer network-level restriction (VPN/bastion) on top.

### 6.6 Backups & recovery

```bash
# logical backup (the ledger and audit chain are the crown jewels)
pg_dump --format=custom "$DATABASE_URL" > raja1-$(date +%F).dump

# restore into a fresh database, then verify integrity before serving traffic
pg_restore --clean --if-exists -d "$NEW_URL" raja1-$(date +%F).dump
npx tsx packages/database/src/cli/migrate.ts verify --url "$NEW_URL"
```

`migrate verify` re-checks the audit hash chain, ledger invariants, append-only triggers and
proxy-pool coherence — a restored backup that fails verification must not be promoted.
Back up and keep `MASTER_KEYS` separately from database dumps: dumps contain ciphertext
(`*_enc` columns) that is unrecoverable without the key ring.

### 6.7 Zero-downtime notes

- Migrations are forward-only and additive: run `bootstrap` **before** swapping app processes.
- The API holds no in-memory session state (JWT + DB sessions): run 2+ replicas freely.
- Workers drain leases on `SIGTERM` (`pool.release`) — give them a graceful-stop window.

---

## 7. Configuration reference

All variables are validated by zod (`packages/config/src/index.ts`); the table lists the
operationally interesting ones — see `.env.example` for the full annotated set.

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` activates the fail-closed secret checks. |
| `DATABASE_URL` | *(empty → PGlite)* | Production requires a real PostgreSQL. |
| `REDIS_URL` | *(empty)* | Required when queue consumers run. |
| `DRY_RUN` | `true` | No real reservations outside the armed triple-signal configuration. |
| `MOCK_PROVIDER` | `true` | No real provider traffic in dev/CI. |
| `PAYMENT_MODE` | `test` | `live` only in armed production. |
| `AUTO_BOOKING_GLOBAL` | `false` | Global kill-switch default (runtime value lives in DB, can only disable). |
| `MASTER_KEYS` / `ACTIVE_KEY_ID` | *(dev key)* | AES-256-GCM key ring for all `*_enc` columns (proxy credentials, phones, …). |
| `LOOKUP_HASH_KEY` | *(derived)* | HMAC key for deterministic lookup hashes (national-id dedup). |
| `ADMIN_API_TOKEN` | `dev-admin-token-change-me` | Bearer token for `/api/v1/admin/*`. |
| `EGRESS_MODE` | `OFF` | `OFF` / `OPTIONAL` / `REQUIRED` (see §8). |
| `PROXY_MIN_HEALTH_SCORE` | `0` | Pool refuses to lease proxies below this score. |
| `PROXY_PROBE_INTERVAL_SECONDS` | `300` | Probe cadence (60–3600). |
| `PROXY_LEASE_SECONDS` | `600` | Egress lease TTL (30–1800). |
| `PROVIDER_MAX_REQUESTS_PER_MINUTE` | `30` | Global cooperative rate limit. |
| `WORKER_CONCURRENCY` | `4` | Parallel jobs per worker. |
| `RETENTION_DIAGNOSTICS_DAYS` | `14` | Also governs `proxy_health_samples` pruning. |
| `API_PORT` | `3001` | Admin API + console port. |
| `EXPOSE_API_DOCS` | `true` (non-prod) | OpenAPI docs are dev-only by default. |

---

## 8. The egress proxy pool

Full specification: [`docs/proxy-pool.md`](docs/proxy-pool.md). Summary for operators:

- Admins curate a catalogue of outbound proxies (HTTP/HTTPS; SOCKS5 catalogued but requires a
  transport this build does not ship). Credentials are AES-256-GCM encrypted at rest, never
  returned by reads, never logged, never written to audit events.
- **One proxy serves one live worker; one worker holds one proxy** (sticky). This contains
  rate-limit blast radius per egress and keeps egress identity stable.
- **Rotation is admin-scheduled per proxy** (5 min … 24 h, default 1 h) with even wear
  (least-recently-rotated preferred). Rotation is **never** triggered by provider signals.
- **Rest (quarantine) replaces evasion.** When the provider signals a restriction on an egress
  (HTTP 429, block page, repeated CAPTCHA challenges, repeated 403/407), that proxy rests with
  an exponentially growing window (`base × 2^offences`, capped at 24 h) and a tightened request
  budget (halved per offence, floor 12.5 %). Traffic does **not** continue from a different IP.
- **Recovery only via evidence**: a successful probe through a neutral target
  (`gstatic.com/generate_204`) *after* the rest window reactivates the proxy and restores its
  budget gradually. ≥ 5 consecutive hard failures mark it `DEAD`.
- **Fail-closed modes**: `OFF` (default, pool inert) · `OPTIONAL` (use when available) ·
  `REQUIRED` (no healthy proxy ⇒ provider traffic is refused, the caller backs off).
- Every decision (admin + automatic) lands in the append-only `proxy_events` audit trail;
  every health observation lands in `proxy_health_samples` (update-proof, pruned after 14 days)
  and is charted per proxy in the web console.

### 8.1 Why this design (and not IP rotation)

Rotating to a fresh IP after a block is evasion: it defeats the provider's ability to enforce
its own rules and is the pattern this repository's threat model (TM-12, ADR-0008) and compliance
gate explicitly reject. The pool instead **reduces load and honours signals** — which is also
what actually keeps egress IPs healthy long-term. See §14.

---

## 9. Admin API & web console

Base path: `/api/v1` · Auth: `Authorization: Bearer $ADMIN_API_TOKEN` · Failed auth attempts
are rate-limited (20/min/IP → `429`).

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/admin/proxies` | List proxies (no secrets; counters, health, assignments) |
| `POST` | `/admin/proxies` | Add a proxy |
| `PATCH` | `/admin/proxies/:id` | Update (empty-string credential clears it) |
| `POST` | `/admin/proxies/:id/enable` · `/disable` | Toggle availability |
| `DELETE` | `/admin/proxies/:id` | Remove (audit events survive, `proxy_id` NULLed) |
| `GET` | `/admin/proxies/:id/events` | Audit trail |
| `GET` | `/admin/proxies/:id/samples?limit=120` | Recent health samples (oldest first) |
| `GET` | `/admin/proxies/pool` | Pool snapshot (totals, statuses) |
| `GET`/`PUT` | `/admin/proxy-settings` | Pool settings |
| `GET` | `/health/live` · `/health/ready` | Unauthenticated health (no data) |

`GET /admin` (no auth, static) serves the **Persian RTL web console**: pool summary cards,
proxy table with status pills and health bars, add/update/enable/disable/remove, pool settings
editor, per-proxy audit viewer and SVG trend charts. The page embeds no data and no token — it
prompts for `ADMIN_API_TOKEN` and calls the guarded endpoints with relative URLs.

```bash
curl -s http://localhost:3001/api/v1/admin/proxies/pool \
  -H "authorization: Bearer $ADMIN_API_TOKEN" | jq .totals
```

Full RBAC integration (permission `proxy:manage`, roles OPERATOR+) lands with the platform's
JWT guard milestone; today the surface is single-token guarded — treat `ADMIN_API_TOKEN` as a
secret and keep the admin surface off the public internet.

---

## 10. Testing

```bash
npm test                 # everything (337 tests, ~45 s)
npm run test:unit        # pure logic: rotation, quarantine, money, state machine, i18n, …
npm run test:integration # real PostgreSQL semantics via PGlite/WASM (no server needed)
```

What the suites actually prove (highlights):

| Suite | Guarantees |
| --- | --- |
| `database/test/migrations.int.spec.ts` | Migrations apply cleanly and idempotently; drift is fatal; tenant-scoped helpers cannot cross tenants; ledger/audit/booking history are append-only; audit hash chain detects tampering; **integrity checks return evidence rows**. |
| `proxy/src/__tests__/*.spec.ts` | Rotation: sticky per worker, admin-scheduled only, affinity, no quarantined/dead selection. Quarantine: 429/block/repeated-CAPTCHA/403 windows, budget tightening, DEAD threshold; timeouts never quarantine. |
| `proxy/test/proxy-pool.int.spec.ts` | Encrypted credentials at rest; one-proxy-one-worker leases; 429 ⇒ quarantine + freed lease + tightened budget; recovery only via post-window successful probe; audit trail; integrity check flags drift and heals. |
| `apps/api/test/*.int.spec.ts` | Bearer guard (401, brute-force 429), CRUD lifecycle, settings, snapshot without secrets, console page served without secrets. |
| `apps/scheduler/test/*.int.spec.ts` | Probe loop records samples; `proxy_pool_exhausted` signal fires. |

CI gate: `npm run typecheck && npm test` on every push (the sandbox has no provider egress —
tests are hermetic by design).

---

## 11. Database & migrations

- Forward-only SQL migrations in `packages/database/src/migrations/*.sql`, embedded into TS by
  `node scripts/embed-migrations.mjs` (checksummed; the runner refuses a drifted file).
- Every tenant-owned table carries `tenant_id NOT NULL`; composite FKs make cross-tenant
  references impossible at the DB level (verified by an integrity check).
- Append-only tables (ledger, booking history, audit, proxy events) are enforced by triggers —
  corrections happen by inserting compensating rows, never by mutation.
- Money is always `bigint` minor units + ISO-4217 currency.
- The integrity suite (`raja-migrate verify`) returns evidence rows: audit chain, wallet
  balances, append-only triggers, tenant columns, duplicate live reservations, money
  invariants, idempotency uniqueness, booking state machine, migration checksums, and
  proxy-pool coherence.

Adding a migration:

```bash
# 1. write packages/database/src/migrations/0007_my_change.sql
node scripts/embed-migrations.mjs     # 2. re-embed
npm run test:integration              # 3. prove it on the real engine
```

---

## 12. Operations runbook

| Situation | Action |
| --- | --- |
| Provider is rate-limiting/blocking | Nothing to do — affected proxies auto-rest with growing windows; watch the console's ⚑/rest columns. If the pool signals `proxy_pool_exhausted`, add capacity or drop monitoring frequency; **do not** add IPs to "rotate around" the restriction. |
| Proxy marked DEAD | Inspect its events (`/admin` → رویدادها). Fix credentials/reachability, then enable from the console — or let a successful probe recover it. |
| Pool exhausted (`REQUIRED` mode) | Provider traffic pauses (fail-closed). Add healthy proxies or switch to `OPTIONAL` deliberately. |
| Kill switch | `AUTO_BOOKING_GLOBAL=false` default; runtime value in `system_settings` can only disable. `MAINTENANCE_MODE` env for coarse degradation. |
| Restored backup | `pg_restore` → `migrate verify` → only promote when every check passes. Keep `MASTER_KEYS` safe: dumps are unrecoverable ciphertext without it. |
| Suspected secret compromise | Rotate `JWT_*` secrets (sessions re-auth) and add a new `MASTER_KEYS` entry, set `ACTIVE_KEY_ID`; old keys stay usable for decryption (envelope format is versioned per key id). |
| Admin token leaked | Rotate `ADMIN_API_TOKEN` (restart api) and audit `proxy_events` for unexpected changes. |
| Nightly hygiene | Scheduler loop: probes due set, prunes expired health samples, raises `proxy_pool_degraded`/`exhausted`; `migrate verify` (cron) for full integrity evidence. |

---

## 13. Documentation map

| Document | Contents |
| --- | --- |
| [`docs/architecture.md`](docs/architecture.md) | System context, containers, module boundaries, tenancy model, ADR index |
| [`docs/threat-model.md`](docs/threat-model.md) | STRIDE + domain threats (TM-01…), attack paths, mitigations |
| [`docs/domain-model.md`](docs/domain-model.md) | ER model, entity catalogue, tenant-isolation rules, indexes |
| [`docs/booking-state-machine.md`](docs/booking-state-machine.md) | Booking states, transitions, guards, idempotency |
| [`docs/provider-adapter.md`](docs/provider-adapter.md) | Provider interface, browser rules, egress binding contract |
| [`docs/provider-research.md`](docs/provider-research.md) | Research gate: APIs, auth, rate limits, restrictions |
| [`docs/scheduler.md`](docs/scheduler.md) | Monitoring strategies, jitter/backoff, fair scheduling, rate limiter |
| [`docs/proxy-pool.md`](docs/proxy-pool.md) | **Egress proxy pool: concepts, rest windows, probing, admin API, guarantees** |
| [`docs/high-demand-mode.md`](docs/high-demand-mode.md) | Release windows, warm-up, burst validation |
| [`docs/github-plan.md`](docs/github-plan.md) | Milestones M0…M14 with acceptance criteria |

---

## 14. Compliance posture (read before enabling anything)

Automated interaction with ticketing providers is **legally and contractually bounded**.
These are hard product rules, not comments:

1. Provider automation features are gated behind a **capability + compliance flag** per provider
   (`providers.compliance_status`). Until a provider is marked `APPROVED` after a documented
   ToS/compliance review, only `MONITOR_ONLY` and the local mock/simulator providers are usable —
   the target-provider adapter's methods throw `NotApprovedError` by design.
2. Raja1 **never** implements CAPTCHA solving or anti-bot evasion. Human verification pauses the
   job and notifies a real human (`verification_required`); the egress pool treats repeated
   CAPTCHA challenges as a *rest* signal, never as something to solve or route around.
3. Raja1 **never** rotates provider accounts or proxies to evade restrictions, quotas, bans, or
   geographic controls. The egress pool is routing infrastructure that *respects* signals:
   restricted egress rests; traffic does not continue from a different IP (ADR-0008).
4. Users must own the provider account they connect. Account linking uses provider-side
   verification, not credentials harvested by us.
5. Provider traffic is *cooperative*: jitter, backoff, per-proxy budgets, circuit breakers and
   capacity limits are designed to **reduce load**, never to maximise throughput.

See [`docs/threat-model.md`](docs/threat-model.md), ADR-0008
(in [`docs/architecture.md`](docs/architecture.md)) and
[`docs/proxy-pool.md`](docs/proxy-pool.md) § "Why this design".

---

## 15. Project status

Development is organised in milestones M0…M14 (see
[`docs/github-plan.md`](docs/github-plan.md)).

- **Shipped**: foundation packages (config/crypto/database/auth/RBAC/i18n), booking domain with
  state machine + guards, provider SDK with compliance gate, billing/ledger domain,
  **egress proxy pool end-to-end** (admin CRUD, leases, scheduled rotation, quarantine/rest,
  probing, retention, web console, admin API, health endpoints), 337 passing tests.
- **Next (tracked)**: queue consumers (BullMQ) wiring the worker runtime, Next.js web app
  pages, Telegram bot, NestJS migration of the API shell with JWT/RBAC guard, Dockerfiles +
  compose (M13), and the `tsc` composite build fix noted in §6.2.

## 16. License

Proprietary. All rights reserved. See `LICENSE`.
