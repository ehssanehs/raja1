# Target provider adapter — DISABLED

This folder is a **placeholder**, deliberately kept empty of provider-specific logic.

## Status

| Item | Value |
| --- | --- |
| Compliance review | ⛔ **NOT PASSED** (`docs/provider-research.md` § 8) |
| Automation permitted | **No** |
| Enabled in any environment | **No** (`providers.enabled = false` in migration `0003_seed`) |
| Runtime behaviour | every method throws `NotApprovedError` |

## Why it exists

The architecture requires provider code to be isolated behind `ProviderAdapter` so that the rest of
the platform never depends on a provider's quirks. This folder demonstrates the intended layout
(`adapter.ts`, `selectors.ts`, `parsers.ts`, `fixtures/`) *without* shipping any real endpoint,
cookie flow, selector or parsing rule for the target site.

## What must happen before this folder is filled in

1. Complete every exit criterion **G1–G10** in `docs/provider-research.md` § 8, ending with a
   written compliance review signed off by the project owner.
2. Answer the open questions **Q1–Q10** (automation policy, account policy, rate expectations,
   human-verification policy, payment flow, refund flow, data-retention limits).
3. Only then: implement `searchAvailability` first (read-only), behind `MOCK_PROVIDER=false`,
   `DRY_RUN=true`, in a dedicated feature branch with a security review.

Any implementation added before those gates pass is a policy violation, not a shortcut.
