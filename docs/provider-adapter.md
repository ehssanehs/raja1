# Provider Adapter Framework

> Code: [`packages/provider-sdk/src/`](../packages/provider-sdk/src/) ·
> Research gate: [provider-research.md](provider-research.md) ·
> Related: [ADR-0002](adr/0002-provider-adapter-boundary.md), [ADR-0008](adr/0008-no-captcha-bypass-no-evasion.md)

---

## 1. Principle

**Core application code never depends on a target site.** It depends on `ProviderAdapter` — a
contract expressed in the domain's language (stations, trips, availability, reservations) — and on
**capability flags** that tell the platform what is possible before it promises anything to a user.
Selectors, endpoints, cookie names, and parser quirks live *inside* an adapter folder and cannot
leak upward (enforced by package boundaries and lint rules).

---

## 2. Interface

```ts
// packages/provider-sdk/src/provider.interface.ts  (abridged)
export interface ProviderAdapter {
  readonly code: ProviderCode;
  readonly meta: ProviderMeta;            // display names, timezone, currency, docs links
  readonly capabilities: ProviderCapabilities;

  // --- catalogue -------------------------------------------------------------
  getStations(input?: StationQuery): Promise<ProviderStation[]>;
  getRoutes(input: RouteQuery): Promise<ProviderRoute[]>;

  // --- session ---------------------------------------------------------------
  login(ctx: ProviderContext, credentials: ProviderCredentials): Promise<ProviderSession>;
  validateSession(ctx: ProviderContext, session: ProviderSession): Promise<SessionValidity>;
  refreshSession?(ctx: ProviderContext, session: ProviderSession): Promise<ProviderSession>;
  logout?(ctx: ProviderContext, session: ProviderSession): Promise<void>;

  // --- availability ----------------------------------------------------------
  searchAvailability(ctx: ProviderContext, query: AvailabilityQuery): Promise<AvailabilityResult[]>;
  getTripDetails(ctx: ProviderContext, tripRef: ProviderTripRef): Promise<TripDetails>;

  // --- reservation lifecycle -------------------------------------------------
  startReservation(ctx: ProviderContext, selection: ReservationSelection): Promise<ReservationHandle>;
  submitPassengers(ctx: ProviderContext, handle: ReservationHandle, passengers: ProviderPassenger[])
    : Promise<PassengerSubmissionResult>;
  selectSeat?(ctx: ProviderContext, handle: ReservationHandle, seat: SeatSelection): Promise<SeatResult>;
  holdReservation?(ctx: ProviderContext, handle: ReservationHandle): Promise<HoldResult>;
  getReservationStatus(ctx: ProviderContext, handle: ReservationHandle): Promise<ReservationStatus>;
  confirmReservation?(ctx: ProviderContext, handle: ReservationHandle): Promise<ReservationStatus>;
  cancelReservation?(ctx: ProviderContext, handle: ReservationHandle): Promise<CancelResult>;

  // --- diagnostics -----------------------------------------------------------
  healthCheck(ctx: ProviderContext): Promise<ProviderHealthProbe>;
}
```

### Capability flags (declared, not advertised)

```ts
export interface ProviderCapabilities {
  // transport & access
  transport: 'HTTP_JSON' | 'BROWSER' | 'HYBRID';
  requiresLogin: boolean;
  requiresCaptcha: 'NEVER' | 'SOMETIMES' | 'ALWAYS' | 'UNKNOWN';
  compliance: 'APPROVED' | 'NOT_REVIEWED' | 'PROHIBITED';

  // search
  supportsReturnTrips: boolean;
  supportsPriceFiltering: boolean;
  supportsDateRangeSearch: boolean;     // multi-date in one call (rare)
  maxSeatsPerSearch: number;

  // booking
  supportsSeatSelection: boolean;
  supportsCoachSelection: boolean;
  supportsCompartmentPreference: boolean;
  supportsGenderSpecificCompartment: boolean;
  supportsHold: boolean;
  supportsAutoBooking: boolean;         // may the platform submit a reservation automatically?
  supportsCancellation: boolean;
  supportsRefundApi: boolean;
  paymentsAreThirdParty: boolean;       // e.g. bank-hosted payment page ⇒ human must pay

  // limits & quota
  maxPassengersPerReservation: number;
  sessionTtlMinutes?: number;
  rateLimitHint?: { requestsPerMinute: number; burst: number };
}
```

**Capability truth table.** The platform must never offer a feature the provider cannot support:

| Platform feature | Required capability |
| --- | --- |
| Seat preference UI | `supportsSeatSelection` |
| "Hold and notify me" | `supportsHold` |
| Any automation mode > `AUTO_FILL` | `supportsAutoBooking` **and** `compliance === 'APPROVED'` |
| Auto-cancel of lower-priority monitors after success | (platform-side, always allowed) |
| Gender-specific compartment option | `supportsGenderSpecificCompartment` |
| Multi-passenger atomic booking | `maxPassengersPerReservation ≥ passengerCount` |

---

## 3. Adapter layout (as required by the product spec)

