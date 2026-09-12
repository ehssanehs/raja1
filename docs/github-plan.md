# GitHub Milestones & Issue Plan

> This file is the source of truth for the milestone/issue programme that is created in the
> repository via `gh`. Issue numbers here are **plan keys** (`M3-02`), not GitHub numbers.

## Milestones

| Milestone | Title | Goal (definition of done) |
| --- | --- | --- |
| `M0` | Research & Compliance Gate | Provider research documented; compliance gate defined; exit criteria published |
| `M1` | Architecture & Threat Model | Architecture, domain model, state machine, threat model, ADRs merged and reviewed |
| `M2` | Platform Foundation | Monorepo, config, logging, crypto, DB layer + migrations, CI, Docker skeleton |
| `M3` | Authentication & Tenancy | AuthN (Argon2id, JWT+refresh rotation), RBAC, tenant isolation, sessions, audit |
| `M4` | Booking Domain | Booking requests, monitors, state machine, scoring/matching, timeline |
| `M5` | Provider Framework | Provider SDK, capability flags, mock + simulator adapters, contract tests |
| `M6` | Monitoring Engine | Scheduler, strategies, rate limiter, fairness, breaker, health scores |
| `M7` | Telegram Bot | Bilingual bot, wizard, linking, notifications |
| `M8` | Web Application | Next.js app: dashboard, wizard, passengers, wallet, invoices, settings (fa/en, RTL) |
| `M9` | SaaS Billing | Plans, entitlements, quotas, wallet ledger, payments, invoices, coupons, referrals |
| `M10` | Admin & Operations | Admin dashboards, release console, kill switch, maintenance modes, support |
| `M11` | Security Hardening | Threat-model fixes, abuse controls, webhook hardening, security tests, review |
| `M12` | Testing & Chaos | E2E, chaos/failure, billing edge cases, provider simulator scenarios |
| `M13` | Deployment | Docker/compose, Nginx/Caddy, backups/restore, DR, runbooks |
| `M14` | Production Readiness | Checklist, load test, adversarial review, readiness report |

## Issues

Each issue: title, labels, milestone, acceptance criteria. `[x]` = completed in this session.

### M0 — Research & Compliance Gate
- [x] **M0-01** Provider research document (`docs/provider-research.md`) — *docs, compliance*
- [x] **M0-02** Compliance gate + capability flags design — *compliance, architecture*
- [x] **M0-03** Open research questions register (Q1–Q10) with owners

### M1 — Architecture & Threat Model
- [x] **M1-01** System architecture document with diagrams
- [x] **M1-02** Domain model + tenant-isolation rules + index plan
- [x] **M1-03** Booking state machine (states, guards, concurrency)
- [x] **M1-04** Threat model (TM-01…TM-28) + residual risk register
- [x] **M1-05** ADRs 0001–0008
- [x] **M1-06** Scheduler + high-demand mode design

### M2 — Platform Foundation
- [x] **M2-01** Monorepo workspaces, strict TS, lint, formatting
- [x] **M2-02** Zod-validated config with fail-closed production guards
- [x] **M2-03** Structured PII-redacting logger with correlation IDs
- [x] **M2-04** Crypto package: Argon2id, AES-256-GCM envelope, key ring, HMAC lookup hashes
- [x] **M2-05** Database layer: pool, PGlite test harness, migrations runner, tenancy-typed repos
- [x] **M2-06** Migration 0001: platform, tenancy, booking, billing, ops schema + indexes
- [x] **M2-07** Migration 0002: hardening (checks, append-only guards, audit chain)
- [x] **M2-08** Migration 0003: seed plans, flags, settings, provider registry, stations
- [x] **M2-09** CI workflow (lint, typecheck, unit, integration, build, audit)

