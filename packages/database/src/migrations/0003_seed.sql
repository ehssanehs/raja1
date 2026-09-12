-- =============================================================================
-- 0003_seed — reference data that the platform cannot run without:
-- plans/entitlements/prices, feature flags, system settings, provider registry,
-- station + route catalogue. All values are *data*: pricing and limits change without code.
-- =============================================================================

INSERT INTO plans (id, code, name_en, name_fa, sort_order) VALUES
  ('11111111-1111-4111-8111-000000000001', 'FREE',     'Free',     'رایگان',   1),
  ('11111111-1111-4111-8111-000000000002', 'STANDARD', 'Standard', 'استاندارد', 2),
  ('11111111-1111-4111-8111-000000000003', 'PRO',      'Pro',      'حرفه‌ای',   3),
  ('11111111-1111-4111-8111-000000000004', 'PREMIUM',  'Premium',  'ویژه',      4),
  ('11111111-1111-4111-8111-000000000005', 'BUSINESS', 'Business', 'سازمانی',   5);

-- Entitlements (spec § 31/94). `unit` documents how a limit is measured.
WITH feature_matrix(plan_code, feature_key, enabled, limit_value, unit) AS (VALUES
  -- FREE: monitoring only, slow cadence
  ('FREE','telegramNotifications',true, NULL::bigint, 'BOOL'),
  ('FREE','webNotifications',     true, NULL, 'BOOL'),
  ('FREE','priceMonitoring',      true, NULL, 'BOOL'),
  ('FREE','multiDateMonitoring',  true, 3,    'DAY_COUNT'),
  ('FREE','maxActiveMonitors',    true, 2,    'COUNT'),
  ('FREE','minIntervalSeconds',   true, 300,  'SECONDS'),
  ('FREE','maxPassengers',        true, 2,    'COUNT'),
  ('FREE','dateRangeDays',        true, 3,    'DAY_COUNT'),
  ('FREE','schedulingWeight',     true, 1,    'COUNT'),
  ('FREE','bookingAttemptsPerMonth', true, 5, 'COUNT'),

  ('STANDARD','telegramNotifications',true, NULL, 'BOOL'),
  ('STANDARD','webNotifications',     true, NULL, 'BOOL'),
  ('STANDARD','emailNotifications',   true, NULL, 'BOOL'),
  ('STANDARD','priceMonitoring',      true, NULL, 'BOOL'),
  ('STANDARD','multiDateMonitoring',  true, 7,    'DAY_COUNT'),
  ('STANDARD','seatSelection',        true, NULL, 'BOOL'),
  ('STANDARD','maxActiveMonitors',    true, 5,    'COUNT'),
  ('STANDARD','minIntervalSeconds',   true, 180,  'SECONDS'),
  ('STANDARD','maxPassengers',        true, 4,    'COUNT'),
  ('STANDARD','dateRangeDays',        true, 7,    'DAY_COUNT'),
  ('STANDARD','schedulingWeight',     true, 2,    'COUNT'),
  ('STANDARD','bookingAttemptsPerMonth', true, 25, 'COUNT'),

  ('PRO','telegramNotifications',  true, NULL, 'BOOL'),
  ('PRO','webNotifications',       true, NULL, 'BOOL'),
  ('PRO','emailNotifications',     true, NULL, 'BOOL'),
  ('PRO','priceMonitoring',        true, NULL, 'BOOL'),
  ('PRO','multiDateMonitoring',    true, 15,   'DAY_COUNT'),
  ('PRO','seatSelection',          true, NULL, 'BOOL'),
  ('PRO','returnTrips',            true, NULL, 'BOOL'),
  ('PRO','advancedMatching',       true, NULL, 'BOOL'),
  ('PRO','autoFill',               true, NULL, 'BOOL'),
  ('PRO','sessionWarmup',          true, NULL, 'BOOL'),
  ('PRO','priorityQueue',          true, NULL, 'BOOL'),
  ('PRO','maxActiveMonitors',      true, 15,   'COUNT'),
  ('PRO','minIntervalSeconds',     true, 60,   'SECONDS'),
  ('PRO','maxPassengers',          true, 6,    'COUNT'),
  ('PRO','dateRangeDays',          true, 15,   'DAY_COUNT'),
  ('PRO','schedulingWeight',       true, 4,    'COUNT'),
  ('PRO','bookingAttemptsPerMonth',true, 100,  'COUNT'),

  ('PREMIUM','telegramNotifications', true, NULL, 'BOOL'),
  ('PREMIUM','webNotifications',      true, NULL, 'BOOL'),
  ('PREMIUM','emailNotifications',    true, NULL, 'BOOL'),
  ('PREMIUM','priceMonitoring',       true, NULL, 'BOOL'),
  ('PREMIUM','multiDateMonitoring',   true, 31,   'DAY_COUNT'),
  ('PREMIUM','seatSelection',         true, NULL, 'BOOL'),
  ('PREMIUM','returnTrips',           true, NULL, 'BOOL'),
  ('PREMIUM','advancedMatching',      true, NULL, 'BOOL'),
  ('PREMIUM','autoFill',              true, NULL, 'BOOL'),
  ('PREMIUM','autoHold',              true, NULL, 'BOOL'),
  ('PREMIUM','sessionWarmup',         true, NULL, 'BOOL'),
  ('PREMIUM','priorityQueue',         true, NULL, 'BOOL'),
  ('PREMIUM','highDemandMode',        true, NULL, 'BOOL'),
  ('PREMIUM','supportPriority',       true, NULL, 'BOOL'),
  ('PREMIUM','maxActiveMonitors',     true, 40,   'COUNT'),
  ('PREMIUM','minIntervalSeconds',    true, 30,   'SECONDS'),
  ('PREMIUM','maxPassengers',         true, 10,   'COUNT'),
  ('PREMIUM','dateRangeDays',         true, 31,   'DAY_COUNT'),
  ('PREMIUM','schedulingWeight',      true, 8,    'COUNT'),
  ('PREMIUM','bookingAttemptsPerMonth', true, 400, 'COUNT'),

  ('BUSINESS','telegramNotifications', true, NULL, 'BOOL'),
  ('BUSINESS','webNotifications',      true, NULL, 'BOOL'),
  ('BUSINESS','emailNotifications',    true, NULL, 'BOOL'),
  ('BUSINESS','priceMonitoring',       true, NULL, 'BOOL'),
  ('BUSINESS','multiDateMonitoring',   true, 62,   'DAY_COUNT'),
  ('BUSINESS','seatSelection',         true, NULL, 'BOOL'),
  ('BUSINESS','returnTrips',           true, NULL, 'BOOL'),
  ('BUSINESS','advancedMatching',      true, NULL, 'BOOL'),
  ('BUSINESS','autoFill',              true, NULL, 'BOOL'),
  ('BUSINESS','autoHold',              true, NULL, 'BOOL'),
  ('BUSINESS','authorizedAutoBooking', true, NULL, 'BOOL'),
  ('BUSINESS','sessionWarmup',         true, NULL, 'BOOL'),
  ('BUSINESS','priorityQueue',         true, NULL, 'BOOL'),
  ('BUSINESS','highDemandMode',        true, NULL, 'BOOL'),
  ('BUSINESS','apiAccess',             true, NULL, 'BOOL'),
  ('BUSINESS','supportPriority',       true, NULL, 'BOOL'),
  ('BUSINESS','maxActiveMonitors',     true, 200,  'COUNT'),
  ('BUSINESS','minIntervalSeconds',    true, 20,   'SECONDS'),
  ('BUSINESS','maxPassengers',         true, 10,   'COUNT'),
  ('BUSINESS','dateRangeDays',         true, 62,   'DAY_COUNT'),
  ('BUSINESS','schedulingWeight',      true, 8,    'COUNT'),
  ('BUSINESS','bookingAttemptsPerMonth', true, 2000, 'COUNT')
)
INSERT INTO plan_features (id, plan_id, feature_key, enabled, limit_value, unit)
SELECT gen_random_uuid(), p.id, m.feature_key, m.enabled, m.limit_value, m.unit
FROM feature_matrix m JOIN plans p ON p.code = m.plan_code;