```
packages/provider-sdk/src/providers/
  base/
    provider.interface.ts      # the contract
    provider.types.ts          # domain types shared by adapters
    http-provider.base.ts      # shared HTTP transport, retry, breaker hooks, redaction
    browser-provider.base.ts   # shared Playwright helpers (see § 5)
    rate-limit-aware.base.ts   # honours 429/Retry-After, emits throttle signals
  mock/
    mock.provider.ts           # deterministic in-memory provider used by unit tests
  simulator/                   # (client) talks to apps/provider-simulator over HTTP
    simulator.provider.ts
  target-provider/             # ⛔ disabled until the research gate passes
    provider.ts                # implements ProviderAdapter
    compliance.ts              # review status + evidence links (must be APPROVED to enable)
    routes/ stations/ auth/ availability/ passengers/ reservation/ checkout/
    parser/ selectors/
    __fixtures__/              # recorded (sanitized) responses for contract tests
```

`target-provider/` currently contains the folder structure, the capability declaration
(`compliance: NOT_REVIEWED`), explicit `UNVERIFIED` markers on every selector/endpoint, and a
`NotApprovedError` guard on all provider actions — i.e. it is a **safe placeholder**, not working
scraping code. Enabling it requires completing the gate checklist.

---

## 4. Transport strategies

| Strategy | Used for | Notes |
| --- | --- | --- |
| `HTTP_JSON` | Partner APIs / structured endpoints | Preferred: cheaper, faster, testable, low load |
| `BROWSER` | No API available and automation authorised | Playwright, isolated context per account, human-in-the-loop for verification |
| `HYBRID` | API for search, browser for reservation | Common in practice; search traffic must stay cheap |

Every adapter declares its strategy; the worker pool routes jobs to the matching executor, so a
browser-heavy adapter cannot starve an API-based one.

---

## 5. Browser automation rules (reliability, not evasion)

* **Pool**: N contexts per worker (configurable), each bound to one provider account and (optionally)
  a proxy; contexts are recycled after M navigations or on error.
* **Egress binding**: the worker leases an egress proxy from the admin-managed pool
  (`@raja/proxy`, docs/proxy-pool.md) and passes its id via `ProviderCallContext.egressProxyId`;
  the adapter binds the whole call to that egress. A restriction observed on that egress (429,
  block page, repeated CAPTCHA, 403/407) is reported through the pool, which quarantines the
  proxy — the adapter never switches egress mid-flight to keep requesting.
* **Isolation**: one browser context per account+job; no shared cookies; no persistent profile dir.
* **Waiting**: `waitForSelector`/`waitForFunction`/`waitForLoadState`/network-idle *only*; no
  hardcoded sleeps except a documented, bounded settle delay for known animations.
* **Interaction robustness**: scroll into view, wait for `enabled` and visibility, single click with
  post-condition verification (never click blindly twice), handle modals/dropdown animations,
  detect lazy-loaded content, re-locate elements after SPA re-render, verify every important action's
  effect on DOM state.
* **Timeouts**: three levels (selector 10 s, step 45 s, job hard cap 5 min) with structured errors.
* **Navigation recovery**: bounded retry (≤2) with a re-established session; on repeated failure,
  mark the provider degraded and stop.
* **Failure artifacts**: trace (zip), screenshot, sanitized HTML snapshot (passenger-input values
  removed, cookies/CSRF tokens stripped) with 14-day retention and `diagnostics_artifacts` tracking.
* **Detection of breakage**: selector/schema fingerprint checks; unexpected HTML structure or missing
  required elements ⇒ `SchemaDriftError` ⇒ disable the unsafe booking path, alert admins, do **not**
  retry in a loop.
* **Explicitly forbidden**: stealth/anti-detect plugins, canvas/WebGL spoofing, fingerprint
  randomisation to defeat anti-bot controls, CAPTCHA solving, proxying to bypass geographic or
  account restrictions. Browser settings may vary *for compatibility* (locale, timezone, viewport,
  browser version) and are documented as such in code.
* **Egress allow-list**: the browser may only navigate to the provider's registrable domain and its
  declared asset hosts; other navigations are blocked and counted (`provider.navigation_blocked`).

---

## 6. Isolation guarantees (tested)

| Rule | Test |
| --- | --- |
| No core package imports `providers/**` internals | `boundaries.spec.ts` (import graph scan) |
| Adapter cannot be constructed unless `compliance === 'APPROVED'` for real providers | `registry.spec.ts` |
| Capability flags gate every optional platform feature | `capabilities.matrix.spec.ts` |
| Adapter output is normalized & validated (Zod) before entering the domain | `normalization.spec.ts` |
| Adapter never logs secrets/PII | `adapter-redaction.spec.ts` |
| Contract test suite passes for every registered adapter | `contract.spec.ts` (shared suite applied to mock + simulator) |

---

## 7. Adding a new provider (checklist)

1. Complete [provider-research.md](provider-research.md) § 8 for that provider.
2. Create `providers/<code>/` implementing `ProviderAdapter` with explicit capability flags.
3. Provide fixtures + a contract-test run against them.
4. Register in `providers/registry.ts` with `compliance.review_status` and evidence URL.
5. Add station/route sync support (`provider-sync` queue) and a `system_settings` default profile.
6. Add localized display name/keys (no hardcoded strings).
7. Update docs (`provider-adapter.md`, `provider-research.md`) and open the provider milestone issue.
8. Security review for credential/session handling (per [security.md](security.md)).
