const $ = id => document.getElementById(id);
const state = { cursor: null, cardId: null, authenticated: false, pendingItems: new Map(), pendingResolve: null };

async function api(path, options) {
  const response = await fetch(path, options);
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401 && path !== "/api/auth/login") showLogin(payload.error || "ログインが必要です");
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `API error ${response.status}`);
  return payload;
}

function setMode(mode) {
  const trial = mode !== "production";
  document.querySelectorAll(".mode-badge").forEach(element => { element.textContent = trial ? "試用運用中" : "正式運用中"; });
  document.querySelector(".trial-notice")?.classList.toggle("hidden", !trial);
}

function showLogin(message = "") {
  state.authenticated = false;
  $("app").classList.add("hidden");
  $("loginScreen").classList.remove("hidden");
  $("loginMessage").textContent = message;
  $("loginPassword").value = "";
}

function showApp(mode) {
  state.authenticated = true;
  setMode(mode);
  $("loginScreen").classList.add("hidden");
  $("app").classList.remove("hidden");
}

async function login(event) {
  event.preventDefault();
  const password = $("loginPassword").value;
  $("loginButton").disabled = true;
  $("loginMessage").textContent = "確認中…";
  try {
    const result = await api("/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password })
    });
    showApp(result.mode);
    await load();
  } catch (error) {
    showLogin(error.message);
  } finally {
    $("loginPassword").value = "";
    $("loginButton").disabled = false;
  }
}

async function logout() {
  try { await api("/api/auth/logout", { method: "POST" }); }
  finally { showLogin("ログアウトしました"); }
}

async function boot() {
  try {
    const result = await api("/api/auth/status");
    setMode(result.mode);
    if (!result.configured) return showLogin("ログイン設定が未完了です");
    if (!result.authenticated) return showLogin();
    showApp(result.mode);
    await load();
  } catch (error) {
    showLogin(error.message);
  }
}

function esc(value = "") {
  return String(value).replace(/[&<>"']/g, char => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[char]);
}

function parseReceiveValues(text) {
  const values = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const urls = trimmed.match(/https:\/\/[^\s<>"']+/gi);
    if (urls?.length) values.push(...urls.map(value => value.replace(/[.,;、。\])}]+$/, "")));
    else values.push(trimmed);
  }
  return [...new Set(values)];
}

function showProgress(done, total, status = "解析中") {
  const remaining = Math.max(0, total - done);
  $("receiveProgress").classList.remove("hidden");
  $("progressStatus").textContent = status;
  $("progressCount").textContent = `${done.toLocaleString()} / ${total.toLocaleString()}件`;
  $("progressBar").max = Math.max(1, total);
  $("progressBar").value = done;
  $("progressDone").textContent = `${done.toLocaleString()}件`;
  $("progressRemaining").textContent = `${remaining.toLocaleString()}件`;
}

function clearReceive() {
  $("receiveInput").value = "";
  $("receiveResult").textContent = "";
  $("receiveProgress").classList.add("hidden");
  $("receiveInput").focus();
}

function pendingCard(item) {
  const image = item.image_data_uri
    ? `<img src="${esc(item.image_data_uri)}" alt="${esc(item.raw_name)}の商品画像">`
    : '<div class="image-tools"><div class="image-empty">画像なし</div><button class="secondary" data-action="reanalyze">画像を再取得</button></div>';
  return `<article class="pending-card" data-pending="${esc(item.id)}">
    ${image}<div class="pending-fields">
      <label>正式商品名<input name="raw_name" value="${esc(item.raw_name)}" readonly></label>
      <label>判定用商品名<input name="normalized_name" value="${esc(item.normalized_name)}" readonly></label>
      <label>画面表示名<input name="display_name" value="${esc(item.display_name)}" readonly></label>
      <div class="field-row"><label>容量・規格<input name="specification" value="${esc(item.specification)}" readonly></label>
      <label>利用先<input name="redeem_place" value="${esc(item.redeem_place)}" readonly></label></div>
      <label>使用期限<input name="expires_on" type="date" value="${esc(item.expires_on)}" readonly></label>
      <p class="waiting">同じ条件の確認待ち ${Number(item.item_count || 0).toLocaleString()}件</p>
      <button class="secondary copy-analysis" data-action="copy">ChatGPT用にコピー</button>
      <div class="confirm-actions"><button data-action="ok">OK</button><button class="secondary" data-action="edit">修正</button><button class="danger" data-action="cancel">キャンセル</button></div>
    </div></article>`;
}

