# Raja1 — Train-Ticket Monitoring & Assisted Reservation SaaS

> **Multi-tenant, provider-agnostic platform** for monitoring train-ticket availability and
> assisting — inside strict compliance, safety, and financial-integrity boundaries — with
> reservation workflows. Users book through a **Telegram bot** or the **responsive web app**.

[![CI](https://github.com/ehssanehs/raja1/actions/workflows/ci.yml/badge.svg)](https://github.com/ehssanehs/raja1/actions/workflows/ci.yml)
[![Security](https://github.com/ehssanehs/raja1/actions/workflows/security.yml/badge.svg)](https://github.com/ehssanehs/raja1/actions/workflows/security.yml)
![License](https://img.shields.io/badge/license-proprietary-lightgrey)
![Node](https://img.shields.io/badge/node-%3E%3D20.11-339933)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)

---

## 1. What this is (and is not)

| ✅ Is | ❌ Is not |
| --- | --- |
| An availability-monitoring product (the core, always-on capability) | A CAPTCHA-bypass or anti-bot-evasion tool |
| An **assisted** reservation workflow with explicit user consent at every irreversible step | A tool that purchases tickets without the account holder's authorisation |
| A provider-agnostic platform (first provider: an Iranian rail ticket provider) | A provider-specific scraper welded into the business core |
| A commercially billable SaaS with wallet ledger, invoices, coupons, referrals, quotas | A hobby script with a database |
| A **compliance-gated** automation platform: automation modes above `MONITOR_ONLY` require provider permission, admin enablement, and explicit user consent | A tool that rotates accounts/proxies to circumvent provider restrictions |

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
```

Three independent guards must all be satisfied before a real reservation could ever be
submitted — see [`docs/security.md`](docs/security.md) § *Booking submission guards* and
[`docs/booking-state-machine.md`](docs/booking-state-machine.md). Real production booking is
never enabled by accident, and enabling it requires a deliberate, audited, multi-signal
configuration change.

---

## 3. Architecture at a glance

```
                         ┌──────────────────────────────────────────────┐
   Telegram users ──────►│  apps/telegram-bot   (grammY, fa/en, inline) │──┐
                         └──────────────────────────────────────────────┘  │
                         ┌──────────────────────────────────────────────┐  │   same backend,
   Web users ───────────►│  apps/web            (Next.js 15, RTL/LTR)   │──┤   same tenancy,
                         └──────────────────────────────────────────────┘  │   same entitlements
                                                                           ▼
                         ┌──────────────────────────────────────────────┐
                         │  apps/api   NestJS modular monolith         │
                         │  /api/v1 · auth · booking · billing · admin  │
                         └───────┬──────────────┬───────────────┬───────┘
                                 │              │               │
                    ┌────────────▼───┐  ┌───────▼──────┐  ┌─────▼────────┐
                    │ apps/worker    │  │ apps/scheduler│  │ PostgreSQL   │
                    │ BullMQ + pools │  │ fairness +    │  │ (tenant-safe)│
                    │ provider adapter│ │ rate limiter  │  │ append-only  │
                    └────────┬───────┘  └───────┬───────┘  │ ledger       │
                             │                  │          └──────────────┘
                    ┌────────▼──────────────────▼───────┐
                    │ Redis: queues, locks, buckets      │
                    └────────┬──────────────────────────┘
                             ▼
                    ┌────────────────────────┐
                    │ Provider SDK           │
                    │  mock ● simulator ●    │
                    │  <target-provider>     │
                    └────────────────────────┘
```

Full diagrams: [`docs/architecture.md`](docs/architecture.md).

---

## 4. Repository layout

```
apps/
  api/                 NestJS API (versioned /api/v1, OpenAPI, metrics, health)
  web/                 Next.js 15 app router, fa/en, RTL/LTR, mobile-first
  telegram-bot/        grammY bot, bilingual wizard + inline keyboards
  worker/              BullMQ consumers: availability, booking, provider-sync, …
  scheduler/           fair scheduler, rate limiter, high-demand release planner
  provider-simulator/  Local mock railway ticketing provider (CI + dev)
packages/
  shared/              Money, time, ids, result types, enums, i18n keys
  config/              Zod-validated env config (fail-closed)
  logging/             Structured PII-redacting logger, correlation ids
  crypto/              Argon2id, AES-256-GCM envelope encryption, key ring
  database/            Pool, migrations (forward-only), repositories, tenancy guard
  auth/                JWT access/refresh with rotation, RBAC, sessions
  provider-sdk/        Provider interface, capability flags, registry, contract tests
  proxy/               Egress proxy pool: admin CRUD, per-worker leases, scheduled rotation, rest/quarantine, probing
  queue/               Queue names, job contracts, idempotency, Redis locks
  billing/             Wallet ledger, subscriptions, entitlements, quotas, payments
  notifications/       Channel abstraction + dedup + preferences
  booking/             Domain: state machine, matching/scoring, monitors, orchestrator
  testing/             PGlite DB harness, fakes, fixtures, tenant-isolation matrix
docs/                  Architecture, threat model, runbooks, ADRs, state machine
docker/                Dockerfiles, compose (dev + production), Caddy/Nginx
.github/workflows/     CI, security, release
```

---

## 5. Quick start

```bash
# 1. install
npm ci

# 2. configure (development defaults are already safe)
cp .env.example .env

# 3. start dependencies + apps (api, web, worker, scheduler, bot, postgres, redis, simulator)
docker compose -f docker/docker-compose.yml up --build

# --- or run everything locally without Docker ---
npm run migrate:up     # apply migrations (PGlite file DB when DATABASE_URL is empty)
npm run seed           # plans, feature flags, system settings, demo tenant
npm test               # 900+ unit + integration tests, no network, no provider traffic
```

| Service | URL |
| --- | --- |
| Web app | http://localhost:3000 |
| API (OpenAPI) | http://localhost:3001/api/docs |
| **Proxy admin console** | http://localhost:3001/admin |
| Metrics | http://localhost:3001/metrics |
| Health | http://localhost:3001/health/ready |
| Provider simulator | http://localhost:4010 |

---

## 6. Documentation map

| Document | Contents |
| --- | --- |
| [`docs/architecture.md`](docs/architecture.md) | System context, containers, module boundaries, tenancy model, diagrams |
| [`docs/threat-model.md`](docs/threat-model.md) | STRIDE + domain threats, attack paths, mitigations, residual risk (TM-01…) |
| [`docs/domain-model.md`](docs/domain-model.md) | ER model, entity catalogue, tenant-isolation rules, indexes |
| [`docs/booking-state-machine.md`](docs/booking-state-machine.md) | States, transitions, guards, idempotency, concurrency |
| [`docs/provider-adapter.md`](docs/provider-adapter.md) | Provider interface, capability flags, compliance gate, adapter layout |
| [`docs/provider-research.md`](docs/provider-research.md) | Research gate: APIs, auth, sessions, booking flow, rate limits, restrictions |
| [`docs/scheduler.md`](docs/scheduler.md) | Monitoring strategies, jitter/backoff, fair scheduling, rate limiter, breaker |
| [`docs/proxy-pool.md`](docs/proxy-pool.md) | Admin-managed egress proxy pool: leases, rotation schedules, rest windows, probing, admin API |
| [`docs/high-demand-mode.md`](docs/high-demand-mode.md) | Release windows, warm-up, burst validation, capacity protection, waiting room |
| [`docs/billing.md`](docs/billing.md) | Entitlements, pricing, payment abstraction, invoices, refunds, dry-run |
| [`docs/wallet.md`](docs/wallet.md) | Append-only ledger, idempotency, credits, reconciliation |
| [`docs/subscriptions.md`](docs/subscriptions.md) | Plans, quotas, trials, expiry, upgrade/downgrade semantics |
| [`docs/security.md`](docs/security.md) | AuthN/Z, RBAC matrix, crypto, secrets, rate limits, anti-abuse, booking guards |
| [`docs/telegram.md`](docs/telegram.md) | Bot commands, wizard, linking flow, notification catalogue |
| [`docs/web.md`](docs/web.md) | Pages, i18n/RTL, accessibility, API usage |
| [`docs/deployment.md`](docs/deployment.md) | Docker, compose, migrations, backups/restore, DR |
| [`docs/operations.md`](docs/operations.md) | Runbooks: kill switch, degradation, incident response, reconciliation |
| [`docs/privacy.md`](docs/privacy.md) | PII inventory, retention, export/deletion, consent |
| [`docs/troubleshooting.md`](docs/troubleshooting.md) | Symptoms → diagnosis → fix |
| [`docs/adr/`](docs/adr/) | Architecture decision records (with rejected alternatives) |

---

## 7. Compliance posture (read before enabling anything)

Automated interaction with ticketing providers is **legally and contractually bounded**.

1. Provider automation features are gated behind a **capability + compliance flag** per provider
   (`provider.compliance.reviewStatus`). Until a provider is marked `APPROVED` after a documented
   ToS/compliance review, only `MONITOR_ONLY` and the local mock/simulator providers are usable.
2. Raja1 **never** implements CAPTCHA solving or anti-bot evasion. Human verification pauses the
   job and requests a real human.
3. Raja1 **never** rotates provider accounts or proxies to evade restrictions, quotas, bans, or
   geographic controls. The optional egress proxy pool (`docs/proxy-pool.md`) is *routing
   infrastructure that respects provider signals*: a restricted egress IP rests (quarantine with
   growing windows and tightened budgets) — traffic does not continue from a different IP.
   Rate limits are honoured globally, per account, per proxy, and per user.
4. Users must own the provider account they connect. Account linking uses provider-side
   verification, not credentials harvested by us.
5. Provider traffic is *cooperative*: the scheduler is designed to reduce load (jitter, backoff,
   circuit breaker, capacity limits), never to maximise request throughput.

See [`docs/provider-research.md`](docs/provider-research.md) and
[`docs/security.md`](docs/security.md) for the full gate criteria.

---

## 8. Project status

Development is organised in milestones M0…M14 (see [`docs/github-plan.md`](docs/github-plan.md)).
Current status, verified test results, and open risks are reported in
[`docs/production-readiness.md`](docs/production-readiness.md) and on the GitHub milestone board.

## 9. License

Proprietary. All rights reserved. See `LICENSE`.
