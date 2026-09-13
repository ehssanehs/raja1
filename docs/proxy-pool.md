# Egress Proxy Pool (`@raja/proxy`)

Admin-managed catalogue of outbound (egress) proxies for provider traffic, with health
probing, per-worker leases, admin-scheduled rotation and a *rest* (quarantine) lifecycle.

> **Posture (ADR-0008): routing + respect, never evasion.**
> The pool exists to *route* traffic and to *respect* provider signals — not to dodge them.
> There is deliberately **no** "rotate on block" mode: when a provider rate-limits or blocks an
> egress IP, that proxy **rests**; traffic does not continue from a different IP. Rotation is
> slow, admin-scheduled (≥ 5 minutes) and exists for even wear — never as a response to
> restriction signals. CAPTCHA challenges are surfaced to humans (`HUMAN_VERIFICATION_REQUIRED`);
> they are never solved automatically and never used as a rotation trigger.

---

## 1. Concepts

| Concept | Meaning |
| --- | --- |
| **Proxy** | One entry of the admin catalogue: `protocol/host/port` + optional credentials (AES-256-GCM envelope-encrypted at rest), optional provider affinity (`provider_code`), region tag, rotation window, per-minute request budget. |
| **Lease** | A worker's exclusive handle on a proxy. One proxy serves at most one live worker; one worker holds at most one proxy. Leases expire (default 10 min) so crashed workers cannot strand a proxy. |
| **Rotation** | Admin-defined per-proxy window (`rotation_seconds`, 5 min … 24 h). A worker keeps its proxy while healthy and inside the window; after the window it moves to the least-recently-rotated healthy proxy (even wear). |
| **Rest (quarantine)** | When the provider signals a restriction on the egress (HTTP 429, block page, repeated CAPTCHA, repeated 403/407), the proxy is marked `QUARANTINED` until a rest window elapses and a *successful probe* revalidates it. Its request budget is tightened (halved per offence, floor 12.5%). |
| **Dead** | Sustained hard failures (≥ 5 consecutive auth-ish/block failures) mark a proxy `DEAD`; it is never selected until an admin re-enables it or a successful probe recovers it. |
| **Egress mode** | `OFF` (default — pool inert), `OPTIONAL` (use a proxy when available, else direct), `REQUIRED` (refuse provider traffic without a healthy proxy — fail-closed). |

## 2. Why a worker keeps its proxy (and when it does not)

- **Sticky per worker** while the proxy is enabled, `ACTIVE`, healthy enough, and inside its
  rotation window → stable egress identity, no IP churn.
- The worker **loses** its proxy when: it is quarantined (the lease is freed immediately — the
  resting proxy serves nobody), it is disabled/removed by an admin, it dies, or the rotation
  window elapses. The next provider call then re-acquires; if nothing healthy exists the call is
  refused/backed off — it never switches IP to push through a restriction.

## 3. Rest windows and budgets (the anti-blocking-that-we-do)

The only legitimate "avoid getting blocked" strategy is *creating less load and honouring
signals*. Concretely, per proxy:

| Signal | Action |
| --- | --- |
| `429` / `RATE_LIMIT` | Rest `2 × base` window, budget × ½ |
| Provider block page | Rest `2 × base` window, budget × ½ |
| CAPTCHA once | Recorded, traffic continues (one may be incidental; a human is asked per the booking flow) |
| CAPTCHA repeatedly | Rest `2 × base` window (the IP is being challenged — let it rest) |
| Repeated `403/407` (≥ 3) | Rest `1 × base` window |
| Plain timeouts/network errors | No rest — health score drops, proxy is deprioritised |
| ≥ 5 consecutive hard failures | `DEAD` (ops attention) |

Rest windows grow exponentially with repeat offences (`base × 2^offences`, capped at 24 h) and
budgets recover gradually (doubling back to 100% on successes after recovery). Base window is
900 s (`PROXY_SETTINGS_LIMITS.DEFAULT_REST_SECONDS`).

## 4. Probing

The scheduler's maintenance loop probes proxies that are due (rest elapsed, never validated, or
periodic) **through a neutral target** (`https://www.gstatic.com/generate_204`) so a probe never
looks like provider traffic. A successful probe after the rest window releases quarantine and
restores the budget gradually; failing probes keep the proxy resting.

## 5. Admin API (under `/api/v1`, bearer `ADMIN_API_TOKEN`)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/admin/proxies` | List (no secrets, counters + health included) |
| `POST` | `/admin/proxies` | Add a proxy (`label, protocol, host, port, username?, password?, providerCode?, region?, rotationSeconds?, requestsPerMinute?`) |
| `PATCH` | `/admin/proxies/:id` | Update (empty-string credential clears it) |
| `POST` | `/admin/proxies/:id/enable` / `/disable` | Toggle availability |
| `DELETE` | `/admin/proxies/:id` | Remove (audit events survive, `proxy_id` NULLed) |
| `GET` | `/admin/proxies/:id/events` | Audit trail (created/updated/quarantined/released/…) |
| `GET` | `/admin/proxies/pool` | Pool snapshot (totals, statuses) |
| `GET`/`PUT` | `/admin/proxy-settings` | Pool settings (`egressMode`, `minHealthScore`, `probeIntervalSeconds`, `allowDirectFallback`) |

RBAC: full integration with the platform permission `proxy:manage` (roles OPERATOR+) lands with
the API milestone's JWT guard; today the surface is guarded by the admin bearer token.

### 5.1 Web console

`GET /admin` (on the API server, outside the guarded API base path) serves a static Persian/RTL
admin console — pool summary cards, the proxy table (status, health, counters, rest windows,
assignments) with enable/disable/remove actions, an add-proxy form, pool settings editor and a
per-proxy event (audit) viewer. The page embeds no data and no token: it prompts for
`ADMIN_API_TOKEN`, stores it client-side and calls the guarded endpoints with relative URLs.
Auto-refreshes every 10 s.

## 6. Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `EGRESS_MODE` | `OFF` | `OFF` / `OPTIONAL` / `REQUIRED` (fail-closed default: the pool is inert until an admin turns it on) |
| `PROXY_MIN_HEALTH_SCORE` | `0` | Proxies below this health are not leased |
| `PROXY_PROBE_INTERVAL_SECONDS` | `300` | Periodic probe cadence (60–3600) |
| `PROXY_LEASE_SECONDS` | `600` | Lease TTL (30–1800) |

## 7. Data model

- `proxies` — catalogue + live operational state (status, health, counters, quarantine window,
  assignment, rotation stamp, budget multiplier, probe schedule).
- `proxy_events` — append-only audit trail of admin and automatic decisions (no secrets).
- `proxy_health_samples` — append-only evidence behind health-score movements (probe + traffic).
- `system_settings['proxy_pool']` — pool-wide settings (fail-closed defaults).

## 8. Guarantees (tested)

- Credentials are envelope-encrypted at rest; plaintext never returned by reads, never logged,
  never written to `proxy_events`.
- A quarantined proxy is never leased; recovery requires a *successful probe after* the window.
- A 429 quarantines, frees the lease and tightens the budget — the requesting stops for that
  egress instead of hopping IPs.
- One proxy ↔ one live worker; assignments older than the max lease are reclaimable (crashed
  worker hygiene).
- Every admin/automatic decision is auditable via `proxy_events`.
- `egressMode=REQUIRED` fails closed when no healthy proxy exists.

See `packages/proxy/src/__tests__/*.spec.ts` (pure logic) and
`packages/proxy/test/proxy-pool.int.spec.ts` + `apps/{api,scheduler}/test/*.int.spec.ts`
(real-schema integration) for the executable specification.
