const $ = id => document.getElementById(id);
const state = { cursor: null, cardId: null, authenticated: false, pendingItems: new Map(),
  activeJobId: null, pollTimer: null, refreshing: false, dialogPendingId: null };

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
    await resumeLatestJob();
    startPolling();
  } catch (error) {
    showLogin(error.message);
  } finally {
    $("loginPassword").value = "";
    $("loginButton").disabled = false;
  }
}

async function logout() {
  try { await api("/api/auth/logout", { method: "POST" }); }
  finally { stopPolling(); showLogin("ログアウトしました"); }
}

function openTrialReset() {
  $("trialResetConfirmation").value = "";
  $("trialResetMessage").textContent = "";
  $("confirmTrialReset").disabled = true;
  $("trialResetDialog").showModal();
  $("trialResetConfirmation").focus();
}

async function resetTrialData() {
  const button = $("confirmTrialReset");
  button.disabled = true;
  $("trialResetMessage").textContent = "削除中…";
  stopPolling();
  try {
    const result = await api("/api/trial/reset", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation: $("trialResetConfirmation").value })
    });
    state.activeJobId = null;
    state.dialogPendingId = null;
    $("receiveProgress").classList.add("hidden");
    $("receiveResult").textContent = `${Number(result.deleted || 0).toLocaleString()}件のURLデータを削除しました。`;
    if ($("pendingDialog").open) $("pendingDialog").close();
    $("trialResetDialog").close();
    await load();
  } catch (error) {
    $("trialResetMessage").textContent = error.message;
  } finally {
    button.disabled = $("trialResetConfirmation").value !== "完全削除";
    startPolling();
  }
}

async function boot() {
  try {
    const result = await api("/api/auth/status");
    setMode(result.mode);
    if (!result.configured) return showLogin("ログイン設定が未完了です");
    if (!result.authenticated) return showLogin();
    showApp(result.mode);
    await load();
    await resumeLatestJob();
    startPolling();
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
  return values;
}

function showJobProgress(job) {
  const total = Number(job.accepted || 0);
  const done = Number(job.processed || 0);
  const remaining = Math.max(0, total - done);
  const labels = { queued:"解析待ち", processing:"解析中", awaiting_confirmation:"解析完了・初回確認待ち", completed:"解析完了" };
  $("receiveProgress").classList.remove("hidden");
  $("progressStatus").textContent = labels[job.status] || "解析中";
  $("progressCount").textContent = `${done.toLocaleString()} / ${total.toLocaleString()}件`;
  $("progressBar").max = Math.max(1, total);
  $("progressBar").value = total ? done : 1;
  $("progressDone").textContent = `${done.toLocaleString()}件`;
  $("progressActive").textContent = `${Number(job.processing || 0).toLocaleString()}件`;
  $("progressRemaining").textContent = `${remaining.toLocaleString()}件`;
  $("acceptanceSummary").innerHTML = [
    ["貼り付け", job.inputTotal], ["解析対象", job.accepted],
    ["貼付内重複", job.inputDuplicates], ["既に登録済み", job.existing],
    ["カード保管", job.active], ["確認待ちURL", job.pendingConfirmation]
  ].map(([label, value]) => `<span>${label} <strong>${Number(value || 0).toLocaleString()}件</strong></span>`).join("");
  $("receiveResult").textContent = job.lastError
    ? `前回エラー: ${job.lastError}（自動再試行します）`
    : `受付 ${Number(job.inputTotal || 0).toLocaleString()}件 / 貼付内重複 ${Number(job.inputDuplicates || 0).toLocaleString()}件 / 既登録 ${Number(job.existing || 0).toLocaleString()}件`;
}

function clearReceive() {
  $("receiveInput").value = "";
  $("receiveResult").textContent = "";
  if (!state.activeJobId) $("receiveProgress").classList.add("hidden");
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
      <p class="waiting">完全一致グループ ${Number(item.item_count || 0).toLocaleString()}件（残りの解析は継続中）</p>
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
    syncPendingDialog(pending.items);
  } catch (error) {
    $("cards").innerHTML = `<div class="empty error">${esc(error.message)}</div>`;
  }
}

function bindDynamic() {
  document.querySelectorAll("[data-card]").forEach(button => button.onclick = () => openItems(button.dataset.card, button.dataset.title));
  document.querySelectorAll("[data-pending]").forEach(bindPendingControls);
}

function syncPendingDialog(items) {
  if ($("pendingDialog").open) {
    const current = items.find(item => item.id === state.dialogPendingId);
    if (!current) {
      $("pendingDialog").close();
      state.dialogPendingId = null;
    } else if (!$("pendingDialogContent").querySelector(".editing")) {
      $("pendingDialogContent").innerHTML = pendingCard(current);
      bindPendingControls($("pendingDialogContent").querySelector("[data-pending]"));
    }
  }
  if (!$("pendingDialog").open && items.length) {
    const item = items[0];
    state.dialogPendingId = item.id;
    $("pendingDialogContent").innerHTML = pendingCard(item);
    bindPendingControls($("pendingDialogContent").querySelector("[data-pending]"));
    $("pendingDialog").showModal();
  }
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
    if (inPauseDialog && $("pendingDialog").open) {
      $("pendingDialog").close();
      $("pendingDialogContent").innerHTML = "";
      state.dialogPendingId = null;
    }
    await load();
    await loadJob();
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
  $("receiveProgress").classList.remove("hidden");
  $("progressStatus").textContent = "全件を受付中";
  $("progressCount").textContent = `${values.length.toLocaleString()}件`;
  $("receiveResult").textContent = "貼付内重複と既登録を確認しています…";
  try {
    const requestId = crypto.randomUUID();
    const result = await api("/api/receive", { method:"POST", headers:{ "content-type":"application/json" },
      body:JSON.stringify({ values, clientRequestId:requestId }) });
    state.activeJobId = result.job.id;
    $("receiveInput").value = "";
    showJobProgress(result.job);
    await load();
    await loadJob();
  } catch (error) {
    $("progressStatus").textContent = "受付失敗";
    $("receiveResult").textContent = error.message;
  } finally { controls.forEach(button => button.disabled = false); }
}

async function loadJob() {
  const result = await api(state.activeJobId ? `/api/jobs/${state.activeJobId}` : "/api/jobs/latest");
  if (!result.job) return;
  state.activeJobId = result.job.id;
  showJobProgress(result.job);
}

async function resumeLatestJob() {
  try { await loadJob(); } catch (error) { console.warn("job resume", error); }
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(async () => {
    if (!state.authenticated || state.refreshing) return;
    state.refreshing = true;
    try { await Promise.all([loadJob(), load()]); }
    catch (error) { console.warn("refresh", error); }
    finally { state.refreshing = false; }
  }, 2500);
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
$("openTrialReset").onclick = openTrialReset;
$("cancelTrialReset").onclick = () => $("trialResetDialog").close();
$("trialResetConfirmation").oninput = event => {
  $("confirmTrialReset").disabled = event.currentTarget.value !== "完全削除";
};
$("confirmTrialReset").onclick = resetTrialData;
$("pendingDialog").addEventListener("cancel", event => event.preventDefault());
boot();