### M3 — Authentication & Tenancy
- [x] **M3-01** Password hashing policy + strength validation + breach hook
- [x] **M3-02** Access/refresh JWT with rotation, family revocation, hashed storage
- [x] **M3-03** Session management + revocation + anomaly notification
- [x] **M3-04** RBAC: roles, permission catalogue, deny-by-default guard, matrix tests
- [x] **M3-05** Tenant scoping in repositories + IDOR sweep tests
- [x] **M3-06** Rate limits for auth endpoints (per IP + per account)
- [x] **M3-07** Audit events for auth lifecycle

### M4 — Booking Domain
- [x] **M4-01** Booking request model + validation (route, window, passengers, entitlements)
- [x] **M4-02** Multi-date monitors + priorities + auto-cancel of lower priorities
- [x] **M4-03** State machine implementation + transition log + property tests
- [x] **M4-04** Matching/scoring engine (STRICT/FLEXIBLE) + preference weights
- [x] **M4-05** Price observations, max-price enforcement, price-drop detection
- [x] **M4-06** Result deduplication via availability fingerprint
- [x] **M4-07** Booking timeline events + user-visible timeline
- [x] **M4-08** Passenger profiles with encrypted PII + export/delete

### M5 — Provider Framework
- [x] **M5-01** Provider interface + types + capability flags
- [x] **M5-02** Registry with compliance gate (refuses unapproved real providers)
- [x] **M5-03** Mock provider (deterministic, scriptable scenarios)
- [x] **M5-04** Provider simulator app (Fastify, state machine, CAPTCHA, failures, price changes)
- [x] **M5-05** Simulator-backed adapter + contract test suite for all providers
- [x] **M5-06** Target-provider template (disabled, UNVERIFIED markers, NotApproved guard)
- [x] **M5-07** Station/route sync + autocomplete + aliases (fa/en)

### M6 — Monitoring Engine
- [x] **M6-01** Scheduler with lease + fencing token
- [x] **M6-02** Monitoring strategies (FIXED/JITTERED/PRIORITY/BACKOFF/RELEASE/ADAPTIVE)
- [x] **M6-03** Token-bucket rate limiter (provider/account/proxy/worker/user/release)
- [x] **M6-04** Weighted fair scheduling + per-tenant concurrency caps + tests
- [x] **M6-05** Circuit breaker + provider/account/proxy health scores
- [x] **M6-06** Burst validation (0/+3/+10s) bounded by budget
- [x] **M6-07** Queue topology (8 queues), job contracts, idempotency, retries
- [x] **M6-08** Release windows, warm-up, admission control, waiting room, capacity leases

### M7 — Telegram Bot
- [x] **M7-01** grammY bot skeleton, session/conversation state, i18n (fa/en)
- [x] **M7-02** /start linking flow (single-use code, numeric id only, revoke)
- [x] **M7-03** Booking wizard (origin→…→start monitoring) with inline keyboards
- [x] **M7-04** /bookings, /passengers, /wallet, /subscription, /history, /status, /settings, /help, /support
- [x] **M7-05** Notification delivery + approval/verification callbacks (signed)
- [x] **M7-06** Bot-side rate limiting + abuse guards

### M8 — Web Application
- [x] **M8-01** Next.js app shell, i18n (fa/en), RTL/LTR, design tokens, mobile-first
- [x] **M8-02** Auth pages (login, register, verify, reset) against the API
- [x] **M8-03** Dashboard (monitors, matches, bookings, wallet, subscription, quota, activity)
- [x] **M8-04** Create-booking wizard with map of preferences + live validation
- [x] **M8-05** Active monitors + booking detail with timeline
- [x] **M8-06** Passengers CRUD, wallet/transactions, invoices, notifications, profile, referral, settings, support
- [x] **M8-07** Human-verification and approval UIs

