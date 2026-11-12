import { validShareId, savePendingShare, removePendingShare, matchingShareReceipt } from "./share-storage.js";
const $ = id => document.getElementById(id);
function shareId() {
  const params = new URLSearchParams(location.hash.slice(1));
  const existing = params.get("receipt");
  if (validShareId(existing)) return existing;
  const id = crypto.randomUUID();
  params.set("receipt", id);
  history.replaceState(null, "", "#" + params.toString());
  return id;
}

function cleanValue(value) {
  return String(value || "").trim().replace(/[.,;、。!?！？\])}]+$/, "");
}

function parseValues(text) {
  const values = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const urls = trimmed.match(/https:\/\/[^\s<>"']+/gi);
    if (urls?.length) values.push(...urls.map(cleanValue));
    else values.push(trimmed);
  }
  return [...new Set(values.filter(Boolean))];
}

function sharedText() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  const sources = [params.get("text"), params.get("url"), params.get("title")].filter(Boolean);
  for (const source of sources) {
    const values = parseValues(source);
    if (values.length) return { text: values.join("\n"), values };
  }
  return { text: "", values: [] };
}

function showState(label, type = "") {
  $("shareState").textContent = label;
  $("shareState").className = `share-state${type ? ` ${type}` : ""}`;
}

function displayCount(id, value) {
  const known = Number.isSafeInteger(value) && value >= 0;
  $(id).textContent = known ? `${value.toLocaleString("ja-JP")}件` : "未取得";
  $(id).classList.toggle("compact", !known || value >= 100);
}

function showReceipt(payload, total) {
  const { received, duplicate } = payload;
  const counted = Number.isSafeInteger(received) && received >= 0 &&
    Number.isSafeInteger(duplicate) && duplicate >= 0;
  // A durable receipt confirms zero intake errors only when all sent entries are accounted for.
  const errorCount = counted && received + duplicate === total ? 0 : null;
  displayCount("shareNew", received);
  displayCount("shareDuplicate", duplicate);
  displayCount("shareError", errorCount);
  $("shareState").classList.add("hidden");
  $("shareResults").classList.remove("hidden");
  const destination = payload.provisional ? "暫定保管" : "解析待ち";
  $("shareMessage").textContent = Number.isSafeInteger(received) && received >= 0
    ? `${received.toLocaleString("ja-JP")}件を${destination}へ登録しました。`
    : "受付済みです。新規件数を取得できませんでした。";
}

function holdForLogin() {
  showState("ログインが必要です", "waiting");
  $("shareMessage").textContent = "共有データを保持しました。管理画面でログインすると自動受付します。";
  $("shareLogin").classList.remove("hidden");
}

async function sendShared() {
  const { values } = sharedText();
  $("shareRetry").classList.add("hidden");
  $("shareLogin").classList.add("hidden");
  $("shareResults").classList.add("hidden");
  if (!values.length) {
    showState("URL・コードを取得できませんでした", "error");
    $("shareMessage").textContent = "共有元からデータが渡されていない可能性があります。";
    return;
  }

  const total = values.length.toLocaleString("ja-JP");
  $("shareTitle").textContent = `${total}件のデータ送信`;
  $("shareCount").textContent = `${total}件を受信`;
  $("shareValues").textContent = values.join("\n");
  $("shareValues").classList.remove("hidden");
  showState("サーバーへ送信中…");
  $("shareMessage").textContent = "";
  let saved = false;
  try {
    const clientRequestId = shareId();
    savePendingShare(localStorage, clientRequestId, values);
    saved = true;
    const response = await fetch("/api/receive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values, clientRequestId })
    });
    const payload = await response.json().catch(() => null);
    if (response.status === 401) return holdForLogin();
    if (!response.ok || !matchingShareReceipt(payload, clientRequestId)) {
      throw new Error(payload?.error || "受付結果を確認できませんでした");
    }
    removePendingShare(localStorage, clientRequestId);
    showReceipt(payload, values.length);
  } catch (error) {
    showState("送信結果を確認できませんでした", "error");
    $("shareMessage").textContent = `${error.message}。${saved ? "共有データは端末内に保持しています。" : "端末に保存できなかったため送信していません。"}`;
    $("shareRetry").classList.remove("hidden");
  }
}

$("shareRetry").onclick = sendShared;
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
sendShared();
