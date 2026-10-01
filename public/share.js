const PENDING_SHARE_KEY = "winning-url-vault:pending-share";
const $ = id => document.getElementById(id);

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

function holdForLogin(text) {
  localStorage.setItem(PENDING_SHARE_KEY, JSON.stringify({ text, createdAt: Date.now() }));
  showState("ログインが必要です", "waiting");
  $("shareMessage").textContent = "共有データを保持しました。管理画面でログインすると自動受付します。";
  $("shareOpen").textContent = "ログインして送信";
  $("shareOpen").classList.remove("hidden");
}

async function sendShared() {
  const { text, values } = sharedText();
  $("shareRetry").classList.add("hidden");
  $("shareOpen").classList.add("hidden");
  if (!values.length) {
    showState("URL・コードを取得できませんでした", "error");
    $("shareMessage").textContent = "共有元からデータが渡されていない可能性があります。";
    $("shareOpen").classList.remove("hidden");
    return;
  }

  $("shareCount").textContent = `${values.length.toLocaleString()}件を受信`;
  $("shareValues").textContent = values.join("\n");
  $("shareValues").classList.remove("hidden");
  showState("サーバーへ送信中…");
  $("shareMessage").textContent = "";
  try {
    const response = await fetch("/api/receive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values, clientRequestId: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}` })
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) return holdForLogin(text);
    if (!response.ok || payload.ok === false) throw new Error(payload.error || `送信エラー ${response.status}`);
    localStorage.removeItem(PENDING_SHARE_KEY);
    const accepted = Number(payload.job?.accepted || values.length);
    showState("受付完了", "ok");
    $("shareMessage").textContent = `${accepted.toLocaleString()}件を解析待ちへ登録しました。`;
    $("shareOpen").classList.remove("hidden");
  } catch (error) {
    localStorage.setItem(PENDING_SHARE_KEY, JSON.stringify({ text, createdAt: Date.now() }));
    showState("送信できませんでした", "error");
    $("shareMessage").textContent = `${error.message}。共有データは端末内に保持しています。`;
    $("shareRetry").classList.remove("hidden");
    $("shareOpen").classList.remove("hidden");
  }
}

$("shareRetry").onclick = sendShared;
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
sendShared();
