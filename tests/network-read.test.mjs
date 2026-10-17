import test from "node:test";
import assert from "node:assert/strict";
import { fetchReadWithRetry, isTransientFetchError } from "../public/network-read.js";

test("一時的なGET通信失敗のみ1回再試行して復帰する", async () => {
  let calls = 0;
  const res = await fetchReadWithRetry(async () => {
    if (++calls === 1) throw new TypeError("Failed to fetch");
    return { ok: true };
  }, "/api/cards", undefined, { pause: async () => {} });
  assert.deepEqual(res, { ok: true });
  assert.equal(calls, 2);
});

test("受信POSTは再試行せず二重受付を防ぐ", async () => {
  let calls = 0;
  await assert.rejects(fetchReadWithRetry(async () => {
    calls++;
    throw new TypeError("Failed to fetch");
  }, "/api/receive", { method: "POST" }), TypeError);
  assert.equal(calls, 1);
});

test("非対象GETやHTTP失敗の応答は勝手に再試行しない", async () => {
  let calls = 0;
  const response = { status: 503 };
  const read = await fetchReadWithRetry(async () => { calls++; return response; }, "/api/cards");
  assert.equal(read, response);
  assert.equal(calls, 1);
  await assert.rejects(fetchReadWithRetry(async () => { calls++; throw new Error("Server error"); }, "/api/cards"), /Server error/);
  assert.equal(calls, 2);
});

test("AbortErrorは一時通信失敗として判定する", () => {
  assert.equal(isTransientFetchError(Object.assign(new Error("abort"), { name: "AbortError" })), true);
  assert.equal(isTransientFetchError(new Error("Other")), false);
});