-- Prices are illustrative data (spec § 34/93): the billing core never hardcodes money.
INSERT INTO plan_prices (id, plan_id, currency, interval, amount_minor) VALUES
  (gen_random_uuid(), '11111111-1111-4111-8111-000000000001', 'IRR', 'MONTHLY', 0),
  (gen_random_uuid(), '11111111-1111-4111-8111-000000000002', 'IRR', 'MONTHLY', 990000),
  (gen_random_uuid(), '11111111-1111-4111-8111-000000000003', 'IRR', 'MONTHLY', 2490000),
  (gen_random_uuid(), '11111111-1111-4111-8111-000000000004', 'IRR', 'MONTHLY', 4900000),
  (gen_random_uuid(), '11111111-1111-4111-8111-000000000005', 'IRR', 'MONTHLY', 12000000),
  (gen_random_uuid(), '11111111-1111-4111-8111-000000000002', 'IRR', 'YEARLY', 9900000),
  (gen_random_uuid(), '11111111-1111-4111-8111-000000000003', 'IRR', 'YEARLY', 24900000),
  (gen_random_uuid(), '11111111-1111-4111-8111-000000000004', 'IRR', 'YEARLY', 49000000);

-- Feature flags (spec § 60). Automation flags default OFF: enablement is a deliberate act.
INSERT INTO feature_flags (key, description, default_enabled) VALUES
  ('autoFillEnabled',        'Allow AUTO_FILL automation mode (requires consent)', false),
  ('autoHoldEnabled',        'Allow AUTO_HOLD automation mode (provider must support holds)', false),
  ('autoBookingEnabled',     'Allow AUTHORIZED_AUTO_BOOKING (provider compliance + admin flag)', false),
  ('highDemandEnabled',      'Enable release-window / high-demand mode', true),
  ('sessionWarmupEnabled',   'Enable provider session warm-up before release windows', true),
  ('walletEnabled',          'Enable the internal wallet', true),
  ('paymentsEnabled',        'Enable payment provider flows', true),
  ('subscriptionsEnabled',   'Enable subscription plans', true),
  ('referralsEnabled',       'Enable referral rewards', true),
  ('couponsEnabled',         'Enable coupons and promotions', true),
  ('emailNotificationsEnabled', 'Enable email notification channel', true),
  ('smsNotificationsEnabled',   'Enable SMS notification channel (costs money)', false),
  ('priceMonitoringEnabled',    'Enable price tracking and alerts', true),
  ('providerMockEnabled',       'Enable the built-in mock provider', true),
  ('providerSimulatorEnabled',  'Enable the provider simulator (non-production only)', true),
  ('providerRajaEnabled',       'Enable the real (raja) provider adapter', false),
  ('maintenanceBannerEnabled',  'Show a maintenance banner in web and bot', false);

