# C independent post-change gate: receiver ACK and Ledger delivery

Reviewer C, reviewing E's implementation rather than C's own visual changes. Local candidate reviewed on 2026-11-02. No remote writes, production requests, CI dispatches or changes to authentication settings were performed by C.

## Gate result

**PASS for the receiver/outbox code review and local failure-injection gate after two E fixes.** Twelve independent C boundary cases and twenty-eight related existing/E cases pass (40 total, 0 failures). This is not a claim of production network latency or physical Pixel 10 testing. Final deployed integration and browser gates remain root/G-owned.

## Findings, correction, and independent retest

### 1. A blocked revision series could prevent unrelated products from syncing

Before the follow-up fix, pending successors to a permanent failure were selected ahead of an unrelated product and consumed the outbox selection limit. The per-row ordering guard then skipped every selected successor. A backlog of 31 successors therefore kept the unrelated product pending on every scheduled attempt. The same problem occurred while the preceding revision was waiting for its retry delay.

Independent injection: create revision 1 as either a permanent `failed` row or a `failed` row with `next_attempt_at` in 2999; create 31 pending later revisions; then create a later unrelated product and run delivery with limit 25. Both tests failed before E's follow-up fix.

E changed the selection SQL to exclude successors of a currently unsendable failed predecessor before applying `LIMIT`. The per-source revision-order guard remains. The two independent tests now pass: only the unrelated product is sent; the blocked predecessor remains failed; its successor's attempt count remains zero. A healthy pending series still remains eligible for sequential processing in the same pass.

### 2. HTTP 200 with incomplete or non-final JSON was falsely recorded as sent

Before the follow-up fix, `{}`, `{result:"applied"}`, `{ok:true,result:"queued"}` and `{ok:"true",result:"applied"}` all passed response parsing and caused the outbox row to be marked sent. A successfully parsed HTTP response alone does not prove that a mutation was durably accepted.

E changed mutation response validation to require boolean `ok:true` and a final result of `applied`, `duplicate` or `stale`, matching the Ledger mutation contract. GET reader responses retain their existing shape. All four independent invalid-ACK tests now pass: the row stays failed, `sent_at` remains null, and the protocol error is held for inspection rather than automatically retried.

The independent eight-case outbox suite initially produced 2 passes and 6 failures, representing these two defect categories. Re-running that unchanged suite after E's corrections produces 8 passes and 0 failures.

## Independent additional hurdles

`tests/ledger-review-boundaries.test.mjs` contains eight cases:

1. Permanent failed predecessor plus more than one batch of successors cannot starve another product.
2. Future retry delay plus more than one batch of successors cannot starve another product.
3–6. Four incomplete/non-final mutation ACK payloads cannot mark delivery sent.
7. Headers arrive but the response body stalls: the same 10-second deadline aborts the request and marks a retryable timeout.
8. Ledger receives the mutation but the response body disconnects: a retry sends exactly the same serialized payload and source revision, and the later duplicate ACK completes delivery.

`tests/intake-review-boundaries.test.mjs` contains four cases:

1. A normal receipt is durably saved while dispatch is blocked, then receive mode changes to provisional A. Replaying the same request ID keeps the original normal receipt and job; a changed payload conflicts with 409; no provisional receipt is created.
2. A provisional A receipt is saved, then modes change to B and normal. Every replay remains in the original A bucket with the original receipt/job ID and counts. Changed payload conflicts with 409.
3. Inject a database failure after the first 30 entries of a 65-entry provisional receipt. The failed attempt returns `stored:false`. After changing to normal mode, the same request ID completes all 65 entries in the original A bucket, without entering normal analysis or creating duplicates. Foreign key checks pass.
4. While provisional A is active, ARUNOMATIC holds a URL. Chiritumo sends that URL plus a new URL. It bypasses provisional mode, reports one new and one duplicate URL, and does not change the held URL's original source or status. Only the new Chiritumo URL enters its analysis job. Replaying preserves exact counts and job identity.

## Related regression coverage executed by C

The reviewed receiver returns `stored:true` only after receipt and item materialization; Queue dispatch is placed in `waitUntil` only after that durable boundary. Queue failure leaves `dispatched=0` for the existing recovery path. A queue-less/no-context runtime retains the prior synchronous fallback.

Existing/E scenarios executed include 15-device concurrent blocked-Queue ACKs, 15-device identical-URL convergence, same-ID concurrent replay and payload conflict, queue rejection and scheduled recovery, materialization transaction failure/resume, admin and Chiritumo route ownership, and provisional hold isolation. These use the real schema and SQLite uniqueness/transaction behavior with controlled service boundaries.

Ledger scenarios executed include retryable transport failures and timeouts, non-JSON HTTP 503, permanent 409 behavior for ordinary and ID-targeted delivery, explicit administrator retry, revision ordering, duplicate/stale success, local TypeError not being misclassified as transport, unchanged revenue amounts, truthful campaign-total failure wording, and card enrichment regressions.

Commands and results:

```text
node --test tests/intake-review-boundaries.test.mjs tests/intake-concurrency.test.mjs tests/intake.test.mjs tests/ledger-review-boundaries.test.mjs tests/ledger-delivery.test.mjs
37 passed / 0 failed

node --test tests/ledger-cards.test.mjs
3 passed / 0 failed

git diff --check
passed
```

The simulated 15-device test observed an ACK before Queue release. Its measured local duration is not used as a production response-time promise. Real Cloudflare scheduling, network outages and Android lifecycle behavior are outside this local C gate and must be represented accurately in the final release report.
