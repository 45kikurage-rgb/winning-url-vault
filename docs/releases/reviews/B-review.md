# B independent Android lifecycle gate — 2026-11-02

Reviewer: /root/vault_ui, separate from D Android implementation. Scope: current shared receipt success/failure, Home and recreation, five consecutive shares, stale callbacks, and outbox preservation. No commit, push, CI dispatch, APK install, or production change by B.

## Static review

Reviewed WinningTransferActivity, WinningPendingStore, WinningTransferQueue, and WinningValueSender in work/arunomatic, including their existing tests.

- A durable successful receipt (stored=true/valid requestId + job, preserved locally as acknowledged=true) is distinguished from an unknown or failed outcome. Optional missing counts do not turn a proven durable ACK into a retry; legacy receipts with no proof remain open.
- The successful display deadline is 2,000 ms and uses elapsedRealtime after first receipt observation, subtracting receipt age. Repeated refresh/resume preserves the deadline. Restored expired success is consumed without showing a new popup. Timers bind the request ID and generation.
- Home consumes only the current proven successful shared result and marks resultHandled on its receipt. The receipt/history stays; failed, in-flight, or unreadable records are not deleted. Late success arriving after Home is handled through the observed transfer event.
- New intents cancel old callbacks and reset per-request keep-open/deadline state. Successful older presentation is consumed; a failed older request stays in the outbox. Finished/destroyed activities do not render late history callbacks.
- History scanning is off the UI/network queue, event-driven rather than every status tick. B found pending() still retained the outer synchronized scan lock; D removed that redundant whole-history lock while keeping AtomicFile per-record locking and the before-send SENT recheck.

## Distinct independent hurdles

New file: app/src/test/java/com/aruno/arunomatic/WinningCompletionIndependentTest.java. Six methods run on API 28 and API 35, for 12 cases. This suite deliberately uses lifecycle interleavings separate from D's implementation-focused cases:

1. Pause without stop, wait, and resume: open at the original origin + 1,999 ms; closed at origin + 2,000 ms. Resume must not restart a two-second timer.
2. Tap keep-open and immediately save/pause/stop without draining the event queue. Restore saved state and keep the screen open. A new shared receipt resets that consent and has its own exact deadline.
3. Home while result is pending, then persist a valid ACK and deliver the actual observer callback. Only that successful receipt is consumed, and reopening does not replay a dialog.
4. Home while pending, then record a failure: no automatic closure, no resultHandled, original values retained and exact JSON bytes unchanged after reopening.
5. Five share/Home/reopen cycles mixing three successes and two failures: successful dialogs never replay, both failure files remain byte-for-byte, all five history files remain, pending count is exactly two.
6. Queue a history scan, approach the old success deadline, then replace the current request with a legacy unknown receipt. Neither old timer nor late history closes it, and callbacks after destruction cannot revive the UI.

## Executed findings and clock correction

D's first real local Robolectric execution exposed a genuine rapid-Home race: AlertDialog's default negative-button callback was queued, so onStop could run before the keep-open flag was set. D changed the negative button to a synchronous OnClickListener; the test still taps and immediately pauses/stops without an artificial idle.

The first execution also exposed a test-clock artifact. D's temporary probe measured resume at 101 ms, visible completion at 203 ms, and deadline at 2,101 ms: Robolectric visible() had advanced 102 ms before a relative 1,999 ms assertion began. The B helper now records elapsedRealtime immediately after resume and before visible. Likewise, the new-intent clock is captured before onNewIntent's dialog drawing. Assertions remain exactly 1,999 ms open / 2,000 ms closed; no tolerance or extended deadline was introduced. The stale callback test changes intent at the old origin + 1,900 ms to exercise a live old timer.

Final local execution: B's 12 independent cases PASS, with zero skipped. D ran them together with 6 durable-receipt cases: D-independent-robolectric.log ends in `OK (18 tests)` (11.176 s). Its separate implementation lifecycle run ends in `OK (36 tests)` (13.039 s). B inspected both actual logs. The earlier 2 failures in the new-intent boundary assertion were resolved by the documented clock-origin correction, with the strict 1,999/2,000 ms boundary unchanged. The immediate keep-open/Home case passes without draining queued callbacks. Compile output for the independent class is empty (successful compile reported by D).

Independent B gate verdict: PASS for the six local lifecycle hurdles on both API versions, after the actual keep-open race and history-lock findings were corrected. No remaining blocker was found in this scope. Local evidence files: implementation-notes/D-independent-robolectric.log, D-local-robolectric.log, and D-independent-compile.log. CI/build and real-device limitations below remain explicit.

## Evidence limits

These are local Robolectric lifecycle tests, with synthetic durable receipt writes and the real transfer observer callback. They do not prove actual Pixel 10 task-stack behavior, Wi-Fi/radio timing, a physical process kill, APK installation, or a production network exchange. The saved-state recreation test establishes persisted fields, not a device-level process test. Candidate build/CI and device checks remain root/D release responsibilities; test code alone is not a pass.