-- Operational parameters (spec § 61): most behaviour is configurable without a deploy.
INSERT INTO system_settings (key, value, description) VALUES
  ('monitoring.defaultIntervalSeconds', '60'::jsonb, 'Default monitor interval'),
  ('monitoring.jitterRatio',            '0.25'::jsonb, 'Jitter ratio applied to intervals'),
  ('monitoring.minIntervalSeconds',     '20'::jsonb, 'Hard server-side floor for any interval'),
  ('monitoring.maxConcurrentSearchesPerTenant', '3'::jsonb, 'Per-tenant concurrent search cap'),
  ('monitoring.strategyDefault',        '"JITTERED"'::jsonb, 'Default monitoring strategy'),
  ('monitoring.burstValidationOffsetsSeconds', '[0,3,10]'::jsonb, 'Burst validation schedule (spec § 15)'),
  ('booking.approvalWindowMinutes',     '10'::jsonb, 'Minutes a user has to approve a reservation'),
  ('booking.verificationWindowMinutes', '15'::jsonb, 'Minutes a user has to complete human verification'),
  ('booking.allowSplitBooking',         'false'::jsonb, 'Never split a group booking by default (spec § 11)'),
  ('booking.cancelLowerPrioritiesOnSuccess', 'true'::jsonb, 'Auto-cancel lower-priority monitors after a success'),
  ('billing.serviceFeeBasisPoints',     '250'::jsonb, 'Service fee in basis points of the ticket price'),
  ('billing.bookingChargeBasisPoints',  '100'::jsonb, 'Per-successful-booking fee in basis points'),
  ('billing.highDemandSurchargeMinor',  '500000'::jsonb, 'High-demand window surcharge (minor units)'),
  ('billing.lowBalanceThresholdMinor',  '200000'::jsonb, 'Wallet-low notification threshold'),
  ('billing.refundOnNonAdmission',      'true'::jsonb, 'Refund the high-demand surcharge when not admitted'),
  ('quota.warningThresholdPercent',     '80'::jsonb, 'When to warn about quotas'),
  ('capacity.releaseWindowSafetyMargin','0.8'::jsonb, 'Fraction of safe capacity we are willing to admit'),
  ('rateLimit.providerRequestsPerMinute','30'::jsonb, 'Global provider request budget'),
  ('rateLimit.providerBurst',           '10'::jsonb, 'Global provider burst'),
  ('rateLimit.accountConcurrent',       '1'::jsonb, 'Concurrent requests per provider account'),
  ('rateLimit.accountRequestsPerMinute','12'::jsonb, 'Requests per minute per provider account'),
  ('retention.auditDays',               '730'::jsonb, 'Audit retention'),
  ('retention.diagnosticsDays',         '14'::jsonb, 'Trace/screenshot retention'),
  ('retention.searchJobsDays',          '30'::jsonb, 'Search job observability retention'),
  ('security.maxLoginAttempts',         '8'::jsonb, 'Failed logins before lockout'),
  ('security.lockoutMinutes',           '15'::jsonb, 'Lockout duration'),
  ('security.sessionIdleTimeoutMinutes','10080'::jsonb, 'Session lifetime (7 days)'),
  ('security.requireEmailVerification', 'true'::jsonb, 'Require email verification before use'),
  ('abuse.maxAccountsPerIpPerDay',      '5'::jsonb, 'Signup velocity guard'),
  ('abuse.maxActiveMonitorsPerUser',    '200'::jsonb, 'Absolute cap regardless of plan'),
  ('web.publicBaseUrl',                 '"http://localhost:3000"'::jsonb, 'Used in notifications'),
  ('support.email',                     '"support@example.com"'::jsonb, 'Support mailbox');