function cardHtml(card) {
  return `<article class="coupon">
    <div><h3>${esc(card.display_name)}</h3><div class="meta">${esc(card.redeem_place)}${card.specification ? ` / ${esc(card.specification)}` : ""}</div>
    <div class="meta">期限 ${esc(card.expires_on || "期限なし")}</div></div>
    <div class="coupon-foot"><strong>${Number(card.count || 0).toLocaleString()}件</strong><button class="secondary" data-card="${esc(card.id)}" data-title="${esc(card.display_name)}">内容</button></div>
  </article>`;
}

async function load() {
  try {
    const [cards, pending, unresolved] = await Promise.all([api("/api/cards"), api("/api/pending"), api("/api/unresolved")]);
    const total = cards.cards.reduce((sum, card) => sum + Number(card.count || 0), 0);
    $("total").textContent = `${total.toLocaleString()}件`;
    $("pendingCount").textContent = `${pending.items.length.toLocaleString()}件`;
    $("unknown").textContent = `${unresolved.items.length.toLocaleString()}件`;
    $("unknownBottom").textContent = `${unresolved.items.length.toLocaleString()}件`;
    $("cards").innerHTML = cards.cards.length ? cards.cards.map(cardHtml).join("") : '<div class="empty">まだカードはありません</div>';
    $("pendingSection").classList.toggle("hidden", pending.items.length === 0);
    state.pendingItems = new Map(pending.items.map(item => [item.id, item]));
    $("pendingList").innerHTML = pending.items.map(pendingCard).join("");
    $("unknownList").innerHTML = unresolved.items.slice(0, 10).map(item =>
      `<div class="unknown-row"><span>${esc(item.reason)}</span><small>${esc(item.pattern_key || "未知パターン")} / 再解析 ${Number(item.retry_count || 0)}回</small></div>`).join("");
    bindDynamic();
  } catch (error) {
    $("cards").innerHTML = `<div class="empty error">${esc(error.message)}</div>`;
  }
}

function bindDynamic() {
  document.querySelectorAll("[data-card]").forEach(button => button.onclick = () => openItems(button.dataset.card, button.dataset.title));
  document.querySelectorAll("[data-pending]").forEach(bindPendingControls);
}

function bindPendingControls(card) {
  card.querySelector('[data-action="ok"]').onclick = () => submitConfirmation(card, "ok");
  card.querySelector('[data-action="cancel"]').onclick = () => {
    if (confirm("この確認待ちを未判定URLへ戻しますか？")) submitConfirmation(card, "cancel");
  };
  card.querySelector('[data-action="edit"]').onclick = event => {
    const editing = card.classList.toggle("editing");
    card.querySelectorAll("input").forEach(input => input.readOnly = !editing);
    event.currentTarget.textContent = editing ? "修正して確定" : "修正";
    if (!editing) submitConfirmation(card, "edit");
  };
  card.querySelector('[data-action="copy"]').onclick = event => copyPendingForChatGPT(card, event.currentTarget);
  const reanalyze = card.querySelector('[data-action="reanalyze"]');
  if (reanalyze) reanalyze.onclick = () => reanalyzePending(card, reanalyze);
}

