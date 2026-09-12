-- =============================================================================
-- 0001_init — full platform schema (docs/domain-model.md)
--
-- Conventions
--   * uuid primary keys (random ⇒ non-enumerable, TM-01)
--   * every tenant-owned table carries tenant_id NOT NULL and (where possible) a composite FK
--     to its parent as (id, tenant_id), so cross-tenant linkage is impossible at the DB level
--   * money is always bigint minor units + ISO-4217 currency (ADR-0006)
--   * timestamps are timestamptz (UTC); date-only travel dates are `date`
--   * enumerations are text + CHECK constraints (easy to evolve in migrations)
-- =============================================================================

-- ---------------------------------------------------------------- platform ---
CREATE TABLE plans (
  id             uuid PRIMARY KEY,
  code           text NOT NULL UNIQUE,
  name_en        text NOT NULL,
  name_fa        text NOT NULL,
  sort_order     int  NOT NULL DEFAULT 0,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plan_features (
  id          uuid PRIMARY KEY,
  plan_id     uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  feature_key text NOT NULL,
  enabled     boolean NOT NULL DEFAULT false,
  limit_value bigint,
  unit        text NOT NULL DEFAULT 'COUNT',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, feature_key, unit),
  CHECK (limit_value IS NULL OR limit_value >= 0)
);

CREATE TABLE plan_prices (
  id           uuid PRIMARY KEY,
  plan_id      uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  currency     char(3) NOT NULL,
  interval     text NOT NULL CHECK (interval IN ('MONTHLY','QUARTERLY','YEARLY')),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, currency, interval)
);

CREATE TABLE feature_flags (
  key             text PRIMARY KEY,
  description     text NOT NULL DEFAULT '',
  default_enabled boolean NOT NULL DEFAULT false,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE feature_flag_overrides (
  id         uuid PRIMARY KEY,
  flag_key   text NOT NULL REFERENCES feature_flags(key) ON DELETE CASCADE,
  scope_type text NOT NULL CHECK (scope_type IN ('PLAN','TENANT','USER')),
  scope_id   uuid NOT NULL,
  enabled    boolean NOT NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (flag_key, scope_type, scope_id)
);

CREATE TABLE system_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  description text NOT NULL DEFAULT '',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid
);

CREATE TABLE providers (
  code              text PRIMARY KEY,
  name_en           text NOT NULL,
  name_fa           text NOT NULL,
  adapter_key       text NOT NULL,
  transport         text NOT NULL CHECK (transport IN ('HTTP_JSON','BROWSER','HYBRID')),
  enabled           boolean NOT NULL DEFAULT false,
  compliance_status text NOT NULL CHECK (compliance_status IN ('APPROVED','NOT_REVIEWED','PROHIBITED')),
  compliance_notes  text NOT NULL DEFAULT '',
  compliance_evidence_url text,
  capabilities      jsonb NOT NULL DEFAULT '{}'::jsonb,
  base_url          text,
  timezone          text NOT NULL DEFAULT 'Asia/Tehran',
  rate_limit        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE provider_stations (
  id            uuid PRIMARY KEY,
  provider_code text NOT NULL REFERENCES providers(code) ON DELETE CASCADE,
  code          text NOT NULL,
  name_fa       text NOT NULL,
  name_en       text NOT NULL,
  city_fa       text NOT NULL DEFAULT '',
  city_en       text NOT NULL DEFAULT '',
  aliases       text[] NOT NULL DEFAULT '{}',
  is_active     boolean NOT NULL DEFAULT true,
  synced_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_code, code)
);

CREATE TABLE provider_routes (
  id                    uuid PRIMARY KEY,
  provider_code         text NOT NULL REFERENCES providers(code) ON DELETE CASCADE,
  origin_station_id     uuid NOT NULL REFERENCES provider_stations(id) ON DELETE CASCADE,
  destination_station_id uuid NOT NULL REFERENCES provider_stations(id) ON DELETE CASCADE,
  is_active             boolean NOT NULL DEFAULT true,
  last_seen_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_code, origin_station_id, destination_station_id),
  CHECK (origin_station_id <> destination_station_id)
);

CREATE TABLE proxies (
  id                uuid PRIMARY KEY,
  label             text NOT NULL,
  protocol          text NOT NULL CHECK (protocol IN ('HTTP','HTTPS','SOCKS5')),
  host              text NOT NULL,
  port              int  NOT NULL CHECK (port BETWEEN 1 AND 65535),
  username_enc      bytea,
  password_enc      bytea,
  provider_code     text REFERENCES providers(code) ON DELETE SET NULL,
  region            text NOT NULL DEFAULT '',
  enabled           boolean NOT NULL DEFAULT true,
  health_score      int NOT NULL DEFAULT 100 CHECK (health_score BETWEEN 0 AND 100),
  latency_ms        int,
  success_count     bigint NOT NULL DEFAULT 0,
  failure_count     bigint NOT NULL DEFAULT 0,
  last_success_at   timestamptz,
  last_failure_at   timestamptz,
  quarantined_until timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (host, port, protocol)
);

CREATE TABLE maintenance_modes (
  id         uuid PRIMARY KEY,
  scope      text NOT NULL CHECK (scope IN ('GLOBAL','PROVIDER','BOOKING','MONITORING')),
  scope_ref  text,
  mode       text NOT NULL CHECK (mode IN ('NONE','MONITORING_ONLY','BOOKING_DISABLED','PROVIDER','FULL')),
  reason     text NOT NULL DEFAULT '',
  enabled_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  enabled_by uuid
);