-- Provider registry. `mock` is the default everywhere; the real provider is NOT enabled and
-- NOT reviewed (docs/provider-research.md § 8).
INSERT INTO providers (code, name_en, name_fa, adapter_key, transport, enabled, compliance_status, compliance_notes, capabilities, timezone, rate_limit) VALUES
  ('mock', 'Mock provider (tests)', 'ارائه‌دهنده آزمایشی', 'mock', 'HTTP_JSON', true, 'APPROVED',
   'Deterministic in-memory provider used by unit tests. No external traffic.',
   '{"supportsSeatSelection":true,"supportsHold":true,"supportsAutoBooking":true,"supportsReturnTrips":true,"supportsPriceFiltering":true,"supportsDateRangeSearch":true,"supportsCancellation":true,"supportsRefundApi":true,"requiresLogin":true,"requiresCaptcha":"SOMETIMES","paymentsAreThirdParty":false,"maxPassengersPerReservation":10,"maxSeatsPerSearch":50}'::jsonb,
   'UTC', '{"requestsPerMinute":600,"burst":100}'::jsonb),
  ('simulator', 'Provider simulator (dev/CI)', 'شبیه‌ساز ارائه‌دهنده', 'simulator', 'HTTP_JSON', true, 'APPROVED',
   'Local HTTP simulator used for integration and chaos testing. Never enabled in production.',
   '{"supportsSeatSelection":true,"supportsHold":true,"supportsAutoBooking":true,"supportsReturnTrips":true,"supportsPriceFiltering":false,"supportsDateRangeSearch":false,"supportsCancellation":true,"supportsRefundApi":false,"requiresLogin":true,"requiresCaptcha":"SOMETIMES","paymentsAreThirdParty":true,"maxPassengersPerReservation":6,"maxSeatsPerSearch":10}'::jsonb,
   'Asia/Tehran', '{"requestsPerMinute":120,"burst":20}'::jsonb),
  ('raja', 'Raja (rail ticketing)', 'رجا (فروش بلیت قطار)', 'raja', 'BROWSER', false, 'NOT_REVIEWED',
   'Automation NOT approved. Gate checklist G1–G10 incomplete (docs/provider-research.md § 8). Adapter is a disabled placeholder; all methods throw NotApprovedError.',
   '{"supportsSeatSelection":false,"supportsHold":false,"supportsAutoBooking":false,"supportsReturnTrips":true,"supportsPriceFiltering":false,"supportsDateRangeSearch":false,"supportsCancellation":false,"supportsRefundApi":false,"requiresLogin":true,"requiresCaptcha":"UNKNOWN","paymentsAreThirdParty":true,"maxPassengersPerReservation":6,"maxSeatsPerSearch":0}'::jsonb,
   'Asia/Tehran', '{"requestsPerMinute":30,"burst":10}'::jsonb);