async function copyPendingForChatGPT(card, button) {
  const value = name => card.querySelector(`[name="${name}"]`)?.value || "";
  const item = state.pendingItems.get(card.dataset.pending);
  const text = [
    "クーポン解析内容を確認してください。画像は画面のスクリーンショットを添付します。",
    `正式商品名: ${value("raw_name")}`,
    `判定用商品名: ${value("normalized_name")}`,
    `画面表示名: ${value("display_name")}`,
    `容量・規格: ${value("specification") || "なし"}`,
    `利用先: ${value("redeem_place")}`,
    `使用期限: ${value("expires_on")}`,
    `必要な商品条件: ${item?.required_conditions || "不明"}`,
    `商品画像: ${item?.image_data_uri ? "あり" : "なし"}`,
    "この内容で自動振り分け条件として問題ないか確認してください。"
  ].join("\n");
  try {
    await navigator.clipboard.writeText(text);
    const original = button.textContent;
    button.textContent = "コピーしました";
    setTimeout(() => { button.textContent = original; }, 1500);
  } catch {
    alert("コピーできませんでした。ブラウザのクリップボード権限を確認してください。");
  }
}

function finishPendingPause(action) {
  if ($("pendingDialog").open) $("pendingDialog").close();
  $("pendingDialogContent").innerHTML = "";
  const resolve = state.pendingResolve;
  state.pendingResolve = null;
  resolve?.(action);
}

async function pauseForPending(pendingId) {
  let pending = await api("/api/pending");
  let item = pending.items.find(candidate => candidate.id === pendingId);
  if (!item) return "missing";
  if (!item.image_data_uri) {
    try {
      $("progressStatus").textContent = "初回画像を取得中";
      await api(`/api/pending/${pendingId}/reanalyze`, { method:"POST" });
      pending = await api("/api/pending");
      item = pending.items.find(candidate => candidate.id === pendingId) || item;
    } catch {}
  }
  state.pendingItems.set(item.id, item);
  $("pendingDialogContent").innerHTML = pendingCard(item);
  bindPendingControls($("pendingDialogContent").querySelector("[data-pending]"));
  $("pendingDialog").showModal();
  return new Promise(resolve => { state.pendingResolve = resolve; });
}

async function reanalyzePending(card, button) {
  const inPauseDialog = Boolean(card.closest("#pendingDialog"));
  button.disabled = true;
  button.textContent = "取得中…";
  try {
    await api(`/api/pending/${card.dataset.pending}/reanalyze`, { method:"POST" });
    await load();
    if (inPauseDialog) {
      const pending = await api("/api/pending");
      const item = pending.items.find(candidate => candidate.id === card.dataset.pending);
      if (item) {
        state.pendingItems.set(item.id, item);
        $("pendingDialogContent").innerHTML = pendingCard(item);
        bindPendingControls($("pendingDialogContent").querySelector("[data-pending]"));
      }
    }
  } catch (error) {
    alert(error.message);
    button.disabled = false;
    button.textContent = "画像を再取得";
  }
}

async function submitConfirmation(card, action) {
  const buttons = [...card.querySelectorAll("button")];
  buttons.forEach(button => button.disabled = true);
  const body = { action };
  if (action === "edit") card.querySelectorAll("input[name]").forEach(input => body[input.name] = input.value);
  try {
    await api(`/api/pending/${card.dataset.pending}/confirm`, { method:"POST", headers:{ "content-type":"application/json" }, body:JSON.stringify(body) });
    const inPauseDialog = Boolean(card.closest("#pendingDialog"));
    await load();
    if (inPauseDialog) finishPendingPause(action);
  } catch (error) {
    alert(error.message);
    buttons.forEach(button => button.disabled = false);
  }
}