### M9 — SaaS Billing
- [x] **M9-01** Plans/features/prices + entitlement resolver (no hardcoded plan logic)
- [x] **M9-02** Quota engine (monthly/daily/lifetime, server-side enforcement, reset jobs)
- [x] **M9-03** Wallet ledger (append-only, idempotent, concurrency-safe, credits with expiry)
- [x] **M9-04** Charge authorization lifecycle (authorize → settle/release → refund)
- [x] **M9-05** Payment provider abstraction + test gateway + webhook verification/replay protection
- [x] **M9-06** Invoices + lines + number sequence + replaceable renderer interface
- [x] **M9-07** Coupons (percent/fixed/bonus/free-days/feature-unlock) with transactional limits
- [x] **M9-08** Referrals with qualification + anti-abuse + ledger rewards
- [x] **M9-09** Reconciliation job (ledger ↔ invoices ↔ payments) + discrepancy report

### M10 — Admin & Operations
- [x] **M10-01** Admin API + permission gates + masked views
- [x] **M10-02** Admin dashboard data endpoints (users, jobs, queues, providers, wallets, payments)
- [x] **M10-03** Release console endpoints (windows, admissions, capacity, burst metrics)
- [x] **M10-04** Kill switch + maintenance modes (full/provider/monitoring-only/booking-disabled)
- [x] **M10-05** Feature flags: global/plan/user with expiry
- [x] **M10-06** Support tickets (user + agent flows, internal notes)
- [x] **M10-07** Fraud signals queue + review workflow (no automatic accusation)
- [x] **M10-08** Admin promos: wallet credit, subscription days, targeted campaigns (audited)

### M11 — Security Hardening
- [x] **M11-01** Rate limiting middleware (per-IP/per-user) + 429 semantics
- [x] **M11-02** Security tests: IDOR, privilege escalation, webhook forgery/replay, XSS/SQLi inputs
- [x] **M11-03** Secret scanning + dependency audit workflows
- [x] **M11-04** Log-redaction regression tests (synthetic PII payload)
- [x] **M11-05** Adversarial review report + fixes + regression tests
- [x] **M11-06** SECURITY.md, vulnerability disclosure, hardening checklist

### M12 — Testing & Chaos
- [x] **M12-01** Unit test suites across packages
- [x] **M12-02** Integration tests on real Postgres semantics (PGlite)
- [x] **M12-03** Provider simulator scenario tests (sold out → appears, CAPTCHA, failures, price change)
- [x] **M12-04** Booking chaos: crash after lock, duplicate delivery, recovery protocol
- [x] **M12-05** Billing edge cases: concurrent wallet ops, duplicate callbacks, coupon race
- [x] **M12-06** API E2E suite against a booted app

### M13 — Deployment
- [x] **M13-01** Dockerfiles (api, web, worker, scheduler, bot, simulator) multi-stage, non-root
- [x] **M13-02** docker-compose.yml (dev) + docker-compose.production.yml + .env.example
- [x] **M13-03** Reverse proxy config (Caddy) with security headers + rate limiting
- [x] **M13-04** Backup/restore scripts + restore verification + DR runbook
- [x] **M13-05** Release workflow (tag → build/push images, no auto-production-deploy)

### M14 — Production Readiness
- [x] **M14-01** Readiness checklist executed with evidence
- [x] **M14-02** Load test (scheduler/queues) with results
- [x] **M14-03** Production readiness report + residual risks
- [x] **M14-04** Operations runbooks (kill switch, breaker, reconciliation, incident)

## Labels

`type:feature` `type:bug` `type:docs` `type:test` `type:security` `type:chore`
`area:api` `area:web` `area:bot` `area:worker` `area:scheduler` `area:db` `area:billing`
`area:provider` `area:security` `area:devops`
`priority:critical` `priority:high` `priority:medium` `priority:low`
`risk:pii` `risk:financial` `risk:compliance` `status:blocked` `status:needs-review`

## Branch & PR conventions

* Branch: `feat/M2-05-database-layer`, `fix/M11-02-idor-invoice-endpoint`, `docs/M1-04-threat-model`.
* One milestone per PR where the change is cohesive; otherwise per issue.
* PR template requires: summary, milestone/issue link, test evidence (command + result),
  security review note (for `risk:*` labels), and screenshots for UI changes.
* `main` is protected in spirit: changes land through PRs; CI must be green.