-- Station catalogue for the simulator/mock providers (fa/en + aliases).
INSERT INTO provider_stations (id, provider_code, code, name_fa, name_en, city_fa, city_en, aliases) VALUES
  (gen_random_uuid(), 'simulator', 'THR', 'تهران',        'Tehran',    'تهران',   'Tehran',   ARRAY['tehran','تهران','thr']),
  (gen_random_uuid(), 'simulator', 'MHD', 'مشهد',          'Mashhad',   'مشهد',    'Mashhad',  ARRAY['mashhad','مشهد','mhd']),
  (gen_random_uuid(), 'simulator', 'ISF', 'اصفهان',        'Isfahan',   'اصفهان',  'Isfahan',  ARRAY['isfahan','esfahan','اصفهان','isf']),
  (gen_random_uuid(), 'simulator', 'SHZ', 'شیراز',         'Shiraz',    'شیراز',   'Shiraz',   ARRAY['shiraz','شیراز','shz']),
  (gen_random_uuid(), 'simulator', 'TBZ', 'تبریز',         'Tabriz',    'تبریز',   'Tabriz',   ARRAY['tabriz','تبریز','tbz']),
  (gen_random_uuid(), 'simulator', 'YZD', 'یزد',           'Yazd',      'یزد',     'Yazd',     ARRAY['yazd','یزد','yzd']),
  (gen_random_uuid(), 'simulator', 'AHV', 'اهواز',         'Ahvaz',     'اهواز',   'Ahvaz',    ARRAY['ahvaz','اهواز','ahv']),
  (gen_random_uuid(), 'simulator', 'QOM', 'قم',            'Qom',       'قم',      'Qom',      ARRAY['qom','قم','qom']),
  (gen_random_uuid(), 'simulator', 'GOR', 'گرگان',         'Gorgan',    'گرگان',   'Gorgan',   ARRAY['gorgan','گرگان','gor']),
  (gen_random_uuid(), 'simulator', 'KER', 'کرمان',         'Kerman',    'کرمان',   'Kerman',   ARRAY['kerman','کرمان','ker']),
  (gen_random_uuid(), 'simulator', 'ARD', 'اردبیل',        'Ardabil',   'اردبیل',  'Ardabil',  ARRAY['ardabil','اردبیل','ard']),
  (gen_random_uuid(), 'simulator', 'RAS', 'رشت',           'Rasht',     'رشت',     'Rasht',    ARRAY['rasht','رشت','ras']);

INSERT INTO provider_stations (id, provider_code, code, name_fa, name_en, city_fa, city_en, aliases)
SELECT gen_random_uuid(), 'mock', code, name_fa, name_en, city_fa, city_en, aliases
FROM provider_stations WHERE provider_code = 'simulator';

INSERT INTO provider_routes (id, provider_code, origin_station_id, destination_station_id)
SELECT gen_random_uuid(), o.provider_code, o.id, d.id
FROM provider_stations o
JOIN provider_stations d ON d.provider_code = o.provider_code AND d.id <> o.id
WHERE o.provider_code IN ('simulator','mock')
  AND o.code IN ('THR','MHD','ISF','SHZ','TBZ','YZD','AHV','QOM','GOR','KER','ARD','RAS')
  AND (
    (o.code = 'THR' AND d.code IN ('MHD','ISF','SHZ','TBZ','YZD','AHV','QOM','GOR','KER','ARD','RAS')) OR
    (d.code = 'THR' AND o.code IN ('MHD','ISF','SHZ','TBZ','YZD','AHV','QOM','GOR','KER','ARD','RAS')) OR
    (o.code = 'MHD' AND d.code IN ('ISF','SHZ','YZD','TBZ')) OR
    (d.code = 'MHD' AND o.code IN ('ISF','SHZ','YZD','TBZ'))
  );