-- ---------------------------------------------------------------- tenancy ----
CREATE TABLE tenants (
  id         uuid PRIMARY KEY,
  slug       text NOT NULL UNIQUE,
  name       text NOT NULL,
  status     text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','DELETED')),
  timezone   text NOT NULL DEFAULT 'Asia/Tehran',
  locale     text NOT NULL DEFAULT 'fa' CHECK (locale IN ('fa','en')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email             text NOT NULL,
  password_hash     text,
  role              text NOT NULL DEFAULT 'USER' CHECK (role IN ('USER','SUPPORT','OPERATOR','FINANCE_ADMIN','ADMIN','SUPER_ADMIN')),
  status            text NOT NULL DEFAULT 'PENDING_VERIFICATION' CHECK (status IN ('ACTIVE','SUSPENDED','PENDING_VERIFICATION','DELETION_PENDING','DELETED')),
  full_name         text NOT NULL DEFAULT '',
  locale            text NOT NULL DEFAULT 'fa' CHECK (locale IN ('fa','en')),
  timezone          text NOT NULL DEFAULT 'Asia/Tehran',
  phone_enc         bytea,
  phone_hash        text,
  email_verified_at timestamptz,
  last_login_at     timestamptz,
  failed_login_count int NOT NULL DEFAULT 0,
  locked_until      timestamptz,
  suspended_reason  text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

CREATE UNIQUE INDEX users_email_global_uq ON users (lower(email));
CREATE INDEX users_phone_hash_idx ON users (phone_hash) WHERE phone_hash IS NOT NULL;
CREATE INDEX users_tenant_status_idx ON users (tenant_id, status);

CREATE TABLE user_permission_grants (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission text NOT NULL,
  granted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  PRIMARY KEY (user_id, permission)
);

CREATE TABLE sessions (
  id                 uuid PRIMARY KEY,
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  refresh_token_hash text NOT NULL UNIQUE,
  family_id          uuid NOT NULL,
  user_agent_hash    text NOT NULL DEFAULT '',
  ip_hash            text NOT NULL DEFAULT '',
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_used_at       timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz,
  revoked_reason     text,
  replaced_by        uuid
);

CREATE INDEX sessions_user_idx ON sessions (user_id, revoked_at);
CREATE INDEX sessions_family_idx ON sessions (family_id);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at) WHERE revoked_at IS NULL;

CREATE TABLE user_settings (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        text NOT NULL,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

CREATE TABLE notification_preferences (
  user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel  text NOT NULL CHECK (channel IN ('telegram','web','email','sms','push')),
  category text NOT NULL CHECK (category IN ('availability','price','booking','billing','security','system','support')),
  enabled  boolean NOT NULL DEFAULT true,
  PRIMARY KEY (user_id, channel, category)
);

CREATE TABLE telegram_links (
  id               uuid PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  telegram_user_id bigint NOT NULL,
  telegram_username text NOT NULL DEFAULT '',
  linked_at        timestamptz NOT NULL DEFAULT now(),
  revoked_at       timestamptz
);

CREATE UNIQUE INDEX telegram_links_active_uq ON telegram_links (telegram_user_id) WHERE revoked_at IS NULL;
CREATE INDEX telegram_links_user_idx ON telegram_links (user_id) WHERE revoked_at IS NULL;

CREATE TABLE telegram_link_challenges (
  id               uuid PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code_hash        text NOT NULL UNIQUE,
  expires_at       timestamptz NOT NULL,
  consumed_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE passengers (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  first_name       text NOT NULL,
  last_name        text NOT NULL,
  national_id_enc  bytea,
  national_id_hash text,
  passport_enc     bytea,
  birth_date       date,
  gender           text CHECK (gender IN ('MALE','FEMALE','ANY')),
  nationality      text NOT NULL DEFAULT 'IR',
  phone_enc        bytea,
  email_enc        bytea,
  category         text NOT NULL DEFAULT 'ADULT' CHECK (category IN ('ADULT','CHILD','INFANT','SENIOR','STUDENT')),
  discount_code    text,
  loyalty_enc      bytea,
  notes            text NOT NULL DEFAULT '',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);

CREATE INDEX passengers_tenant_user_idx ON passengers (tenant_id, user_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX passengers_national_id_uq ON passengers (tenant_id, user_id, national_id_hash)
  WHERE national_id_hash IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE consent_records (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  booking_request_id uuid,
  type               text NOT NULL,
  version            text NOT NULL,
  granted_at         timestamptz NOT NULL DEFAULT now(),
  payload_hash       text NOT NULL,
  ip_hash            text NOT NULL DEFAULT ''
);

CREATE INDEX consent_records_booking_idx ON consent_records (booking_request_id) WHERE booking_request_id IS NOT NULL;

-- ----------------------------------------------------- provider accounts ----
CREATE TABLE provider_accounts (
  id                    uuid PRIMARY KEY,
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider_code         text NOT NULL REFERENCES providers(code) ON DELETE CASCADE,
  label                 text NOT NULL DEFAULT '',
  username_enc          bytea NOT NULL,
  username_hash         text NOT NULL,
  password_enc          bytea,
  status                text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','COOLDOWN','QUARANTINED','DISABLED')),
  assignment_strategy   text NOT NULL DEFAULT 'STICKY_PER_USER'
                          CHECK (assignment_strategy IN ('ROUND_ROBIN','LEAST_RECENTLY_USED','STICKY_PER_USER','DEDICATED')),
  health_score          int NOT NULL DEFAULT 100 CHECK (health_score BETWEEN 0 AND 100),
  last_login_at         timestamptz,
  last_success_at       timestamptz,
  last_failure_at       timestamptz,
  consecutive_failures  int NOT NULL DEFAULT 0,
  cooldown_until        timestamptz,
  session_expires_at    timestamptz,
  created_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider_code, username_hash)
);

CREATE TABLE provider_sessions (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider_account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
  provider_code       text NOT NULL REFERENCES providers(code) ON DELETE CASCADE,
  state_enc           bytea NOT NULL,
  status              text NOT NULL DEFAULT 'VALID' CHECK (status IN ('VALID','EXPIRED','INVALIDATED')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz,
  last_validated_at   timestamptz,
  invalidated_reason  text
);

CREATE INDEX provider_sessions_account_idx ON provider_sessions (provider_account_id, status);
CREATE INDEX provider_sessions_expiry_idx ON provider_sessions (expires_at) WHERE status = 'VALID';

CREATE TABLE provider_account_assignments (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  booking_request_id  uuid NOT NULL,
  provider_account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
  assigned_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (booking_request_id, provider_account_id)
);

-- ---------------------------------------------------------------- booking ---
CREATE TABLE release_windows (
  id                             uuid PRIMARY KEY,
  provider_code                  text NOT NULL REFERENCES providers(code) ON DELETE CASCADE,
  label                          text NOT NULL,
  expected_release_at            timestamptz NOT NULL,
  warmup_minutes_before          int NOT NULL DEFAULT 40 CHECK (warmup_minutes_before BETWEEN 0 AND 240),
  search_start_offset_ms         int NOT NULL DEFAULT -10000 CHECK (search_start_offset_ms BETWEEN -60000 AND 0),
  burst_duration_seconds         int NOT NULL DEFAULT 120 CHECK (burst_duration_seconds BETWEEN 0 AND 3600),
  burst_interval_seconds         int NOT NULL DEFAULT 3 CHECK (burst_interval_seconds >= 20 OR burst_interval_seconds <= 0),
  normal_interval_seconds        int NOT NULL DEFAULT 60 CHECK (normal_interval_seconds >= 20),
  capacity_max_jobs              int NOT NULL DEFAULT 400 CHECK (capacity_max_jobs BETWEEN 1 AND 100000),
  max_burst_requests_per_minute  int NOT NULL DEFAULT 40 CHECK (max_burst_requests_per_minute BETWEEN 1 AND 600),
  status                         text NOT NULL DEFAULT 'PLANNED'
                                   CHECK (status IN ('PLANNED','PREPARING','ACTIVE','DEGRADED','COMPLETED','CANCELED')),
  notes                          text NOT NULL DEFAULT '',
  created_by                     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at                     timestamptz NOT NULL DEFAULT now(),
  updated_at                     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX release_windows_status_idx ON release_windows (status, expected_release_at)
  WHERE status IN ('PLANNED','PREPARING','ACTIVE');

CREATE TABLE booking_requests (
  id                       uuid PRIMARY KEY,
  tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id                  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status                   text NOT NULL DEFAULT 'CREATED',
  automation_mode          text NOT NULL DEFAULT 'MONITOR_ONLY'
                             CHECK (automation_mode IN ('MONITOR_ONLY','AUTO_FILL','AUTO_HOLD','AUTHORIZED_AUTO_BOOKING')),
  matching_mode            text NOT NULL DEFAULT 'FLEXIBLE' CHECK (matching_mode IN ('STRICT','FLEXIBLE')),
  monitoring_strategy      text NOT NULL DEFAULT 'JITTERED'
                             CHECK (monitoring_strategy IN ('FIXED','JITTERED','PRIORITY_BASED','EXPONENTIAL_BACKOFF','RELEASE_TIME','ADAPTIVE')),
  provider_code            text NOT NULL REFERENCES providers(code),
  provider_account_id      uuid REFERENCES provider_accounts(id) ON DELETE SET NULL,
  origin_code              text NOT NULL,
  origin_name_fa           text NOT NULL DEFAULT '',
  origin_name_en           text NOT NULL DEFAULT '',
  destination_code         text NOT NULL,
  destination_name_fa      text NOT NULL DEFAULT '',
  destination_name_en      text NOT NULL DEFAULT '',
  departure_date           date NOT NULL,
  departure_date_end       date,
  return_enabled           boolean NOT NULL DEFAULT false,
  return_date              date,
  return_date_end          date,
  preferred_departure_from time,
  preferred_departure_to   time,
  preferred_arrival_from   time,
  preferred_arrival_to     time,
  passenger_count          int NOT NULL CHECK (passenger_count BETWEEN 1 AND 10),
  coach_class              text NOT NULL DEFAULT 'ANY',
  seat_preference          text NOT NULL DEFAULT 'ANY',
  train_preference         jsonb NOT NULL DEFAULT '{}'::jsonb,
  max_price_minor          bigint CHECK (max_price_minor IS NULL OR max_price_minor >= 0),
  currency                 char(3) NOT NULL DEFAULT 'IRR',
  min_availability         int NOT NULL DEFAULT 1 CHECK (min_availability >= 1),
  allow_split_booking      boolean NOT NULL DEFAULT false,
  priority                 int NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  cancel_lower_priorities  boolean NOT NULL DEFAULT true,
  release_window_id        uuid REFERENCES release_windows(id) ON DELETE SET NULL,
  deadline_at              timestamptz,
  poll_interval_seconds    int CHECK (poll_interval_seconds IS NULL OR poll_interval_seconds >= 20),
  idempotency_key          text UNIQUE,
  lock_token               bigint,
  locked_at                timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  started_at               timestamptz,
  completed_at             timestamptz,
  canceled_at              timestamptz,
  cancel_reason            text,
  CHECK (departure_date_end IS NULL OR departure_date_end >= departure_date),
  CHECK (return_date IS NULL OR return_date >= departure_date),
  CHECK (return_date_end IS NULL OR return_date IS NULL OR return_date_end >= return_date)
);

CREATE INDEX booking_requests_user_idx ON booking_requests (tenant_id, user_id, created_at DESC);
CREATE INDEX booking_requests_status_idx ON booking_requests (tenant_id, status, created_at DESC);
CREATE INDEX booking_requests_active_idx ON booking_requests (status)
  WHERE status IN ('SCHEDULED','QUEUED','SEARCHING','WAITING','AVAILABLE','LOCKED','RESERVING',
                   'HUMAN_VERIFICATION_REQUIRED','PASSENGER_FORM','READY_FOR_CHECKOUT','AWAITING_USER_APPROVAL');

CREATE TABLE booking_passengers (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  booking_request_id uuid NOT NULL REFERENCES booking_requests(id) ON DELETE CASCADE,
  passenger_id       uuid NOT NULL REFERENCES passengers(id) ON DELETE RESTRICT,
  ordinal            int NOT NULL CHECK (ordinal >= 0),
  UNIQUE (booking_request_id, passenger_id),
  UNIQUE (booking_request_id, ordinal)
);

CREATE TABLE booking_monitors (
  id                   uuid PRIMARY KEY,
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  booking_request_id   uuid NOT NULL REFERENCES booking_requests(id) ON DELETE CASCADE,
  leg                  text NOT NULL CHECK (leg IN ('OUTBOUND','RETURN')),
  travel_date          date NOT NULL,
  priority             int NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  status               text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED','SATISFIED','CANCELED','EXPIRED')),
  strategy             text NOT NULL DEFAULT 'JITTERED',
  interval_seconds     int NOT NULL DEFAULT 60 CHECK (interval_seconds >= 20),
  next_search_at       timestamptz NOT NULL DEFAULT now(),
  last_search_at       timestamptz,
  failure_count        int NOT NULL DEFAULT 0,
  consecutive_failures int NOT NULL DEFAULT 0,
  backoff_until        timestamptz,
  matched_result_id    uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (booking_request_id, leg, travel_date)
);

CREATE INDEX booking_monitors_due_idx ON booking_monitors (status, next_search_at) WHERE status = 'ACTIVE';
CREATE INDEX booking_monitors_tenant_idx ON booking_monitors (tenant_id, status);
CREATE INDEX booking_monitors_backoff_idx ON booking_monitors (backoff_until) WHERE backoff_until IS NOT NULL;

CREATE TABLE booking_attempts (
  id                      uuid PRIMARY KEY,
  tenant_id               uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  booking_request_id      uuid NOT NULL REFERENCES booking_requests(id) ON DELETE CASCADE,
  monitor_id              uuid REFERENCES booking_monitors(id) ON DELETE SET NULL,
  attempt_seq             int NOT NULL CHECK (attempt_seq >= 1),
  state                   text NOT NULL,
  phase                   text NOT NULL DEFAULT 'SEARCH',
  search_started_at       timestamptz,
  search_finished_at      timestamptz,
  results_count           int NOT NULL DEFAULT 0,
  matched_fingerprint     text,
  failure_class           text,
  error_sanitized         text,
  lease_owner             text,
  lease_expires_at        timestamptz,
  provider_reservation_ref text,
  provider_account_id     uuid REFERENCES provider_accounts(id) ON DELETE SET NULL,
  proxy_id                uuid REFERENCES proxies(id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (booking_request_id, attempt_seq)
);

CREATE INDEX booking_attempts_recovery_idx ON booking_attempts (state, lease_expires_at)
  WHERE state IN ('LOCKED','RESERVING','HUMAN_VERIFICATION_REQUIRED','PASSENGER_FORM','READY_FOR_CHECKOUT','AWAITING_USER_APPROVAL');
CREATE INDEX booking_attempts_tenant_idx ON booking_attempts (tenant_id, created_at DESC);

CREATE TABLE booking_results (
  id                        uuid PRIMARY KEY,
  tenant_id                 uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  booking_request_id        uuid NOT NULL REFERENCES booking_requests(id) ON DELETE CASCADE,
  attempt_id                uuid REFERENCES booking_attempts(id) ON DELETE SET NULL,
  provider_code             text NOT NULL,
  provider_trip_id          text NOT NULL DEFAULT '',
  train_number              text NOT NULL DEFAULT '',
  train_name                text NOT NULL DEFAULT '',
  origin_code               text NOT NULL DEFAULT '',
  destination_code          text NOT NULL DEFAULT '',
  departure_at              timestamptz NOT NULL,
  arrival_at                timestamptz,
  duration_minutes          int,
  coach_class               text NOT NULL DEFAULT 'ANY',
  coach_label               text NOT NULL DEFAULT '',
  price_minor               bigint CHECK (price_minor IS NULL OR price_minor >= 0),
  currency                  char(3) NOT NULL DEFAULT 'IRR',
  seats_available           int NOT NULL DEFAULT 0,
  seat_labels               jsonb NOT NULL DEFAULT '[]'::jsonb,
  availability_fingerprint  text NOT NULL,
  score                     numeric(6,3) NOT NULL DEFAULT 0,
  score_breakdown           jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_selected               boolean NOT NULL DEFAULT false,
  created_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (booking_request_id, availability_fingerprint)
);

CREATE INDEX booking_results_score_idx ON booking_results (booking_request_id, score DESC);

CREATE TABLE availability_observations (
  id               bigserial PRIMARY KEY,
  tenant_id        uuid REFERENCES tenants(id) ON DELETE CASCADE,
  provider_code    text NOT NULL,
  origin_code      text NOT NULL,
  destination_code text NOT NULL,
  travel_date      date NOT NULL,
  train_number     text NOT NULL DEFAULT '',
  coach_class      text NOT NULL DEFAULT 'ANY',
  price_minor      bigint,
  currency         char(3) NOT NULL DEFAULT 'IRR',
  seats_available  int NOT NULL DEFAULT 0,
  observed_at      timestamptz NOT NULL DEFAULT now(),
  fingerprint      text NOT NULL,
  source           text NOT NULL DEFAULT 'SEARCH' CHECK (source IN ('SEARCH','BURST_VALIDATION','SYNC'))
);

CREATE INDEX availability_observations_route_idx
  ON availability_observations (provider_code, origin_code, destination_code, travel_date, observed_at DESC);
CREATE INDEX availability_observations_retention_idx ON availability_observations (observed_at);

CREATE TABLE booking_timeline_events (
  id                 bigserial PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  booking_request_id uuid NOT NULL REFERENCES booking_requests(id) ON DELETE CASCADE,
  at                 timestamptz NOT NULL DEFAULT now(),
  phase              text NOT NULL,
  event_type         text NOT NULL,
  message_key        text NOT NULL,
  message_params     jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_type         text NOT NULL DEFAULT 'SYSTEM' CHECK (actor_type IN ('SYSTEM','USER','ADMIN','PROVIDER')),
  actor_id           uuid,
  state_from         text,
  state_to           text,
  correlation_id     text NOT NULL DEFAULT ''
);

CREATE INDEX booking_timeline_booking_idx ON booking_timeline_events (booking_request_id, at);

CREATE TABLE booking_transitions (
  id                 bigserial PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  booking_request_id uuid NOT NULL REFERENCES booking_requests(id) ON DELETE CASCADE,
  from_state         text NOT NULL,
  to_state           text NOT NULL,
  reason             text NOT NULL DEFAULT '',
  actor_type         text NOT NULL DEFAULT 'SYSTEM' CHECK (actor_type IN ('SYSTEM','USER','ADMIN','PROVIDER')),
  actor_id           uuid,
  at                 timestamptz NOT NULL DEFAULT now(),
  correlation_id     text NOT NULL DEFAULT ''
);

CREATE INDEX booking_transitions_booking_idx ON booking_transitions (booking_request_id, at);

CREATE TABLE reservations (
  id                      uuid PRIMARY KEY,
  tenant_id               uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  booking_request_id      uuid NOT NULL REFERENCES booking_requests(id) ON DELETE CASCADE,
  provider_code           text NOT NULL,
  provider_account_id     uuid REFERENCES provider_accounts(id) ON DELETE SET NULL,
  provider_reservation_ref text,
  status                  text NOT NULL DEFAULT 'PENDING'
                            CHECK (status IN ('PENDING','HOLD','RESERVED','BOOKED','EXPIRED','CANCELED','FAILED')),
  hold_expires_at         timestamptz,
  total_price_minor       bigint,
  currency                char(3) NOT NULL DEFAULT 'IRR',
  payload_digest          text NOT NULL DEFAULT '',
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- A booking may hold at most one live reservation; a provider reference may never repeat.
CREATE UNIQUE INDEX reservations_live_uq ON reservations (booking_request_id)
  WHERE status IN ('PENDING','HOLD','RESERVED','BOOKED');
CREATE UNIQUE INDEX reservations_provider_ref_uq ON reservations (provider_code, provider_reservation_ref)
  WHERE provider_reservation_ref IS NOT NULL;

CREATE TABLE search_jobs (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  booking_request_id uuid REFERENCES booking_requests(id) ON DELETE CASCADE,
  booking_monitor_id uuid REFERENCES booking_monitors(id) ON DELETE SET NULL,
  provider_code      text NOT NULL,
  scheduled_at       timestamptz NOT NULL DEFAULT now(),
  started_at         timestamptz,
  finished_at        timestamptz,
  status             text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RUNNING','SUCCEEDED','FAILED','SKIPPED')),
  attempt            int NOT NULL DEFAULT 1,
  duration_ms        int,
  results_count      int NOT NULL DEFAULT 0,
  failure_class      text,
  worker_id          text,
  cost_units         int NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX search_jobs_status_idx ON search_jobs (status, scheduled_at);
CREATE INDEX search_jobs_provider_idx ON search_jobs (provider_code, scheduled_at DESC);
CREATE INDEX search_jobs_tenant_idx ON search_jobs (tenant_id, scheduled_at DESC);

-- ----------------------------------------------------------------- money ----
CREATE TABLE wallets (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  currency      char(3) NOT NULL DEFAULT 'IRR',
  balance_minor bigint NOT NULL DEFAULT 0 CHECK (balance_minor >= 0),
  credit_minor  bigint NOT NULL DEFAULT 0 CHECK (credit_minor >= 0),
  version       bigint NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, currency)
);

CREATE TABLE wallet_transactions (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_id           uuid NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
  type                text NOT NULL CHECK (type IN ('DEPOSIT','REFUND','SERVICE_CHARGE','BOOKING_CHARGE','BONUS','PROMO','ADMIN_ADJUSTMENT','CHARGE_HOLD','CHARGE_RELEASE','REVERSAL')),
  status              text NOT NULL DEFAULT 'POSTED' CHECK (status IN ('PENDING','POSTED','RELEASED','REVERSED')),
  amount_minor        bigint NOT NULL CHECK (amount_minor <> 0),
  currency            char(3) NOT NULL,
  balance_after_minor bigint,
  reference_type      text NOT NULL DEFAULT '',
  reference_id        uuid,
  idempotency_key     text NOT NULL UNIQUE,
  description_key     text NOT NULL DEFAULT '',
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  reversal_of         uuid REFERENCES wallet_transactions(id),
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX wallet_transactions_wallet_idx ON wallet_transactions (wallet_id, created_at DESC);
CREATE INDEX wallet_transactions_user_idx ON wallet_transactions (tenant_id, user_id, created_at DESC);
CREATE INDEX wallet_transactions_reference_idx ON wallet_transactions (reference_type, reference_id);

CREATE TABLE credits (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_minor    bigint NOT NULL CHECK (amount_minor > 0),
  remaining_minor bigint NOT NULL CHECK (remaining_minor >= 0),
  currency        char(3) NOT NULL DEFAULT 'IRR',
  source          text NOT NULL DEFAULT 'PROMO',
  expires_at      timestamptz,
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CONSUMED','EXPIRED','REVOKED')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (remaining_minor <= amount_minor)
);

CREATE INDEX credits_active_idx ON credits (user_id, expires_at) WHERE status = 'ACTIVE';

CREATE TABLE credit_consumptions (
  id                    uuid PRIMARY KEY,
  credit_id             uuid NOT NULL REFERENCES credits(id) ON DELETE RESTRICT,
  wallet_transaction_id uuid NOT NULL REFERENCES wallet_transactions(id) ON DELETE RESTRICT,
  amount_minor          bigint NOT NULL CHECK (amount_minor > 0),
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (credit_id, wallet_transaction_id)
);

CREATE TABLE charge_authorizations (
  id                    uuid PRIMARY KEY,
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  booking_request_id    uuid NOT NULL REFERENCES booking_requests(id) ON DELETE CASCADE,
  booking_attempt_id    uuid REFERENCES booking_attempts(id) ON DELETE CASCADE,
  purpose               text NOT NULL,
  amount_minor          bigint NOT NULL CHECK (amount_minor > 0),
  currency              char(3) NOT NULL DEFAULT 'IRR',
  status                text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SETTLED','RELEASED','EXPIRED')),
  ledger_transaction_id uuid REFERENCES wallet_transactions(id),
  idempotency_key       text NOT NULL UNIQUE,
  expires_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  settled_at            timestamptz,
  released_at           timestamptz
);

CREATE UNIQUE INDEX charge_authorizations_live_uq ON charge_authorizations (booking_attempt_id, purpose)
  WHERE status = 'PENDING';

CREATE TABLE invoices (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invoice_number text NOT NULL UNIQUE,
  kind           text NOT NULL DEFAULT 'WALLET_TOPUP' CHECK (kind IN ('SUBSCRIPTION','WALLET_TOPUP','BOOKING_CHARGE','ADJUSTMENT')),
  currency       char(3) NOT NULL,
  subtotal_minor bigint NOT NULL DEFAULT 0 CHECK (subtotal_minor >= 0),
  discount_minor bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  tax_minor      bigint NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  total_minor    bigint NOT NULL CHECK (total_minor >= 0),
  status         text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ISSUED','PAID','VOID','REFUNDED')),
  subscription_id uuid,
  issued_at      timestamptz,
  due_at         timestamptz,
  paid_at        timestamptz,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (subtotal_minor - discount_minor + tax_minor = total_minor)
);

CREATE INDEX invoices_tenant_idx ON invoices (tenant_id, created_at DESC);
CREATE INDEX invoices_status_idx ON invoices (status, created_at DESC);

CREATE TABLE invoice_lines (
  id                uuid PRIMARY KEY,
  invoice_id        uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  line_no           int NOT NULL CHECK (line_no >= 1),
  description_key   text NOT NULL,
  quantity          numeric(10,2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_amount_minor bigint NOT NULL,
  amount_minor      bigint NOT NULL,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (invoice_id, line_no)
);

CREATE TABLE payments (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invoice_id     uuid REFERENCES invoices(id) ON DELETE SET NULL,
  provider_code  text NOT NULL DEFAULT 'test',
  external_id    text,
  amount_minor   bigint NOT NULL CHECK (amount_minor > 0),
  currency       char(3) NOT NULL,
  status         text NOT NULL DEFAULT 'CREATED'
                   CHECK (status IN ('CREATED','PENDING','PAID','FAILED','EXPIRED','REFUNDED','PARTIALLY_REFUNDED')),
  method         text NOT NULL DEFAULT 'gateway',
  idempotency_key text NOT NULL UNIQUE,
  failure_reason text,
  refunded_minor bigint NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  paid_at        timestamptz
);

CREATE UNIQUE INDEX payments_provider_external_uq ON payments (provider_code, external_id)
  WHERE external_id IS NOT NULL;
CREATE INDEX payments_invoice_idx ON payments (invoice_id);

CREATE TABLE payment_events (
  id                 uuid PRIMARY KEY,
  payment_id         uuid REFERENCES payments(id) ON DELETE CASCADE,
  provider_code      text NOT NULL,
  external_event_id  text NOT NULL,
  event_type         text NOT NULL,
  payload_digest     text NOT NULL DEFAULT '',
  signature_verified boolean NOT NULL DEFAULT false,
  received_at        timestamptz NOT NULL DEFAULT now(),
  processed_at       timestamptz,
  UNIQUE (provider_code, external_event_id)
);

CREATE TABLE subscriptions (
  id                   uuid PRIMARY KEY,
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id              uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id              uuid NOT NULL REFERENCES plans(id),
  status               text NOT NULL DEFAULT 'TRIALING' CHECK (status IN ('TRIALING','ACTIVE','PAST_DUE','CANCELED','EXPIRED')),
  current_period_start timestamptz NOT NULL DEFAULT now(),
  current_period_end   timestamptz NOT NULL,
  trial_end            timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  started_at           timestamptz NOT NULL DEFAULT now(),
  ended_at             timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (current_period_end > current_period_start)
);

CREATE UNIQUE INDEX subscriptions_active_uq ON subscriptions (user_id)
  WHERE status IN ('TRIALING','ACTIVE','PAST_DUE');
CREATE INDEX subscriptions_expiry_idx ON subscriptions (status, current_period_end);

CREATE TABLE quota_counters (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id uuid REFERENCES subscriptions(id) ON DELETE SET NULL,
  meter_key      text NOT NULL,
  period_start   timestamptz NOT NULL,
  period_end     timestamptz NOT NULL,
  used           bigint NOT NULL DEFAULT 0 CHECK (used >= 0),
  limit_value    bigint,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, meter_key, period_start)
);

CREATE TABLE coupons (
  id                   uuid PRIMARY KEY,
  code                 text NOT NULL UNIQUE,
  type                 text NOT NULL CHECK (type IN ('PERCENT','FIXED','WALLET_BONUS','FREE_DAYS','FEATURE_UNLOCK')),
  percent_bp           int CHECK (percent_bp IS NULL OR (percent_bp > 0 AND percent_bp <= 10000)),
  value_minor          bigint CHECK (value_minor IS NULL OR value_minor > 0),
  currency             char(3) NOT NULL DEFAULT 'IRR',
  feature_key          text,
  feature_days         int CHECK (feature_days IS NULL OR feature_days > 0),
  starts_at            timestamptz,
  ends_at              timestamptz,
  max_uses             int CHECK (max_uses IS NULL OR max_uses > 0),
  max_uses_per_user    int NOT NULL DEFAULT 1 CHECK (max_uses_per_user > 0),
  eligible_plan_codes  text[] NOT NULL DEFAULT '{}',
  min_purchase_minor   bigint CHECK (min_purchase_minor IS NULL OR min_purchase_minor >= 0),
  is_active            boolean NOT NULL DEFAULT true,
  created_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE coupon_redemptions (
  id          uuid PRIMARY KEY,
  coupon_id   uuid NOT NULL REFERENCES coupons(id) ON DELETE RESTRICT,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invoice_id  uuid REFERENCES invoices(id) ON DELETE SET NULL,
  amount_minor bigint NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX coupon_redemptions_coupon_idx ON coupon_redemptions (coupon_id, user_id);

CREATE TABLE referral_codes (
  id         uuid PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code       text NOT NULL UNIQUE,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE referrals (
  id                 uuid PRIMARY KEY,
  referrer_user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referred_user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  code               text NOT NULL,
  status             text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','QUALIFIED','REWARDED','REJECTED')),
  qualified_at       timestamptz,
  rewarded_at        timestamptz,
  reward_type        text,
  reward_value_minor bigint,
  reward_currency    char(3),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (referrer_user_id <> referred_user_id)
);

-- ------------------------------------------------------------ operations ----
CREATE TABLE notifications (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type         text NOT NULL,
  category           text NOT NULL CHECK (category IN ('availability','price','booking','billing','security','system','support')),
  title_key          text NOT NULL,
  body_key           text NOT NULL,
  params             jsonb NOT NULL DEFAULT '{}'::jsonb,
  channels           text[] NOT NULL DEFAULT '{}',
  status             text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','PARTIAL','FAILED','READ')),
  dedup_key          text NOT NULL UNIQUE,
  booking_request_id uuid REFERENCES booking_requests(id) ON DELETE SET NULL,
  failure_reason     text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  sent_at            timestamptz,
  read_at            timestamptz
);

CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

CREATE TABLE notification_deliveries (
  id                  uuid PRIMARY KEY,
  notification_id     uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  channel             text NOT NULL CHECK (channel IN ('telegram','web','email','sms','push')),
  status              text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','FAILED','SKIPPED')),
  attempts            int NOT NULL DEFAULT 0,
  last_error          text,
  provider_message_id text,
  sent_at             timestamptz,
  UNIQUE (notification_id, channel)
);

CREATE TABLE release_window_admissions (
  id                 uuid PRIMARY KEY,
  release_window_id  uuid NOT NULL REFERENCES release_windows(id) ON DELETE CASCADE,
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  booking_request_id uuid NOT NULL REFERENCES booking_requests(id) ON DELETE CASCADE,
  status             text NOT NULL DEFAULT 'WAITING_ROOM' CHECK (status IN ('WAITING_ROOM','ADMITTED','REJECTED','COMPLETED')),
  position           int,
  reason             text NOT NULL DEFAULT '',
  admitted_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (release_window_id, booking_request_id)
);

CREATE INDEX release_window_admissions_queue_idx ON release_window_admissions (release_window_id, status, position);

CREATE TABLE capacity_leases (
  id                uuid PRIMARY KEY,
  release_window_id uuid NOT NULL REFERENCES release_windows(id) ON DELETE CASCADE,
  slot_key          text NOT NULL,
  kind              text NOT NULL DEFAULT 'BROWSER' CHECK (kind IN ('BROWSER','WORKER','HTTP')),
  leased_until      timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (release_window_id, slot_key)
);

CREATE TABLE circuit_breaker_states (
  provider_code  text NOT NULL,
  scope_key      text NOT NULL,
  state          text NOT NULL DEFAULT 'CLOSED' CHECK (state IN ('CLOSED','OPEN','HALF_OPEN')),
  failure_count  int NOT NULL DEFAULT 0,
  sample_count   int NOT NULL DEFAULT 0,
  opened_at      timestamptz,
  next_probe_at  timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_code, scope_key)
);

CREATE TABLE provider_health_samples (
  id            bigserial PRIMARY KEY,
  provider_code text NOT NULL,
  sampled_at    timestamptz NOT NULL DEFAULT now(),
  latency_ms    int,
  success       boolean NOT NULL,
  failure_class text,
  source        text NOT NULL DEFAULT 'SEARCH'
);

CREATE INDEX provider_health_samples_idx ON provider_health_samples (provider_code, sampled_at DESC);

CREATE TABLE support_tickets (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject     text NOT NULL,
  category    text NOT NULL CHECK (category IN ('billing','booking','technical','provider')),
  status      text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','PENDING','RESOLVED','CLOSED')),
  priority    int NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  assigned_to uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz
);

CREATE INDEX support_tickets_status_idx ON support_tickets (status, created_at DESC);
CREATE INDEX support_tickets_tenant_idx ON support_tickets (tenant_id, status);

CREATE TABLE support_messages (
  id              uuid PRIMARY KEY,
  ticket_id       uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  author_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  author_role     text NOT NULL DEFAULT 'USER',
  body            text NOT NULL,
  is_internal_note boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX support_messages_ticket_idx ON support_messages (ticket_id, created_at);

CREATE TABLE audit_events (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid REFERENCES tenants(id) ON DELETE SET NULL,
  actor_type      text NOT NULL DEFAULT 'SYSTEM' CHECK (actor_type IN ('SYSTEM','USER','ADMIN','PROVIDER','SUPPORT')),
  actor_user_id   uuid,
  action          text NOT NULL,
  target_type     text NOT NULL DEFAULT '',
  target_id       text NOT NULL DEFAULT '',
  before_digest   text,
  after_digest    text,
  ip_hash         text,
  user_agent_hash text,
  correlation_id  text NOT NULL DEFAULT '',
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash       text,
  entry_hash      text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_tenant_idx ON audit_events (tenant_id, created_at DESC);
CREATE INDEX audit_events_action_idx ON audit_events (action, created_at DESC);
CREATE INDEX audit_events_correlation_idx ON audit_events (correlation_id);
CREATE INDEX audit_events_actor_idx ON audit_events (actor_user_id, created_at DESC);

CREATE TABLE fraud_signals (
  id          uuid PRIMARY KEY,
  tenant_id   uuid REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  signal_type text NOT NULL,
  severity    int NOT NULL DEFAULT 2 CHECK (severity BETWEEN 1 AND 3),
  details     jsonb NOT NULL DEFAULT '{}'::jsonb,
  status      text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','REVIEWED','DISMISSED')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at timestamptz
);

CREATE INDEX fraud_signals_status_idx ON fraud_signals (status, severity DESC, created_at DESC);

CREATE TABLE diagnostics_artifacts (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid REFERENCES tenants(id) ON DELETE CASCADE,
  provider_code      text NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('TRACE','SCREENSHOT','HTML','LOG')),
  storage_path       text NOT NULL,
  size_bytes         bigint NOT NULL DEFAULT 0,
  digest             text NOT NULL DEFAULT '',
  booking_attempt_id uuid REFERENCES booking_attempts(id) ON DELETE SET NULL,
  retention_expires_at timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX diagnostics_artifacts_retention_idx ON diagnostics_artifacts (retention_expires_at);

CREATE TABLE idempotency_keys (
  scope           text NOT NULL,
  key             text NOT NULL,
  request_hash    text NOT NULL DEFAULT '',
  response_status int,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  PRIMARY KEY (scope, key)
);

CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at);

CREATE TABLE job_deadlines (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  booking_request_id uuid NOT NULL REFERENCES booking_requests(id) ON DELETE CASCADE,
  queue_name         text NOT NULL,
  deadline_at        timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX job_deadlines_idx ON job_deadlines (deadline_at);
