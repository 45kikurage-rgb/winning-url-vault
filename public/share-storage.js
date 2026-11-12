const LEGACY_KEY = "winning-url-vault:pending-share";
const PREFIX = LEGACY_KEY + ":";

export function validShareId(value) {
  return typeof value === "string" && /^[0-9a-f-]{16,64}$/i.test(value);
}

export function savePendingShare(storage, clientRequestId, values) {
  if (!validShareId(clientRequestId)) throw new TypeError("Invalid share receipt ID");
  const key = PREFIX + clientRequestId;
  const record = JSON.stringify({ clientRequestId, values });
  const existing = storage.getItem(key);
  if (existing !== null && existing !== record) throw new Error("共有内容が元の受付と一致しません");
  storage.setItem(key, record);
}

export function removePendingShare(storage, clientRequestId) {
  storage.removeItem(PREFIX + clientRequestId);
}

export function matchingShareReceipt(result, clientRequestId) {
  return result?.ok === true && result.stored === true && result.clientRequestId === clientRequestId;
}

export async function pendingShares(storage, parseLegacy) {
  const raw = storage.getItem(LEGACY_KEY);
  if (raw) {
    let legacy;
    try { legacy = JSON.parse(raw); } catch { /* Keep unrecognized data untouched. */ }
    const values = typeof legacy?.text === "string" ? parseLegacy(legacy.text) : [];
    if (values.length) {
      // Both tabs must use the same new ID if they migrate the same old record concurrently.
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
      const clientRequestId = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
      if (storage.getItem(LEGACY_KEY) === raw) {
        savePendingShare(storage, clientRequestId, values);
        storage.removeItem(LEGACY_KEY);
      }
    }
  }
  const records = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(PREFIX)) continue;
    let record;
    try { record = JSON.parse(storage.getItem(key)); } catch { continue; }
    if (validShareId(record?.clientRequestId) && key === PREFIX + record.clientRequestId &&
        Array.isArray(record.values) && record.values.length && record.values.every(value => typeof value === "string")) {
      records.push(record);
    }
  }
  return records;
}