async function receive() {
  const values = parseReceiveValues($("receiveInput").value);
  if (!values.length) return;
  const controls = [$("receive"), $("paste"), $("clear")];
  controls.forEach(button => button.disabled = true);
  const totals = { received:0, duplicate:0, active:0, pending_confirmation:0, unresolved:0 };
  let done = 0;
  showProgress(0, values.length);
  $("receiveResult").textContent = "解析を開始しました…";
  try {
    for (let start = 0; start < values.length; start += 1) {
      const batch = values.slice(start, start + 1);
      const result = await api("/api/receive", { method:"POST", headers:{ "content-type":"application/json" }, body:JSON.stringify({ values:batch }) });
      totals.received += Number(result.received || 0);
      totals.duplicate += Number(result.duplicate || 0);
      for (const status of ["active", "pending_confirmation", "unresolved"]) totals[status] += Number(result.counts?.[status] || 0);
      done += batch.length;
      const newPending = result.items?.find(item => item.status === "pending_confirmation" && item.pendingId);
      showProgress(done, values.length, newPending ? "初回確認待ち" : done === values.length ? "解析完了" : "解析中");
      $("receiveResult").textContent = `受信 ${totals.received}件 / 重複 ${totals.duplicate}件 / 確認待ち ${totals.pending_confirmation}件 / 未判定 ${totals.unresolved}件`;
      if (newPending) {
        const action = await pauseForPending(newPending.pendingId);
        if (["ok", "edit"].includes(action)) { totals.pending_confirmation -= 1; totals.active += 1; }
        if (action === "cancel") { totals.pending_confirmation -= 1; totals.unresolved += 1; }
        showProgress(done, values.length, done === values.length ? "解析完了" : "解析中");
        $("receiveResult").textContent = `受信 ${totals.received}件 / 重複 ${totals.duplicate}件 / 確認待ち ${totals.pending_confirmation}件 / 未判定 ${totals.unresolved}件`;
      }
    }
    $("receiveInput").value = "";
    await load();
  } catch (error) {
    showProgress(done, values.length, "解析中断");
    $("receiveResult").textContent = `${error.message}（${done.toLocaleString()}件まで処理済み）`;
    if (done) await load();
  } finally { controls.forEach(button => button.disabled = false); }
}

async function retry() {
  $("retry").disabled = true;
  try {
    const result = await api("/api/unresolved/retry", { method:"POST" });
    alert(`${result.retried}件を再解析し、${result.resolved}件が未判定から移動しました。`);
    await load();
  } catch (error) { alert(error.message); }
  finally { $("retry").disabled = false; }
}

async function openItems(cardId, title) {
  state.cardId = cardId; state.cursor = null;
  $("dialogTitle").textContent = title;
  $("itemList").innerHTML = "";
  $("itemsDialog").showModal();
  await loadItems();
}

async function loadItems() {
  const query = new URLSearchParams({ limit:"50" });
  if (state.cursor) query.set("cursor", state.cursor);
  try {
    const result = await api(`/api/cards/${state.cardId}/items?${query}`);
    $("itemList").insertAdjacentHTML("beforeend", result.items.map(item => {
      const value = /^https:\/\//.test(item.value)
        ? `<a href="${esc(item.value)}" target="_blank" rel="noreferrer">開く</a>`
        : `<span class="code-value">${esc(item.value)}</span>`;
      return `<div class="item-row">${value}<button class="secondary copy-item" data-value="${esc(item.value)}">コピー</button></div>`;
    }).join(""));
    state.cursor = result.nextCursor;
    $("loadMore").classList.toggle("hidden", !state.cursor);
    document.querySelectorAll(".copy-item").forEach(button => button.onclick = () => navigator.clipboard.writeText(button.dataset.value));
  } catch (error) { $("itemList").textContent = error.message; }
}

$("receive").onclick = receive;
$("clear").onclick = clearReceive;
$("retry").onclick = retry;
$("paste").onclick = async () => {
  try { $("receiveInput").value = await navigator.clipboard.readText(); }
  catch { $("receiveResult").textContent = "入力欄を長押しして貼り付けてください。"; }
};
$("dialogClose").onclick = () => $("itemsDialog").close();
$("loadMore").onclick = loadItems;
$("loginForm").onsubmit = login;
$("logout").onclick = logout;
$("pendingDialog").addEventListener("cancel", event => event.preventDefault());
boot();
