# R2 cost protection for this independent installation

This is a small addition to the official CloudFlare-ImgBed, not a replacement.

## Limits and accounting

- Thresholds are 85% of the R2 Standard monthly free allowances.
- Maximum conservative storage ledger: **8,500,000,000 bytes**, decimal GB.
- A operations: **850,000**; B operations: **8,500,000**. Equality also blocks.
- Every operation reserves its budget in one conditional D1 `UPDATE … RETURNING`
  before invoking R2. Competing uploads cannot spend the same remaining bytes.
- A read or write is refused if **any** limit is exhausted, the ledger is missing,
  invalid, disabled, unavailable, or Cloudflare statistics cannot be reconciled.
- A readonly Account Analytics token must be stored as the production Pages
  secret `CF_R2_ANALYTICS_TOKEN`. Never put it in Git or frontend code.
- Account-wide GraphQL operations over the previous 31 days and daily storage
  samples are reconciled on demand every five minutes. No R2 call occurs during
  a failed reconciliation. Concurrent refreshes are protected by a D1 lease.
- Analytics errors, truncated results, unknown operation types, invalid values,
  stale storage samples, and unfinished multipart storage cause a closed gate.
- Reservations are **monotonic**: failures, retries, deletes and replacements do
  not refund budget. Cloudflare observed high-water usage is added conservatively;
  it can double-count local usage. Displayed protected usage is not billed usage.
- Counters do **not** automatically reset at a month boundary. Restoring capacity
  requires a deliberate review of account billing and all stored/partial objects.
  This avoids resetting in the wrong billing period or accidentally forgiving
  operations still inside the free allowance window.
- The migration seeds a conservative 1 MB / 1000 A / 1000 B baseline for the
  verified new bucket containing only tiny synthetic pre-installation tests.
  A different or previously used account requires a separately audited baseline.
- Each write includes 8192 bytes of overhead. Multipart parts reserve twice the
  payload plus overhead to cover transient storage. Unknown-length streams are
  rejected; copies of R2 streams carry their known original size.
- Reads, HEAD, lists, puts, moves/renames, deletes, multipart initialization,
  parts/retries, completion and abort are guarded. Deletes are conservatively
  counted as A even though Cloudflare does not bill object deletion.

## Installation

1. Execute `database/migrations/r2_cost_guard.sql` once on production `img_d1`.
2. Add the readonly analytics secret to Pages production and redeploy.
3. Open `/cost-protection.html` after logging in to `/dashboard`; reconcile usage.
4. Check synthetic uploads and public reads, plus fail-closed cases locally.

## Boundaries

This does not create a Cloudflare billing hard cap or guarantee a zero invoice.
Only calls through this fork are gated. Other buckets/apps, direct S3 access,
dashboard operations, stale upstream analytics and unrelated Cloudflare products
remain outside its control. Keep this R2 bucket private, avoid other writers,
and keep Pages/D1 on their free plans. D1 exhaustion causes the gate to close.
Stopping requests does not remove existing stored data or undo accrued charges.
Because the account is intentionally limited to 8.5 GB with safety headroom, keep
all account storage within that allowance, including unfinished uploads.

Automatic upstream synchronization is disabled for this fork: upstream changes
must be reviewed for new R2 call sites before production deployment.

## Verification

`npm test` includes real SQLite concurrency and error tests for the guard, in
addition to the existing upload/read/management regression suite. The existing
route fixtures mock the guard boundary; `costGuard.test.js` exercises the actual
guard and SQL, including multipart and all-call-site coverage.
