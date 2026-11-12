import assert from "node:assert/strict";
import {test} from "node:test";
import { matchingShareReceipt, pendingShares, removePendingShare, savePendingShare } from "../public/share-storage.js";

const first = "00000000-0000-4000-8000-000000000001";
const second = "00000000-0000-4000-8000-000000000002";
const legacyKey = "winning-url-vault:pending-share";

function memoryStorage() {
  const records = new Map();
  return {
    get length() { return records.size; },
    key(index) { return Array.from(records.keys())[index] ?? null; },
    getItem(key) { return records.get(key) ?? null; },
    setItem(key,value) { records.set(key,value); },
    removeItem(key) { records.delete(key); }
  };
}

test("a confirmed receipt removes only its own share even after another share is saved", async () => {
  const storage = memoryStorage();
  savePendingShare(storage, first, ["original"]);
  savePendingShare(storage, second, ["pending"]);
  const receipts = await pendingShares(storage, () => []);
  assert.deepEqual(receipts.map(record => record.clientRequestId), [first, second]);
  assert.equal(matchingShareReceipt({ok:true,stored:true,clientRequestId:second},first), false);
  assert.equal(matchingShareReceipt({ok:true,stored:true,clientRequestId:first},first), true);
  removePendingShare(storage, first);
  assert.deepEqual(await pendingShares(storage, () => []), [{clientRequestId:second,values:["pending"]}]);
  assert.throws(() => savePendingShare(storage,second,["changed"]));
});

test("legacy share stays retryable and concurrent migration preserves one stable ID", async () => {
  const storage = memoryStorage();
  storage.setItem(legacyKey, JSON.stringify({text:"legacy",createdAt:1}));
  const [a,b] = await Promise.all([pendingShares(storage,text => [text]),pendingShares(storage,text => [text])]);
  assert.deepEqual(a,b);
  assert.equal(a.length,1);
  assert.deepEqual(a[0].values,["legacy"]);
  assert.equal(storage.getItem(legacyKey),null);
});

test("failed storage write leaves the old share intact", async () => {
  const storage = memoryStorage();
  storage.setItem(legacyKey, JSON.stringify({text:"legacy"}));
  storage.setItem = () => { throw Error("quota"); };
  await assert.rejects(pendingShares(storage,text => [text]), /quota/);
  assert.ok(storage.getItem(legacyKey));
});
