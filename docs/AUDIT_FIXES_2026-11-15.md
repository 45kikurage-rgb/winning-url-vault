# Aruno-Ticket audit fixes — 2026-11-15

Baseline: `1806000c903502252200d4d3435aab7132f15c03`.
Policy checked: ARUNO CURRENT `2026-11-08.1`, Library version 16, modified
`2026-11-08T09:53:06.782331Z`; unchanged from the audit in this chat.

## Result

The audit's six high-priority defects and six related defects are fixed in this
candidate. Implementation and local software verification are complete.
Production deployment, production-data inspection/backfill, and Pixel 10
acceptance have not been performed.

| Audit | Change |
| --- | --- |
| F01 | Preserve each URL's analysis JSON, balance and evidence while sharing its classification destination. Retain 80-item chunks and guarded finalization. |
| F02 | Ignore stale image conversion, clipboard and analyzer responses; bind confirmation to the current URL and successful analysis. |
| F03 | Bind close preview and confirmation to the campaign/request generation; ignore responses for previously closed dialogs. |
| F04 | Restore the visibility of a reused archived product in the assignment batch, retaining its product ID, settings, history and other campaigns' assignments. |
| F05 | Guard every bulk-export item update with the batch's pending state; cancellation winning the race leaves all items unexported. |
| F06 | Keep the existing primary browser key while staging a candidate; authenticate the candidate before promotion. Preserve recovery after lost enrollment replies and failed storage/login; converge concurrent tabs on one candidate. |
| F07 | Prevent stale card contents/cursors and duplicate page requests from entering another card's dialog. |
| F08 | Collect URLs across all Android share fields instead of allowing explanatory text to suppress a separately supplied URL. |
| F09 | Apply existing safe-read retry/timeout behavior to listing URLs with query parameters. Writes are not retried. |
| F10 | Align HTML/SW asset URLs and advance the cache version. |
| F11 | Count provisional input repeats from the persisted raw envelope, including existing receipts and retries, without a schema change. |
| F12 | Scope the confirmation-card waiting color so it does not override the shared receipt's waiting color. |

The main-tab CSS declarations were consolidated without changing their final
column widths or scrolling behavior. Broader CSS removal, input-parser and
release-script consolidation, and read-load optimizations are deferred.

## Verification

- `npm run check`: passed.
- `npm test`: **243 passed, 0 failed, 0 skipped**; 33 regression tests added to
  the previous 210-test suite.
- `node --check src/worker.js`: passed.
- `wrangler deploy --dry-run --outdir <temporary-directory>`: production-entry
  bundle built successfully; no remote deployment or migration.
- `git diff --check`: passed.
- Existing mobile browser gate: exact HTML/SW precache closure passed. Browser
  cases were blocked before execution: the bundled Playwright browser was
  unavailable, system Chromium could not create its process socket, and the
  cloud browser could not connect to the local server. Browser/visual and
  physical-device acceptance are **unverified**.

New regression coverage exercises the actual receive/finalize/read pipeline
with isolated SQLite, 82 distinct balances spanning a chunk boundary, individual
unknown evidence, provisional replay/COIN+ repeats, archived-product selection
paths, 161-item export/cancel races, delayed UI replies, WebCrypto key recovery,
candidate staging races, share fields and safe query retries.

## Boundaries and remaining questions

- Existing URL/code bodies, product/campaign IDs, revenue sources, authentication
  scope and API endpoints are retained. No migration, data purge or automatic
  reanalysis/backfill is included.
- Existing production records affected by the old defects have not been
  identified or rewritten. The patch prevents recurrence; any data repair needs
  a separate, non-destructive inspection and review of affected records.
- Moving a product A → B → A can still be explicitly rejected by the existing
  destination-conflict rule. This differs from F04's silently hidden successful
  assignment and has not been changed.
- F03 fixes cross-campaign response confusion. A server contract binding close
  confirmation to an immutable same-campaign preview snapshot is not introduced.
- The Coke ON case-sensitivity policy discrepancy remains a specification
  question; no canonicalization or existing coupon identity is changed here.
