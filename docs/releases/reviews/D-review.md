# D independent UI acceptance gate

Reviewer: /root/android_impl. Implementation under review: B's pending edit/confirmation, sorting continuity, and single-win UI. Review date 2026-11-02. No production files edited by D in the Vault repository.

## Different acceptance barrier

Implementation-side tests demonstrate the normal saves and recoveries. D separately checked interference between multiple DOM views, switching source while a read is pending, late modal responses, and the difference between an uncertain GET and a confirmed canonical POST.

New test file: work/winning-url-vault/tests/ui-independent-integrity.test.mjs.

1. Two separate editor nodes for the same pending ID cannot issue concurrent writes. Completion removes both representations of that ID but leaves another pending group and its open modal intact.
2. A logically mismatched successful HTTP response restores the exact prior readOnly/editable mixture, leaves edited text, and issues no success notice.
3. A sorting refresh completed after a source change cannot label the original source with the other source's remaining-card count or switch the selected source/tab.
4. A campaign preview arriving after its modal closes cannot enable confirmation or replace cleared state.
5. GET transport failure, an unknown result state, and an unrelated HTTP404 keep exact local recovery metadata and do not issue POST.
6. Reopening a card after the server preview has grown preserves the pending operation's original item IDs, token, count and request ID.
7. A lost response followed by GET404 for a noncanonical local request retries the exact original POST. A canonical completed response can then clear that operation safely.
8. A needs_review response belonging to another source cannot delete the original recovery metadata.

## Results

- Independent tests: 8/8 PASS, 0 failed, 0 skipped.
- Combined B implementation tests plus D independent tests: 29/29 PASS, 0 failed, 0 skipped.
- git diff --check: PASS.
- Confirmed /single-win-ui.js is in service-worker precache and package.json syntax checks.
- Static review confirms long product details use textContent, pending edits snapshot inputs before await, and sorting completion does not call switchTab('winning').

## Contract clarification / follow-up

F confirmed that POST same-snapshot requests may legitimately return a different canonical request_id; the UI must allow this. GET /single-wins/{request_id} returns the requested ID, so strict GET identity matching is a separate possible guard. D raised this with B/root; it must not be implemented by enforcing request identity on canonical POST responses. Existing endpoint behavior satisfies the GET identity invariant; no actual mismatched production receipt was observed.

This gate proves handler/controller behavior using the shipped functions. C/G own rendered browser/mobile layout and end-to-end checks; no physical Pixel10 operation is claimed here.
