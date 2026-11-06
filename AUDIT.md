# Pending queue, sheet refresh, and routing audit

Baseline: `e129664`.

## Findings

- **Pending badge:** Successful saves already removed their queue items and explicitly
  hid an empty badge. However, legacy zero-distance requests can be rejected forever
  by Apps Script. Rejections correctly stayed pending, but there was no review/clear
  action, no request timeout, and no attempt to drain an existing queue at startup
  when the device was already online. A repaired sheet row was not reconciled with
  the corresponding pending ID. HTTP 200 alone is insufficient because Apps Script
  also returns application errors with HTTP 200.
- **Stale zero mileage:** Refresh used `cache: "no-store"` but always requested the same
  URL. More conclusively, overlapping GET requests had no ordering guard: a delayed
  zero-kilometre response could overwrite a newer edited-sheet response and all three
  local caches. Both the missing unique refresh URL and the stale-response overwrite
  fail regression checks against the baseline.
- **Routing:** The current pipeline already awaited all geocoding promises, and the
  backend already rejected nonpositive mileage. Coordinate validation was incomplete,
  manual input used permissive `parseFloat`, and infinity could pass the frontend
  checks. The earlier backend in repository history skipped failed directions and
  could append a zero or partial total. No live failed elementary-school request
  was available, so an address-specific geocoding cause has not been established.
- **Double taps:** The immediate `isSubmitting` lock and spinner were already present.
  Preserve them; verify that authorization UI updates cannot re-enable the button
  during a slow route calculation, and that cancel/error paths release the lock.

## Patch

- Reconcile pending items only by exact IDs found in a fresh sheet response. Preserve
  unmatched trips; never deduplicate by route/date alone.
- The pending pill refreshes/reconciles, retries, then offers explicit confirmation
  to discard the listed unconfirmed local submissions. It does not delete sheet rows
  or newly queued items. Cancel preserves them. Retain immediate persisted removal
  on a positive JSON save acknowledgement and explicit hiding when the queue is empty.
- Bound network and JSON-body reads; release queue locks on timeout. Drain at startup
  after refresh and update the badge when another tab changes queue storage.
- Add a unique refresh query parameter, bypass cached API responses in the service
  worker, replace all trip caches, and ignore older in-flight refresh results.
- Require finite, in-range coordinates and finite positive mileage rounded to 0.1 km.
  Await the whole route and require valid manual mileage or abort. Guard direct saves
  as well as the Record button path. Keep the existing server validation unchanged.

## Verification

Run `node --test scripts/backend.test.cjs scripts/frontend.test.cjs`.
The suite simulates Google services, storage, response ordering, coordinate delays,
timeouts, manual input, badge classes, and button state. It does not write to a live sheet.
The unchanged backend and the in-app copy remain identical.

For the refresh regressions against the old source, set `DRIVING_LOG_TEST_REF=e129664`
and run the frontend tests with a test-name pattern of
`hard refresh replaces|older sheet responses`. Both must fail on the baseline.

Live checks still required: edit an existing sheet row's KM, tap the app's header
refresh, verify the new number, then test one real save and retry. The deployed Apps
Script version and actual elementary-school geocoder results were not accessed.
