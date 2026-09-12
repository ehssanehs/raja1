# High-Demand / Release-Time Mode

> Code: [`packages/booking/src/release/`](../packages/booking/src/release/) ·
> [`apps/scheduler/src/release-planner.ts`](../apps/scheduler/src/release-planner.ts) ·
> Related: [scheduler.md](scheduler.md), [provider-research.md](provider-research.md) § 5

---

## 1. Why this exists

For Iranian rail presales, a whole month of tickets is released at one announced moment
(historically **08:00–08:30**, with the online window often **08:30–11:00** — see
[provider-research.md](provider-research.md) § 5). Demand massively exceeds supply in the first
seconds; the provider's own announcements show they manage load by *shutting down channels*.
Therefore release-time monitoring must be **prepared before the release** and then executed within a
**strict, administrator-approved traffic budget**.

**Design stance: readiness, not volume.** We win on preparation, correctness, and latency of
*reaction* — never by generating more requests than an authorised channel permits.

---

## 2. Configuration model

```yaml
release_window:
  provider: raja
  label: "Mordad 17-31 presale"
  expected_release_at: 2026-07-28T08:30:00+03:30 # stored UTC internally
  warmup_minutes_before: 40                      # session + worker preparation
  search_start_offset_ms: -10000                 # begin probing 10s before the announcement
  burst_duration_seconds: 120
  burst_interval_seconds: 3
  decay: { half_life_seconds: 90, floor_interval_seconds: 60 }
  normal_interval_seconds: 60
  capacity_max_jobs: 400                         # admission control
  max_burst_requests_per_minute: 40              # cannot exceed provider hard ceiling
  require_prepared_session: true
```

Everything above is **admin-managed data** (`release_windows` table), not code. Defaults are
conservative; the hard ceilings in code (e.g. min 1 request/s globally per provider, interval floor)
cannot be exceeded by configuration.

### Timeline (reference schedule)

| Offset | Phase | What happens |
| --- | --- | --- |
| T-60 min | `ANNOUNCED` | Window created/verified; users notified "monitoring armed for release" |
| T-40 min (`warmup_minutes_before`) | `WARMUP` | Sessions validated/refreshed, passengers validated, proxies checked, provider connectivity probe, booking configuration validated |
| T-5 min | `PREPARED` | Worker/browser slots leased (`capacity_leases`), queue drained of non-critical work, admission list finalized |
| T-10 s (`search_start_offset_ms`) | `ARMED` | Scheduler switches to fast tick; tokens pre-computed; job payloads pre-rendered |
| T 0 | `ACTIVE` | Burst cadence begins within the approved budget |
| T+burst_duration | `DECAY` | Interval decays (half-life) back to normal |
| T+60 min | `COMPLETED` | Metrics + post-mortem summary; unprepared users moved to normal monitoring |

```mermaid
gantt
    title Release window lifecycle (example 08:30 presale)
    dateFormat HH:mm
    axisFormat %H:%M
    section Preparation
    Window announced            :07:30, 10m
    Session warm-up             :07:50, 15m
    Worker/capacity prep        :08:25, 4m
    Armed (fast tick)           :08:29:50, 10s
    section Execution
    Burst                       :08:30, 2m
    Decay to normal             :08:32, 28m
    Normal monitoring           :09:00, 60m
    section Users
    Notification: armed         :07:45, 1m
    Notification: ticket found  :08:30, 1m
```

---

## 3. Session warm-up (never a booking)

`session_warmup` (default: `enabled=true`, `before_release_minutes=10…40`,
`refresh_before_expiration_minutes=10`):

1. Load the assigned provider account (sticky per user, `STICKY_PER_USER` by default).
2. `validateSession()` — if valid, extend TTL; if expiring within the refresh threshold, refresh.
3. If invalid: **only** re-authenticate if the provider permits programmatic login; a CAPTCHA/OTP
   challenge escalates to the user *now* (not at T=0) — this is the single most valuable
   preparation win.
4. Validate passenger data completeness against the trip (national ID + DOB present and matching
   provider requirements) and warn the user early about anything missing.
5. Pre-flight the booking configuration (class, seat preference, price ceiling, passenger count
   feasible under provider limits).
6. Check connectivity/latency through the assigned proxy and rotate to a healthy one **within the
   same account policy** (never to evade a restriction).
7. Prepare the browser context (if the adapter is browser-based) and cache it.

**Hard rule:** during warm-up the orchestrator may never pass `AWAITING_USER_APPROVAL`,
`READY_FOR_CHECKOUT`, or any reservation-creating transition. A guard test asserts that no warm-up
path can call reservation methods (`warmup-no-booking.spec.ts`).

---

## 4. Admission control and capacity protection

```text
expected_load = Σ (admitted_jobs × burst_requests_per_job) / burst_duration
safe_capacity = min(
    provider_budget_per_minute      ,   # from rate-limiter ceiling
    workers × contexts_per_worker   ,   # browser/HTTP pools
    rate_limiter_accounts × account_qps,
)
admit while expected_load < safe_capacity * safety_margin (default 0.8)
```

* Admission is per (window, booking request) and recorded in `release_window_admissions`.
* Users with `highDemandMode` entitlement and PREMIUM/BUSINESS plans are admitted first; the rest go
  to the **waiting room** (FIFO within plan tier) and are admitted as slots free up — including
  *during* the burst, because tickets appear over time.
* If demand exceeds the safe capacity, we **refuse** (and say so) rather than overload the provider.
  The refusal is explicit, not silent: `admission_reason = CAPACITY_EXCEEDED`.
* Capacity leases reserve worker/context slots so a window cannot be starved by unrelated work.

### Waiting room semantics

| State | User experience |
| --- | --- |
| `ADMITTED` | "Monitoring armed — you'll be notified the moment a seat appears" |
| `WAITING_ROOM` | Position + estimated window + honest text: "Priority is by plan; you are #37" |
| `REJECTED` | Reason (`CAPACITY_EXCEEDED`, `NO_SESSION`, `UNPAID_INVOICE`) + next-best action |

---

## 5. Burst mechanics

* The scheduler switches to a fast tick (`250 ms`) during `ARMED`/`ACTIVE` only.
* Each admitted monitor searches at `burst_interval_seconds` (default 3 s), jittered ±25% to avoid
  a synchronised stampede from our own fleet.
* Every burst request takes tokens from provider/account/proxy/user buckets — the burst is *within*
  the budget, never above it.
* Detected availability immediately triggers burst validation (t=0/+3s/+10s, [scheduler.md](scheduler.md) § 3)
  and then the normal booking path.
* If the provider responds with 429/throttle signalling, the window degrades gracefully: burst
  interval rises, `global_load_factor` increases, and users are told the provider is throttling.
* If the breaker opens, the window enters `DEGRADED`: monitoring continues at floor cadence with
  circuit probes; no user is told "no tickets exist" when the truth is "we cannot ask".

---

## 6. Operator surface (Release Dashboard)

`apps/web` → Admin → **Release Console** (permission `release:manage`):

* Upcoming windows (provider, expected time in provider-local **and** UTC, countdown).
* Prepared vs unprepared sessions; accounts with expiring sessions; CAPTCHA-blocked accounts
  (actionable: nudge the user *now*).
* Admission counts by plan tier, waiting-room depth, capacity headroom.
* Live burst metrics: requests/min (against budget), token-bucket saturation, error rate, breaker
  state, p95 search latency.
* One-click actions (all audited): create/edit window, arm/disarm, raise burst budget **within hard
  ceilings**, extend burst duration, cancel window with reason.
* Post-window summary: tickets observed, monitors satisfied, admissions served/queued/rejected,
  provider-side errors, cost.

---

## 7. Billing transparency for high-demand mode

High-demand mode is a **paid, explicitly disclosed** feature ([billing.md](billing.md)):

* The user sees the surcharge and the exact window **before** activating
  (consent record: `high_demand_activation`, versioned).
* Charging modes: included in plan, per-window fee, or per-monitor surcharge — all configurable.
* If we fail to admit the user (capacity), any surcharge is **automatically refunded** (ledger entry,
  never a silent adjustment).
* Never charge for a window we could not actually serve.

---

## 8. Testing requirements

| Scenario | Assertion |
| --- | --- |
| Warm-up with expired session | Session refreshed or user notified ahead of T0; **no** reservation attempt |
| Warm-up with CAPTCHA | Escalation notification ≥ 10 min before release |
| 5,000 monitors due at T0 with budget of 40 req/min | Zero provider requests over budget; every monitor served within the decay period |
| Ticket appears at T+0 | Validation at +0/+3/+10, single notification, correct lock |
| Provider 429 during burst | Interval rises, throttle metric increments, no retries faster than `Retry-After` |
| Capacity exceeded | Rejections are explicit, surcharge refunded, waiting-room positions correct |
| Breaker opens mid-burst | Window → `DEGRADED`, users get honest status, probes continue |
| Clock/timezone | Window computed correctly for `Asia/Tehran` (no DST) and display in user timezone |
