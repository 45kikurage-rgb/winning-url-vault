import { nameUnits, validateDisplayName, nameFits } from './display-name.js';
import { DEFAULT_VIEW, normalizeView, attentionReasons, orderWinningItems, expiryLabel, selectWinningItems } from './winning-view.js';
import { currentWinningMonth, winningMonth, winningMonthLabel, groupWinningFolders } from './winning-folders.js';
import { predictAssignmentCampaign } from './assignment-prediction.js';
import { analysisAmount, isEraberuPay } from './analysis-amount.js';
import { initProvisionalUI, refreshProvisionalUI } from "./provisional-ui.js";
import { fetchReadWithRetry } from "./network-read.js";
import { loginWithDeviceKey, prepareDevicePairing, finishDevicePairing } from "./device-login.js";

const $ = id => document.getElementById(id);
const winningFolderOpen = new Map();
const balanceRechecks = new Map();
let winningFolderMonth = currentWinningMonth();
const WINNING_VIEW_KEY = 'winning-url-vault:winning-view';
let winningView = { ...DEFAULT_VIEW };
try { winningView = normalizeView(JSON.parse(localStorage.getItem(WINNING_VIEW_KEY) || '{}')); } catch {}
let winningOrder = [], winningRequest = 0, winningLoaded = false, closedManuallyOpen = false;
let recheckConfirmProductId = null;
let contentsProductId = null, contentsCursor = null, contentsLoading = false, contentsGeneration = 0;
const displayNames = new Map();
let displayNamesLoaded, editingName, campaignFilter = 'all';
function displayLabel(scope,id,fallback) { return displayNames.get(`${scope}:${id}`) || fallback || '商品名未取得'; }
async function loadDisplayNames() {
  if (!displayNamesLoaded) displayNamesLoaded = api('/api/display-names').then(result => {
    for (const row of result.names || []) displayNames.set(`${row.scope}:${row.target_id}`,row.display_name);
  }).catch(error => { displayNamesLoaded = null; throw error; });
  return displayNamesLoaded;
}
function tabDot(id,count,label) {
  $(id).classList.toggle('hidden',count === 0);
  $(id).closest('button').setAttribute('aria-label',`${label}${count > 0 ? '・項目あり' : '・項目なし'}`);
}
function displayNameField(scope,id) {
  return [...document.querySelectorAll('[data-name-scope]')].find(el => el.dataset.nameScope === scope && el.dataset.nameId === id);
}
async function openDisplayName(scope,id) {
  const item = scope === 'sorting' ? state.cards.get(id) : winningProduct(id);
  const field = displayNameField(scope,id);
  if (!item || !field?.getClientRects().length) return;
  editingName = {scope,id};
  $('displayNameTitle').textContent = scope === 'sorting' ? '仕分けの表示名' : '当選の表示名';
  $('displayNameFormal').textContent = `正式名：${item.raw_name || item.product_name || item.display_name}`;
  $('displayNameInput').value = displayLabel(scope,id,item.display_name || item.product_name);
  $('displayNameDialog').showModal();
  await document.fonts.ready;
  checkDisplayName();
}
function checkDisplayName() {
  if (!editingName) return false;
  const value = $('displayNameInput').value.trim(), field = displayNameField(editingName.scope,editingName.id);
  const preview = $('displayNamePreview').firstElementChild;
  preview.textContent = value;
  const style = field && getComputedStyle(field);
  if (style) { preview.style.font = style.font; preview.style.letterSpacing = style.letterSpacing; }
  const error = validateDisplayName(value) || (!nameFits(field,value) ? '現在の一覧の幅に収まりません。表示名を短くしてください。' : '');
  // The preview uses its own real dimensions; it never ellipsizes to imply a pass.
  $('displayNameMessage').textContent = error || `${nameUnits(value)}／14文字相当・一覧の1行幅に収まります。`;
  $('displayNameSave').disabled = Boolean(error);
  return !error;
}
async function saveDisplayAlias() {
  await document.fonts.ready;
  if (!checkDisplayName()) return;
  const {scope,id} = editingName, value = $('displayNameInput').value.trim();
  $('displayNameSave').disabled = true;
  try {
    await api(`/api/display-names/${scope}/${id}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({display_name:value})});
    displayNames.set(`${scope}:${id}`,value);
    $('displayNameDialog').close();
    if (scope === 'winning') renderWinningLists(); else await load();
  } catch(error) { $('displayNameMessage').textContent = error.message; $('displayNameSave').disabled = false; }
}
const winningNodes = new Map(), winningGroups = new Map();
const PENDING_SHARE_KEY = "winning-url-vault:pending-share";
const LAST_EXPORT_BATCH_KEY = "winning-url-vault:last-export-batch";
const OUTPUT_METHOD_LABELS = { unset:"未設定", normal:"通常URL", cokeon:"コークオン",
  wallet:"えらべるPay", paypay:"PayPay", text_single:"文字列" };
const state = { cursor: null, cardId: null, authenticated: false, cards: new Map(), pendingItems: new Map(),
  activeJobId: null, dismissedJobId: null, progressHideJobId: null, progressHideTimer: null, pollTimer: null, refreshing: false, dialogPendingId: null,
  campaigns: [], assignmentCardId: null, assignmentPreview: null, closeCampaignId: null,
  correctionCampaignId: null, winningLists: [], outputProductId: null, exportProductId: null, reassignProductId:null, reassignPreview:null,
  exportItem: null, exportBatch: null, pendingExportBatch: null, exportPaypayKind: null, deviceOnlyMode: false,
  unresolvedItems: new Map(), imageAnalysisItemId: null, couponImageData: null, cardsLoaded: false };

async function api(path, options) {
  const response = await fetchReadWithRetry(fetch, path, options);
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401 && path !== "/api/auth/login") showLogin(payload.error || "ログインが必要です");
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.error || `API error ${response.status}`);
    error.code = payload.code || "API_ERROR";
    error.details = payload.details || {};
    error.status = response.status;
    throw error;
  }
  return payload;
}

function setMode(mode) {
  const trial = mode !== "production";
  document.body.dataset.operationMode = trial ? "trial" : "production";
  document.querySelectorAll(".mode-badge").forEach(element => { element.textContent = trial ? "試用運用中" : "正式運用中"; });
  document.querySelector(".trial-notice")?.classList.toggle("hidden", !trial);
}

function switchTab(name) {
  const names = ["receive", "sorting", "winning", "campaigns"];
  const selected = names.includes(name) ? name : "receive";
  document.body.dataset.activeTab = selected;
  for (const item of names) {
    $(`tab${item[0].toUpperCase()}${item.slice(1)}`).classList.toggle("hidden", item !== selected);
  }
  document.querySelectorAll("[data-tab]").forEach(button => button.classList.toggle("active", button.dataset.tab === selected));
  try { localStorage.setItem("winning-url-vault:tab", selected); } catch {}
  if (selected === "winning") loadWinningLists();
  if (selected === "sorting") {
    refreshProvisionalUI().catch(error => console.warn("provisional refresh", error));
    void load();
  }
}

async function loadRevenueSummary() {
  const panel = $("headerRevenue");
  try {
    const result = await api("/api/revenue/summary");
    panel.classList.remove("is-error");
    $("headerMonthlyRevenue").textContent = `${Number(result.monthly_revenue || 0).toLocaleString()}円`;
    $("headerDailyRevenue").textContent = `${Number(result.daily_revenue || 0).toLocaleString()}円`;
    const unpriced = Number(result.unpriced_month_count || 0);
    panel.classList.toggle("has-unpriced", unpriced > 0);
    $('revenueNotice').textContent = unpriced > 0 ? `単価未設定 ${unpriced.toLocaleString()}件：収益に未計上の分があります。` : '';
    $('revenueNotice').classList.toggle('hidden',unpriced === 0);
    panel.title = unpriced > 0 ? `単価未設定 ${unpriced.toLocaleString()}件は収益に含まれていません` : `${result.month} / ${result.date}（JST）`;
  } catch (error) {
    $("headerMonthlyRevenue").textContent = "—";
    $("headerDailyRevenue").textContent = "—";
    panel.classList.add("is-error");
    $('revenueNotice').textContent = `収益を取得できませんでした：${error.message}`;
    $('revenueNotice').classList.remove('hidden');
    panel.title = error.message;
  }
}

function showLogin(message = "") {
  state.authenticated = false;
  $("app").classList.add("hidden");
  $("loginScreen").classList.remove("hidden");
  $("loginForm").classList.toggle("hidden", state.deviceOnlyMode);
  $("deviceLoginButton").classList.toggle("hidden", !state.deviceOnlyMode);
  $("loginMessage").textContent = message;
  $("deviceLoginMessage").textContent = message;
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
    await Promise.all([load(), loadCampaigns(), loadWinningLists(), loadRevenueSummary(), initProvisionalUI(api, async () => { await load(); await loadWinningLists(); })]);
    await resumeLatestJob();
    await resumePendingShare();
    await restorePendingExport();
    try { switchTab(localStorage.getItem("winning-url-vault:tab") || "receive"); } catch { switchTab("receive"); }
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
    await Promise.all([load(), loadCampaigns()]);
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
    state.deviceOnlyMode = Boolean(result.deviceOnlyMode);
    if (!result.configured) return showLogin("ログイン設定が未完了です");
    if (!result.authenticated) {
      if (state.deviceOnlyMode) {
        try {
          if (await loginWithDeviceKey()) return boot();
        } catch (error) {
          return showLogin(error.message);
        }
      }
      return showLogin();
    }
    showApp(result.mode);
    await Promise.all([load(), loadCampaigns(), loadWinningLists(), loadRevenueSummary(), initProvisionalUI(api, async () => { await load(); await loadWinningLists(); })]);
    await resumeLatestJob();
    await resumePendingShare();
    await restorePendingExport();
    try { switchTab(localStorage.getItem("winning-url-vault:tab") || "receive"); } catch { switchTab("receive"); }
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
  const labels = { queued:"解析待ち", processing:"解析中", finalizing:"照合・登録中",
    awaiting_confirmation:"解析完了・初回確認待ち", completed:"解析完了" };
  if (job.status === "completed" && state.dismissedJobId === job.id) {
    $("receiveProgress").classList.add("hidden");
    return;
  }
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
    ["カード保管", job.active], ["確認待ちURL", job.pendingConfirmation], ["使用済み", job.used]
  ].map(([label, value]) => `<span>${label} <strong>${Number(value || 0).toLocaleString()}件</strong></span>`).join("");
  $("receiveResult").textContent = job.lastError
    ? `前回エラー: ${job.lastError}（自動再試行します）`
    : `受付 ${Number(job.inputTotal || 0).toLocaleString()}件 / 貼付内重複 ${Number(job.inputDuplicates || 0).toLocaleString()}件 / 既登録 ${Number(job.existing || 0).toLocaleString()}件`;
  if (job.status === "completed") {
    if (state.progressHideJobId !== job.id) {
      if (state.progressHideTimer) clearTimeout(state.progressHideTimer);
      state.progressHideJobId = job.id;
      state.progressHideTimer = setTimeout(() => {
        if (state.activeJobId !== job.id) return;
        state.dismissedJobId = job.id;
        state.activeJobId = null;
        $("receiveProgress").classList.add("hidden");
        $("receiveResult").textContent = "";
        state.progressHideJobId = null;
        state.progressHideTimer = null;
      }, 4000);
    }
  } else {
    if (state.progressHideTimer) clearTimeout(state.progressHideTimer);
    state.progressHideJobId = null;
    state.progressHideTimer = null;
  }
}

function clearReceive() {
  $("receiveInput").value = "";
  $("receiveResult").textContent = "";
  if (!state.activeJobId) $("receiveProgress").classList.add("hidden");
  $("receiveInput").focus();
}

function pendingCard(item) {
  const amount = analysisAmount(item);
  const image = item.image_data_uri
    ? `<img src="${esc(item.image_data_uri)}" alt="${esc(item.raw_name)}の商品画像">`
    : '<div class="image-tools"><div class="image-empty">画像なし</div><button class="secondary" data-action="reanalyze">画像を再取得</button></div>';
  return `<article class="pending-card" data-pending="${esc(item.id)}">
    ${image}<div class="pending-fields">
      <label>正式商品名<input name="raw_name" value="${esc(item.raw_name)}" readonly></label>
      <label>判定用商品名<input name="normalized_name" value="${esc(item.normalized_name)}" readonly></label>
      <label>画面表示名<input name="display_name" value="${esc(item.display_name)}" readonly></label>
      <div class="field-row"><label>容量・規格・金額<input name="specification" value="${esc(item.specification)}" placeholder="規格なし" readonly>${amount ? `<span class="meta" data-analysis-amount>${esc(amount)}</span>` : ""}</label>
      <label>利用先<input name="redeem_place" value="${esc(item.redeem_place)}" readonly></label></div>
      ${isEraberuPay(item) ? "" : `<label>使用期限<input name="expires_on" type="date" value="${esc(item.expires_on)}" readonly></label>`}
      <p class="waiting">完全一致グループ ${Number(item.item_count || 0).toLocaleString()}件（残りの解析は継続中）</p>
      <button class="secondary copy-analysis" data-action="copy">ChatGPT用にコピー</button>
      <div class="confirm-actions"><button data-action="ok">OK</button><button class="secondary" data-action="edit">修正</button><button class="danger" data-action="cancel">キャンセル</button></div>
    </div></article>`;
}

function cardHtml(card) {
  const assignments = (card.assignments || []).map(item => `<div class="assignment-row">
    <span>${esc(item.campaign_name || item.campaign_id)}　${esc(item.lottery_start_date || "")}</span>
    <strong>${Number(item.current_winner_count || 0).toLocaleString()}件</strong>
    <small class="sync-${esc(item.sync_status || "pending")}">${item.sync_status === "sent" ? "同期済み" : item.sync_status === "failed" ? "同期失敗" : "同期待ち"}</small>
  </div>`).join("");
  return `<article class="coupon">
    <div><h3 data-name-scope="sorting" data-name-id="${esc(card.id)}" title="${esc(card.raw_name || card.display_name)}">${esc(displayLabel('sorting',card.id,card.display_name))}</h3><div class="meta sorting-spec">${esc(card.specification || '規格未設定')}／${esc(card.redeem_place)}</div>
    ${isEraberuPay(card) ? "" : `<div class="meta">期限 ${esc(card.expires_on || "期限なし")}</div>`}${(card.assignments || []).some(row=>row.sync_status==='failed') ? '<p class="sync-error">同期失敗あり：割当内訳を確認してください。</p>' : ''}${assignments ? `<details class="assignment-list"><summary>割当済み${(card.assignments || []).reduce((sum,row)=>sum+Number(row.current_winner_count || 0),0).toLocaleString()}件／${esc(card.assignments[0].campaign_name || card.assignments[0].campaign_id)}</summary>${assignments}</details>` : '<div class="unassigned-label">解析済み・未仕分け</div>'}</div>
    <div class="coupon-foot"><div class="card-actions">
      ${Number(card.unassigned_count || 0) > 0 ? `<button data-assign-card="${esc(card.id)}" data-title="${esc(card.display_name)}">振り分け（${Number(card.unassigned_count).toLocaleString()}）</button>` : ""}
      <button class="secondary" data-edit-sorting-name="${esc(card.id)}">表示名</button><button class="secondary" data-card="${esc(card.id)}" data-title="${esc(card.display_name)}">内容</button></div></div>
  </article>`;
}

function renderSortingCards(cards) {
  const container = $('cards'), port = $('tabSorting'), scrollTop = port.scrollTop;
  const current = new Map([...container.querySelectorAll(':scope > [data-sorting-card]')].map(node=>[node.dataset.sortingCard,node]));
  const next = cards.map(card=>{
    let node = current.get(card.id);
    const html = cardHtml(card);
    if (!node) {node=document.createElement('div');node.dataset.sortingCard=card.id;}
    if (node._cardHtml !== html) {
      const opened = Boolean(node.querySelector('.assignment-list')?.open);
      node.innerHTML = html;node._cardHtml=html;
      if (opened && node.querySelector('.assignment-list')) node.querySelector('.assignment-list').open=true;
    }
    return node;
  });
  if (next.length) syncWinningChildren(container,next);
  else container.innerHTML='<div class="empty">仕分け待ちのカードはありません</div>';
  port.scrollTop=scrollTop;
}
async function load() {
  try {
    await loadDisplayNames();
    const [cards, pending, unresolved, usage] = await Promise.all([api("/api/cards"), api("/api/pending"), api("/api/unresolved"), api("/api/usage")]);
    renderUsedCount(usage.usedIds);
    const total = cards.cards.reduce((sum, card) => sum + Number(card.count || 0), 0);
    $("total").textContent = `${total.toLocaleString()}件`;
    $("pendingCount").textContent = `${pending.items.length.toLocaleString()}件`;
    $("unknown").textContent = `${unresolved.items.length.toLocaleString()}件`;
    $("unknownBottom").textContent = `${unresolved.items.length.toLocaleString()}件`;
    const sortingCards = cards.cards.filter(card => Number(card.unassigned_count || 0) > 0);
    state.cards = new Map(cards.cards.map(card => [card.id, card]));
    const sortingCount = sortingCards.reduce((sum, card) => sum + Number(card.unassigned_count || 0), 0);
    tabDot('sortingTabCount',sortingCount,'仕分け');
    $('sortingMetric').textContent = `未仕分け ${sortingCount.toLocaleString()}件（URL・コード）`;
    $('pendingBanner').classList.toggle('hidden',pending.items.length === 0);
    $('pendingBanner').textContent = `初回確認 ${pending.items.length.toLocaleString()}グループを確認する`;
    renderSortingCards(sortingCards);
    $("pendingSection").classList.toggle("hidden", pending.items.length === 0);
    state.pendingItems = new Map(pending.items.map(item => [item.id, item]));
    if (!$("pendingList").querySelector(".editing")) $("pendingList").innerHTML = pending.items.map(pendingCard).join("");
    $("unknownList").innerHTML = unresolved.items.map(item => {
      const openUrl = item.openUrl || item.value;
      const open = /^https?:\/\//i.test(openUrl)
        ? `<a class="secondary unknown-open" href="${esc(openUrl)}" target="_blank" rel="noreferrer">開く</a>` : "";
      const imageAnalysis = /^https?:\/\//i.test(openUrl)
        ? `<button data-image-unresolved="${esc(item.id)}">画像で判定</button>` : "";
      return `<div class="unknown-row"><span>${esc(item.reason)}</span><details><summary>受信内容を確認</summary><div class="unknown-value">${esc(item.value)}</div></details><div class="unknown-actions">${open}${imageAnalysis}<button class="secondary" data-copy-unresolved="${esc(item.id)}">コピー</button><button class="danger" data-delete-unresolved="${esc(item.id)}">削除</button></div><small>${esc(item.pattern_key || "未知パターン")} / 再解析 ${Number(item.retry_count || 0)}回</small></div>`;
    }).join("");
    const unresolvedById = new Map(unresolved.items.map(item => [item.id, item]));
    state.unresolvedItems = unresolvedById;
    document.querySelectorAll("[data-image-unresolved]").forEach(button => button.onclick = () => openImageAnalysis(button.dataset.imageUnresolved));
    document.querySelectorAll("[data-copy-unresolved]").forEach(button => button.onclick = async () => {
      await writeClipboard(unresolvedById.get(button.dataset.copyUnresolved)?.value || "");
      button.textContent = "コピー済み";
    });
    document.querySelectorAll("[data-delete-unresolved]").forEach(button => button.onclick = async () => {
      if (!confirm("この未判定データ1件を削除しますか？")) return;
      button.disabled = true;
      try { await api(`/api/unresolved/${button.dataset.deleteUnresolved}`, { method:"DELETE" }); await load(); }
      catch (error) { alert(error.message); button.disabled = false; }
    });
    bindDynamic();
    syncPendingDialog(pending.items);
    state.cardsLoaded = true;
    $("sortingLoadStatus").classList.add("hidden");
    $("retrySortingLoad").classList.add("hidden");
  } catch (error) {
    // A transient network failure is not a failure of the saved cards.
    // Keep the last successful DOM and retry after returning to the app.
    if (!state.authenticated) return;
    console.warn("Sorting list temporarily unavailable", error);
    if (!state.cardsLoaded) $("cards").innerHTML = '<div class="empty">通信復帰後にカードを再取得します。</div>';
    $("sortingLoadStatus").textContent = "一時的に通信できません。前回のカード表示は保持しています。接続復帰時に自動再取得します。";
    $("sortingLoadStatus").classList.remove("hidden");
    $("retrySortingLoad").classList.remove("hidden");
  }
}

function resetImageAnalysis() {
  state.couponImageData = null;
  $("couponImageFile").value = "";
  $("couponImagePreview").innerHTML = "<span>画像未選択</span>";
  $("imageAnalysisMessage").textContent = "";
  $("imageAnalysisFields").classList.add("hidden");
  $("reanalyzeCouponImage").classList.add("hidden");
  $("confirmCouponImage").classList.add("hidden");
  for (const id of ["imageProductName", "imageDisplayName", "imageRedeemPlace", "imageSpecification", "imageExpiresOn"]) $(id).value = "";
}

function openImageAnalysis(itemId) {
  const item = state.unresolvedItems.get(itemId);
  if (!item) return;
  state.imageAnalysisItemId = itemId;
  resetImageAnalysis();
  $("imageAnalysisUrl").textContent = item.value;
  $("imageAnalysisDialog").showModal();
}

async function imageToDataUri(file) {
  if (!file || !/^image\/(?:png|jpeg|webp)$/i.test(file.type)) throw new Error("PNG・JPEG・WebPの画像を選択してください");
  if (file.size > 12_000_000) throw new Error("画像が大きすぎます");
  const bitmap = await createImageBitmap(file);
  const max = 1600;
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  canvas.getContext("2d", { alpha:false }).drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const data = canvas.toDataURL("image/jpeg", 0.88);
  if (data.length > 3_000_000) throw new Error("画像を縮小できませんでした。別の画像を選択してください");
  return data;
}

async function setCouponImage(file) {
  try {
    const data = await imageToDataUri(file);
    state.couponImageData = data;
    $("couponImagePreview").innerHTML = `<img src="${data}" alt="判定するスクリーンショット">`;
    await analyzeSelectedImage();
  } catch (error) {
    $("imageAnalysisMessage").textContent = error.message;
  }
}

async function pasteCouponImage() {
  $("imageAnalysisMessage").textContent = "";
  try {
    if (!navigator.clipboard?.read) throw new Error("この端末では画像貼り付けを使えません。「画像を選択」を押してください");
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = item.types.find(value => /^image\/(?:png|jpeg|webp)$/i.test(value));
      if (type) return setCouponImage(await item.getType(type));
    }
    throw new Error("クリップボードに画像がありません");
  } catch (error) {
    $("imageAnalysisMessage").textContent = error.message;
  }
}

async function analyzeSelectedImage() {
  if (!state.couponImageData || !state.imageAnalysisItemId) return;
  $("imageAnalysisDialog").classList.add("image-analysis-working");
  $("imageAnalysisMessage").textContent = "画像を読み取っています…";
  $("reanalyzeCouponImage").disabled = true;
  try {
    const result = await api(`/api/unresolved/${state.imageAnalysisItemId}/image-analyze`, {
      method:"POST", headers:{ "content-type":"application/json" }, body:JSON.stringify({ image:state.couponImageData })
    });
    const proposal = result.proposal || {};
    $("imageProductName").value = proposal.productName || "";
    $("imageDisplayName").value = proposal.displayName || proposal.productName || "";
    $("imageRedeemPlace").value = proposal.redeemPlace || "";
    $("imageSpecification").value = proposal.specification || "";
    $("imageExpiresOn").value = proposal.expiresOn || "";
    $("imageAnalysisFields").classList.remove("hidden");
    $("reanalyzeCouponImage").classList.remove("hidden");
    $("confirmCouponImage").classList.remove("hidden");
    $("imageAnalysisMessage").textContent = "読取結果を確認してください。違う箇所は修正できます。";
  } catch (error) {
    $("reanalyzeCouponImage").classList.remove("hidden");
    $("imageAnalysisMessage").textContent = error.message;
  } finally {
    $("imageAnalysisDialog").classList.remove("image-analysis-working");
    $("reanalyzeCouponImage").disabled = false;
  }
}

async function confirmSelectedImage() {
  if (!state.imageAnalysisItemId) return;
  const button = $("confirmCouponImage");
  button.disabled = true;
  $("imageAnalysisMessage").textContent = "この1件を確定しています…";
  const body = {
    product_name: $("imageProductName").value,
    display_name: $("imageDisplayName").value,
    redeem_place: $("imageRedeemPlace").value,
    specification: $("imageSpecification").value,
    expires_on: $("imageExpiresOn").value
  };
  try {
    await api(`/api/unresolved/${state.imageAnalysisItemId}/image-confirm`, {
      method:"POST", headers:{ "content-type":"application/json" }, body:JSON.stringify(body)
    });
    $("imageAnalysisDialog").close();
    state.imageAnalysisItemId = null;
    resetImageAnalysis();
    await load();
  } catch (error) {
    $("imageAnalysisMessage").textContent = error.message;
  } finally { button.disabled = false; }
}

function methodLabel(method) {
  return OUTPUT_METHOD_LABELS[method] || method || "未設定";
}

function winningCardHtml(item) {
  const id = esc(item.product_id), remaining = Number(item.unexported_count || 0);
  const unset = !item.output_method || item.output_method === 'unset';
  const recheck = balanceRechecks.get(item.product_id);
  const reasons = attentionReasons(item);
  const name = displayLabel('winning',item.product_id,item.display_name || item.product_name);
  return `<div class="product-heading"><h3 data-name-scope="winning" data-name-id="${id}" title="${esc(item.product_name || name)}">${esc(name)}</h3><span class="product-total">合計${Number(item.total_count || 0).toLocaleString()}件</span></div>
    ${winningView.showCampaign ? `<div class="product-campaign">${esc(item.campaign_name || item.campaign_id)} · ${esc(item.lottery_start_date || '開始日未取得')}</div>` : ''}
    <div class="product-body"><div class="product-meta"><span class="product-spec-place">${esc(item.product_spec || '規格未設定')}／${esc(item.redemption_place || '引換先未取得')}</span><span>${esc(expiryLabel(item,winningView.relativeDates))}</span>${item.show_in_permanent ? '<span>常設</span>' : ''}</div>
    <div class="product-controls"><small class="product-method">${esc(methodLabel(item.output_method))}</small><div class="product-actions"><button class="extract-button${remaining > 999 ? ' wide-count' : ''}" data-export-product="${id}" ${unset || remaining === 0 ? 'disabled' : ''}><span>未抽出</span><strong>${remaining.toLocaleString()}</strong><span>件</span></button><button class="secondary product-settings" data-method-product="${id}" aria-label="${esc(name)}の設定">設定</button></div></div></div>
    ${item.manual_finished && item.campaign_status !== 'closed' ? '<div class="product-notes">手動で終了済みへ移動</div>' : ''}${reasons.length ? `<div class="product-notes">${esc(reasons.join(' / '))}</div>` : ''}
    ${isEraberuPay(item) ? `<div class="product-recheck"><span data-balance-message="${id}" role="status">${esc(recheck?.message || '再解析は設定から')}</span>${recheck?.running ? `<button class="secondary" data-stop-recheck="${id}">再解析を中断</button>` : ''}</div>` : ''}`;
}

function productContext(item) {
  if (!item) return '商品情報を取得できません。一覧を再読み込みしてください。';
  return [item.display_name || item.product_name, item.product_spec, item.redemption_place || '引換先未取得', expiryLabel(item), `CP：${item.campaign_name || item.campaign_id}`, `開始日：${item.lottery_start_date || '未取得'}`].filter(Boolean).join(' / ');
}

function syncWinningChildren(parent, nodes) {
  nodes.forEach((node,index) => { if (parent.children[index] !== node) parent.insertBefore(node,parent.children[index] || null); });
  while (parent.children.length > nodes.length) parent.lastElementChild.remove();
}
function renderWinningSection(parent, items, scope) {
  const row = item => {
    let node = winningNodes.get(item.product_id);
    if (!node) { node = document.createElement('article'); node.dataset.productId = item.product_id; winningNodes.set(item.product_id,node); }
    node.className = `winning-card winning-product-row${item.output_method === 'unset' ? ' is-unset' : ''}`;
    const html = winningCardHtml(item);
    if (node._winningHtml !== html) { node.innerHTML = html; node._winningHtml = html; }
    return node;
  };
  if (!items.length) {
    let empty = parent.querySelector(':scope > .empty');
    if (!empty) { empty = document.createElement('div'); empty.className = 'empty'; }
    empty.textContent = winningLoaded ? '該当する商品はありません' : '当選リスト読み込み待ち';
    syncWinningChildren(parent,[empty]); return;
  }
  if (winningView.grouping !== 'month') { syncWinningChildren(parent,items.map(row)); return; }
  const groups = groupWinningFolders(items).filter(folder => folder.items.length).map(folder => {
    const key = `${scope}:${folder.key}`;
    let group = winningGroups.get(key);
    if (!group) {
      group = document.createElement('details'); group.className = 'winning-folder';
      const summary = document.createElement('summary'), content = document.createElement('div');
      content.className = 'winning-folder-content'; group.append(summary,content); winningGroups.set(key,group);
      group.addEventListener('toggle',() => { if (!winningView.query.trim()) winningFolderOpen.set(key,group.open); });
    }
    group.firstElementChild.textContent = `${folder.label} · ${folder.items.length}商品`;
    group.open = Boolean(winningView.query.trim()) || (winningFolderOpen.get(key) ?? folder.open);
    syncWinningChildren(group.lastElementChild,folder.items.map(row)); return group;
  });
  syncWinningChildren(parent,groups);
}
function renderWinningLists() {
  const port = $('tabWinning'), top = port.getBoundingClientRect().top;
  const anchor = [...port.querySelectorAll('[data-product-id]')].find(node => node.getBoundingClientRect().bottom > top && node.getClientRects().length);
  const anchorTop = anchor?.getBoundingClientRect().top;
  const focused = document.activeElement;
  const focusKey = ['methodProduct','exportProduct','stopRecheck'].filter(key => focused?.dataset[key]).map(key => [key,focused.dataset[key]])[0];
  const ordered = orderWinningItems(state.winningLists,winningOrder,winningView.sort);
  winningOrder = ordered.map(item => item.product_id);
  const selected = selectWinningItems(ordered.map(item => ({...item,display_name:displayLabel('winning',item.product_id,item.display_name || item.product_name)})),winningView);
  renderWinningSection($('winningActive'),selected.active,'active');
  renderWinningSection($('winningClosedProducts'),selected.closed,'closed');
  $('winningClosed').open = closedManuallyOpen || Boolean(winningView.query.trim() && selected.closed.length);
  $('winningClosedTitle').textContent = `終了済み · ${selected.closed.length}/${selected.closedCount}商品`;
  $('winningClosedCounts').textContent = `対応未抽出：終了全体 ${selected.closedRemaining.toLocaleString()}件 / 絞込内 ${selected.filteredClosedRemaining.toLocaleString()}件${selected.closedRawRemaining !== selected.closedRemaining ? `／方式未設定・対象外を含む未抽出 ${selected.closedRawRemaining.toLocaleString()}件` : ''}`;
  $('winningListCount').textContent = `${selected.filteredCount}/${selected.total}商品`;
  $('winningRemaining').setAttribute('aria-pressed',String(winningView.status === 'remaining'));
  $('winningAttention').setAttribute('aria-pressed',String(winningView.status === 'attention'));
  $('clearWinningFilters').classList.toggle('hidden',!winningView.query && winningView.status === 'all' && !winningView.place && !winningView.month && !winningView.permanent);
  for (const [id,node] of winningNodes) if (!state.winningLists.some(item => item.product_id === id)) { node.remove(); winningNodes.delete(id); }
  bindWinningControls();
  if (anchor?.isConnected && anchor.getClientRects().length) port.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
  if (focusKey && !focused.isConnected) {
    const replacement = [...port.querySelectorAll('button')].find(button => button.dataset[focusKey[0]] === focusKey[1]);
    const target = replacement && !replacement.disabled ? replacement : winningNodes.get(focusKey[1])?.querySelector('[data-method-product]');
    target?.focus({preventScroll:true});
  }
  try { $('undoLastExport').classList.toggle('hidden',!localStorage.getItem(LAST_EXPORT_BATCH_KEY)); } catch {}
}
function applyWinningView(update, resetOrder = false) {
  winningView = normalizeView({...winningView,...update});
  if (resetOrder) winningOrder = orderWinningItems(state.winningLists,[],winningView.sort,true).map(item => item.product_id);
  try { const {query,status,place,month,permanent,...display} = winningView; localStorage.setItem(WINNING_VIEW_KEY,JSON.stringify(display)); } catch {}
  $('winningSearch').value = winningView.query;
  renderWinningLists();
}
function openWinningFilters() {
  $('winningStatus').value = winningView.status;
  for (const [id,field,values,label] of [ ['winningPlace','place',[...new Set(state.winningLists.map(item=>item.redemption_place).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ja')),value=>value], ['winningMonth','month',[...new Set(state.winningLists.map(winningMonth))].sort().reverse(),winningMonthLabel] ]) {
    $(id).replaceChildren(...['',...values].map(value => { const option=document.createElement('option'); option.value=value; option.textContent=value ? label(value) : 'すべて'; return option; }));
    $(id).value=winningView[field];
  }
  $('winningSort').value=winningView.sort; $('winningGrouping').value=winningView.grouping;
  $('winningPermanent').checked=winningView.permanent; $('winningShowCampaign').checked=winningView.showCampaign; $('winningRelativeDates').checked=winningView.relativeDates;
  $('winningFiltersDialog').showModal();
}
async function loadWinningLists() {
  const request = ++winningRequest;
  try {
    await loadDisplayNames();
    const result = await api('/api/winning-lists');
    if (request !== winningRequest) return;
    state.winningLists = result.products || []; winningLoaded = true;
    tabDot('winningTabCount',state.winningLists.length,'当選リスト');
    $('winningMetric').textContent = `当選 ${state.winningLists.length.toLocaleString()}商品`;
    const month = currentWinningMonth();
    if (month !== winningFolderMonth) { winningFolderOpen.clear(); winningFolderMonth = month; }
    $('winningLoadStatus').textContent = ''; $('retryWinningLoad').classList.add('hidden');
    renderWinningLists();
    if ($('outputMethodDialog').open) updateOutputSettings();
  } catch (error) {
    if (request !== winningRequest) return;
    $('winningLoadStatus').textContent = `更新できませんでした。${winningLoaded ? '前回取得した一覧を表示しています。' : ''}${error.message}`;
    $('retryWinningLoad').classList.remove('hidden');
  }
}

function winningProduct(productId) {
  return state.winningLists.find(item => item.product_id === productId);
}

function bindWinningControls() {
  document.querySelectorAll("[data-method-product]").forEach(button => button.onclick = () => openOutputMethod(button.dataset.methodProduct));
  document.querySelectorAll("[data-reassign-product]").forEach(button => button.onclick = () => openReassignment(button.dataset.reassignProduct));
  document.querySelectorAll("[data-export-product]").forEach(button => button.onclick = () => openExportAction(button.dataset.exportProduct));
  document.querySelectorAll("[data-stop-recheck]").forEach(button => button.onclick = () => { const progress=balanceRechecks.get(button.dataset.stopRecheck); if (progress) { progress.stopRequested=true; button.disabled=true; button.textContent="応答後に中断します"; } });
}

async function openReassignment(productId) {
  const product=winningProduct(productId);
  if(!product)return;
  state.reassignProductId=productId;
  state.reassignPreview=null;
  $("reassignTitle").textContent=product.display_name||product.product_name;
  $("reassignFrom").textContent=(product.campaign_name||product.campaign_id)+"　"+(product.lottery_start_date||"");
  $("reassignMessage").textContent="";
  const available=state.campaigns.filter(c=>!c.is_archived&&["active","closing","correcting"].includes(c.status)&&c.campaign_id!==product.campaign_id);
  $("reassignCampaign").innerHTML=available.map(c=>`<option value="${esc(c.campaign_id)}">${esc(campaignLabel(c))}（${c.status==="active"?"実施中":c.status==="closing"?"終了確認待ち":"訂正中"}）</option>`).join("");
  $("reassignConfirm").disabled=true;
  $("reassignSummary").textContent=available.length?"":"移動できるキャンペーンがありません。終了済みの場合はCP連携から訂正手続きを行ってください。";
  $("reassignDialog").showModal();
  if(available.length)await loadReassignmentPreview();
}
async function loadReassignmentPreview() {
  const productId=state.reassignProductId;
  const campaignId=$("reassignCampaign").value;
  if(!productId||!campaignId)return;
  state.reassignPreview=null;
  $("reassignConfirm").disabled=true;
  $("reassignSummary").textContent="変更対象を確認中…";
  $("reassignMessage").textContent="";
  try{
    const data=await api(`/api/products/${productId}/reassign?campaign_id=${encodeURIComponent(campaignId)}`);
    if(state.reassignProductId!==productId||$("reassignCampaign").value!==campaignId)return;
    state.reassignPreview=data;
    $("reassignSummary").textContent=`${data.total_count.toLocaleString()}件（抽出済み ${data.exported_count.toLocaleString()}件）を「${data.to_campaign_name}」へ移動します。URL・抽出記録・単価は保持します。`;
    $("reassignConfirm").disabled=false;
  }catch(error){
    $("reassignSummary").textContent="";
    $("reassignMessage").textContent=error.message;
  }
}
async function confirmReassignment(){
  const preview=state.reassignPreview;
  if(!preview||preview.product_id!==state.reassignProductId)return;
  $("reassignConfirm").disabled=true;
  $("reassignMessage").textContent="変更を保存中…";
  try{
    const result=await api(`/api/products/${preview.product_id}/reassign`,{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({campaign_id:preview.to_campaign_id,preview_key:preview.preview_key})
    });
    $("reassignDialog").close();
    state.reassignProductId=null;
    state.reassignPreview=null;
    await Promise.all([loadWinningLists(),loadCampaigns(),loadRevenueSummary()]);
    alert(`${result.moved_count.toLocaleString()}件のキャンペーンを変更しました。`);
  }catch(error){
    $("reassignMessage").textContent=error.message;
    $("reassignConfirm").disabled=false;
  }
}

function updateBalanceRecheck(productId, update) {
  const progress = { ...balanceRechecks.get(productId), ...update };
  balanceRechecks.set(productId, progress);
  document.querySelectorAll("[data-balance-message]").forEach(element => {
    if (element.dataset.balanceMessage === productId) element.textContent = progress.message;
  });
  renderWinningLists();
  if ($("outputMethodDialog").open) updateOutputSettings();
}

async function recheckWinningBalances(productId) {
  if (balanceRechecks.get(productId)?.running || !isEraberuPay(winningProduct(productId))) return;
  updateBalanceRecheck(productId, { running: true, stopRequested:false, message: "再解析するURLを確認中…" });
  const counts = { checked: 0, restored: 0, positive: 0, zero: 0, unknown: 0, skipped: 0 };
  let done = 0;
  let total = 0;
  const summary = () => `未抽出へ戻したURL ${counts.restored}件 / 残高あり ${counts.positive}件 / 残高0の応答 ${counts.zero}件 / 残高不明 ${counts.unknown}件 / 対象外・状態変更 ${counts.skipped}件`;
  try {
    const overview = await api(`/api/products/${productId}/balance-recheck`);
    total = overview.ids.length;
    counts.skipped = overview.unsupported;
    for (let offset = 0; offset < total; offset += 5) {
      if (balanceRechecks.get(productId)?.stopRequested) throw new Error("利用者が中断しました。");
      updateBalanceRecheck(productId, { message: `再解析中 ${done}/${total}件。${summary()}。画面を閉じずにお待ちください。` });
      const ids = overview.ids.slice(offset, offset + 5);
      const result = await api(`/api/products/${productId}/balance-recheck`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids })
      });
      for (const key of Object.keys(counts)) counts[key] += Number(result[key] || 0);
      done += ids.length;
      // Stop on an analyzer outage instead of repeatedly sending the remaining history.
      if (result.error) throw new Error(result.error);
    }
    updateBalanceRecheck(productId, { running: false, message: `再解析完了（${done}件）。${summary()}。` });
  } catch (error) {
    updateBalanceRecheck(productId, { running: false,
      message: `再解析を中断しました（応答確認 ${done}/${total}件）。${summary()}。${error.message} 再解析で再確認できます。` });
  } finally {
    await loadWinningLists();
  }
}

function updateOutputSettings() {
  const item = winningProduct(state.outputProductId);
  $('outputMethodContext').textContent = productContext(item);
  if (!item) { for (const id of ['settingsReassign','settingsRecheck','settingsInspectUnexported','settingsMoveFinished']) $(id).disabled=true; return; }
  $('outputMethodCounts').textContent = `合計 ${Number(item.total_count || 0).toLocaleString()}件 / 抽出済み ${Number(item.exported_count || 0).toLocaleString()}件 / 保管中の未抽出 ${Number(item.raw_unexported_count ?? item.unexported_count ?? 0).toLocaleString()}件 / 対応未抽出 ${Number(item.unexported_count || 0).toLocaleString()}件 / 対象外 ${Number(item.unmatched_count || 0).toLocaleString()}件`;
  const rawRemaining = Number(item.raw_unexported_count ?? item.unexported_count ?? 0);
  $('settingsInspectUnexported').textContent = `未抽出の中身（${rawRemaining.toLocaleString()}件）`;
  $('settingsInspectUnexported').disabled = false;
  $('settingsMoveFinished').disabled = item.campaign_status === 'closed';
  $('settingsMoveFinished').textContent = item.campaign_status === 'closed' ? 'CP終了済み' : item.manual_finished ? '通常の一覧へ戻す' : '終了済みへ移動';
  $('settingsMoveFinishedHelp').textContent = item.campaign_status === 'closed' ? 'CP全体が終了済みです。変更はCP連携の訂正手続きから行います。' : 'この商品の一覧上の移動です。CP全体の終了確定はCP連携で行います。';
  const price = item.unit_price == null ? '単価未設定' : `単価 ${Number(item.unit_price).toLocaleString()}円`;
  $('outputMethodRevenue').textContent = `${price} / ${item.revenue_month || '当月'}収益 ${item.unit_price == null ? '—（単価未設定）' : item.current_month_revenue == null ? '未取得' : `${Number(item.current_month_revenue).toLocaleString()}円`}（収益月は受信月基準） / 現在の方式：${methodLabel(item.output_method)}`;
  $('settingsReassign').disabled = !['active','closing','correcting'].includes(item.campaign_status);
  $('settingsReassignHelp').textContent = $('settingsReassign').disabled ? '終了済みの変更はCP連携の訂正手続きから行ってください。状態未取得の場合は再読み込みしてください。' : '';
  $('settingsRecheckSection').classList.toggle('hidden',!isEraberuPay(item));
  $('settingsRecheck').disabled = Boolean(balanceRechecks.get(item.product_id)?.running);
  $('settingsRecheckProgress').textContent = balanceRechecks.get(item.product_id)?.message || '';
}
function openOutputMethod(productId) {
  const item = winningProduct(productId);
  if (!item) return;
  state.outputProductId = productId;
  $('outputMethodTitle').textContent = `${item.display_name || item.product_name} の設定`;
  $('unitPriceInput').value = item.unit_price == null ? '' : String(item.unit_price);
  $('monthlyFolderLabel').textContent = winningMonthLabel(winningMonth(item));
  $('showInPermanent').checked = Boolean(item.show_in_permanent);
  $('outputMethodMessage').textContent = '';
  updateOutputSettings();
  $('outputMethodDialog').showModal();
}
async function openUnexportedContents() {
  const item = winningProduct(state.outputProductId);
  if (!item) return;
  contentsProductId = item.product_id;
  $('unexportedContentsTitle').textContent = `${displayLabel('winning',item.product_id,item.display_name || item.product_name)} の未抽出`;
  $('unexportedContentsContext').textContent = productContext(item);
  $('unexportedContentsDialog').showModal();
  await loadUnexportedContents(true);
}
async function loadUnexportedContents(reset = false) {
  if (!contentsProductId || (!reset && contentsLoading)) return;
  if (reset) { contentsGeneration++; contentsCursor=null; $('unexportedContentsList').replaceChildren(); }
  const generation = contentsGeneration, productId = contentsProductId;
  contentsLoading=true;
  $('unexportedContentsMore').disabled=true;
  $('unexportedContentsMessage').textContent='読み込み中…';
  try {
    const query = contentsCursor ? `?cursor=${encodeURIComponent(contentsCursor)}` : '';
    const result = await api(`/api/products/${productId}/unexported-items${query}`);
    if (generation !== contentsGeneration || productId !== contentsProductId) return;
    $('unexportedContentsSummary').textContent = `保管中の未抽出 ${result.total.toLocaleString()}件／現在の方式に対応 ${result.compatible_count.toLocaleString()}件${result.output_method === 'unset' ? '（方式未設定）' : ''}`;
    $('unexportedContentsList').insertAdjacentHTML('beforeend',result.items.map(item=>{
      const open = /^https?:\/\//i.test(item.value) ? `<a class="secondary" href="${esc(item.value)}" target="_blank" rel="noreferrer">開く</a>` : '';
      return `<article class="unexported-content"><div class="unknown-value">${esc(item.value)}</div><small>${item.compatible ? '現在の方式に対応' : result.output_method === 'unset' ? '方式未設定' : '現在の方式では対象外'}</small><div class="content-actions"><button type="button" class="secondary" data-inspect-copy="${esc(item.id)}">コピー</button>${open}</div></article>`;
    }).join(''));
    for (const item of result.items) {
      const button = [...$('unexportedContentsList').querySelectorAll('[data-inspect-copy]')].find(b=>b.dataset.inspectCopy===item.id);
      button.onclick=async()=>{try{await writeClipboard(item.value);button.textContent='コピー済み';}catch(error){$('unexportedContentsMessage').textContent=error.message;}};
    }
    contentsCursor=result.nextCursor;
    $('unexportedContentsMore').classList.toggle('hidden',!contentsCursor);
    $('unexportedContentsMessage').textContent=result.total ? '' : '未抽出データはありません。';
  } catch(error) { if(generation === contentsGeneration) $('unexportedContentsMessage').textContent=error.message; }
  finally { if(generation === contentsGeneration){contentsLoading=false;$('unexportedContentsMore').disabled=false;} }
}
async function toggleFinished() {
  const item = winningProduct(state.outputProductId);
  if (!item || item.campaign_status === 'closed') return;
  const finished = !item.manual_finished;
  $('settingsMoveFinished').disabled=true;
  try {
    await api(`/api/products/${item.product_id}/list-state`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({finished})});
    item.manual_finished=finished;
    $('outputMethodDialog').close();
    renderWinningLists();
  } catch(error){$('outputMethodMessage').textContent=error.message;updateOutputSettings();}
}

function openBalanceRecheckConfirmation() {
  const item = winningProduct(state.outputProductId);
  if (!isEraberuPay(item) || balanceRechecks.get(item.product_id)?.running) return;
  recheckConfirmProductId = item.product_id;
  $('balanceRecheckContext').textContent=productContext(item);
  $('outputMethodDialog').close(); $('balanceRecheckDialog').showModal();
}

async function saveFolderVisibility() {
  if (!state.outputProductId) return;
  $("saveFolderVisibility").disabled = true;
  try {
    await api(`/api/products/${state.outputProductId}/folder-visibility`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ show_in_permanent: $("showInPermanent").checked })
    });
    $("outputMethodMessage").textContent = "表示フォルダを保存しました";
    await loadWinningLists();
  } catch (error) { $("outputMethodMessage").textContent = error.message; }
  finally { $("saveFolderVisibility").disabled = false; }
}

async function saveUnitPrice() {
  if (!state.outputProductId) return;
  const value = $("unitPriceInput").value.trim();
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    $("outputMethodMessage").textContent = "単価は0円以上の整数で入力してください";
    return;
  }
  $("saveUnitPrice").disabled = true;
  $("outputMethodMessage").textContent = "単価を保存中…";
  try {
    await api(`/api/products/${state.outputProductId}/unit-price`, {
      method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({unit_price:Number(value)})
    });
    $("outputMethodMessage").textContent = "単価を保存しました";
    await Promise.all([loadWinningLists(), loadRevenueSummary()]);
  } catch (error) { $("outputMethodMessage").textContent = error.message; }
  finally { $("saveUnitPrice").disabled = false; }
}

let outputMethodSaving = false;
async function saveOutputMethod(method) {
  if (!state.outputProductId || outputMethodSaving) return;
  const productId = state.outputProductId;
  outputMethodSaving = true;
  document.querySelectorAll('[data-output-method]').forEach(button => button.disabled=true);
  $('outputMethodMessage').textContent = '保存中…';
  try {
    await api(`/api/products/${productId}/output-method`, {
      method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({output_method:method})
    });
    if (state.outputProductId === productId) $('outputMethodDialog').close();
    await loadWinningLists();
  } catch (error) { if (state.outputProductId === productId) $('outputMethodMessage').textContent=error.message; }
  finally { outputMethodSaving=false; document.querySelectorAll('[data-output-method]').forEach(button => button.disabled=false); }
}

function openExportAction(productId) {
  const item = winningProduct(productId);
  if (!item) return;
  if (item.output_method === "unset") return openOutputMethod(productId);
  $("exportActionContext").textContent = productContext(item);
  state.exportProductId = productId;
  state.exportPaypayKind = null;
  $("exportActionTitle").textContent = `${item.display_name || item.product_name} を抽出`;
  $("exportActionSummary").innerHTML = `未抽出<strong>${Number(item.unexported_count || 0).toLocaleString()}件</strong><small>${esc(methodLabel(item.output_method))}</small>`;
  $("exportActionMessage").textContent = "";
  const pending = state.pendingExportBatch;
  if (pending?.product_id && pending.product_id !== productId) {
    $("exportActionSummary").innerHTML = `${esc(pending.product_name || "別の商品")}の商品で<br>一括抽出が進行中です`;
    $("exportActionMessage").textContent = "進行中の一括抽出を完了または中断してから操作してください。";
    $("paypayKindChooser").classList.add("hidden");
    $("exportActionGrid").classList.add("hidden");
  } else if (pending?.product_id === productId && pending.items) {
    return showExportBatch(pending);
  } else if (item.output_method === "paypay") {
    const urlCount = Number(item.paypay_url_unexported_count || 0);
    const codeCount = Number(item.paypay_code_unexported_count || 0);
    $("paypayUrlCount").textContent = `${urlCount.toLocaleString()}件`;
    $("paypayCodeCount").textContent = `${codeCount.toLocaleString()}件`;
    document.querySelector('[data-paypay-kind="url"]').disabled = urlCount === 0;
    document.querySelector('[data-paypay-kind="code"]').disabled = codeCount === 0;
    $("paypayKindChooser").classList.remove("hidden");
    $("exportActionGrid").classList.add("hidden");
    $("exportActionMessage").textContent = "URLとコードを分けて抽出します。先に種別を選択してください。";
  } else {
    $("paypayKindChooser").classList.add("hidden");
    $("exportActionGrid").classList.remove("hidden");
  }
  $("exportActionDialog").showModal();
}

function selectPaypayKind(kind) {
  const item = winningProduct(state.exportProductId);
  if (!item || item.output_method !== "paypay" || !["url", "code"].includes(kind)) return;
  state.exportPaypayKind = kind;
  const label = kind === "url" ? "PayPay URL" : "PayPayコード";
  const count = Number(kind === "url" ? item.paypay_url_unexported_count : item.paypay_code_unexported_count) || 0;
  $("exportActionSummary").innerHTML = `${esc(label)}<strong>${count.toLocaleString()}件</strong><small>未抽出</small>`;
  $("exportActionMessage").textContent = "";
  $("exportActionGrid").classList.remove("hidden");
}

async function writeClipboard(text) {
  try { await navigator.clipboard.writeText(text); return; } catch {}
  const area = document.createElement("textarea");
  area.value = text; area.style.position = "fixed"; area.style.opacity = "0";
  document.body.appendChild(area); area.select();
  const copied = document.execCommand("copy"); area.remove();
  if (!copied) throw new Error("コピーできませんでした");
}

function batchText(batch) {
  return (batch?.items || []).map(item => String(item.value || "").trim()).filter(Boolean).join("\n");
}

function showExportBatch(batch) {
  $("exportBatchContext").textContent = productContext(winningProduct(batch.product_id));
  state.exportBatch = batch;
  if (batch.status === "pending") state.pendingExportBatch = batch;
  const kind = batch.paypay_kind === "url" ? " / PayPay URL" : batch.paypay_kind === "code" ? " / PayPayコード" : "";
  $("exportBatchSummary").innerHTML = `${esc(batch.product_name || "当選カード")}<strong>${Number(batch.count || 0).toLocaleString()}件</strong><small>${esc(kind)}</small>`;
  const mixed = batch.paypay_kind === "mixed";
  $("exportBatchComplete").classList.toggle("hidden", mixed);
  $("exportBatchMessage").textContent = mixed
    ? "URLとコードが混在する旧一括抽出です。中断して種別ごとに抽出し直してください。" : "";
  if ($("exportActionDialog").open) $("exportActionDialog").close();
  if (!$("exportBatchDialog").open) $("exportBatchDialog").showModal();
}

async function startBulkExport(order = "received") {
  const productId = state.exportProductId;
  if (!productId) return;
  $("exportActionDialog").close();
  let result;
  try {
    result = await api(`/api/products/${productId}/export-batches`, {
      method:"POST", headers:{ "content-type":"application/json" },
      body:JSON.stringify({ copy_order:order, paypay_kind:state.exportPaypayKind || undefined })
    });
    await writeClipboard(batchText(result.batch));
    showExportBatch(result.batch);
  } catch (error) {
    if (result?.batch?.id && !result.restored) {
      try { await api(`/api/export-batches/${result.batch.id}`, { method:"DELETE" }); } catch {}
    }
    if (error.code === "EXPORT_BATCH_OTHER_PRODUCT") {
      state.pendingExportBatch = { product_id:error.details.product_id, product_name:error.details.product_name,
        id:error.details.batch_id, count:error.details.item_count, status:"pending" };
      openExportAction(productId);
    } else alert(`一括コピーに失敗しました：${error.message}`);
  }
}

async function restorePendingExport() {
  try {
    const result = await api("/api/export-batches/pending");
    state.pendingExportBatch = result.batch || null;
    if (result.batch) showExportBatch(result.batch);
  } catch {}
}

async function cancelExportBatch() {
  if (!state.exportBatch) return;
  $("exportBatchMessage").textContent = "キャンセル中…";
  try {
    await api(`/api/export-batches/${state.exportBatch.id}`, { method:"DELETE" });
    state.exportBatch = null; state.pendingExportBatch = null; $("exportBatchDialog").close(); await loadWinningLists();
  } catch (error) { $("exportBatchMessage").textContent = error.message; }
}

async function completeExportBatch() {
  if (!state.exportBatch) return;
  const batchId = state.exportBatch.id;
  $("exportBatchComplete").disabled = true;
  $("exportBatchMessage").textContent = "抽出済みを記録中…";
  try {
    const result = await api(`/api/export-batches/${batchId}/complete`, { method:"POST" });
    try { localStorage.setItem(LAST_EXPORT_BATCH_KEY, batchId); } catch {}
    state.exportBatch = null; state.pendingExportBatch = null; $("exportBatchDialog").close(); await loadWinningLists();
    alert(`${Number(result.changed_count || 0).toLocaleString()}件を抽出済みにしました。`);
  } catch (error) { $("exportBatchMessage").textContent = error.message; }
  finally { $("exportBatchComplete").disabled = false; }
}

async function undoLastExport() {
  let batchId = ""; try { batchId = localStorage.getItem(LAST_EXPORT_BATCH_KEY) || ""; } catch {}
  if (!batchId) return;
  try {
    const result = await api(`/api/export-batches/${batchId}/undo`, { method:"POST" });
    try { localStorage.removeItem(LAST_EXPORT_BATCH_KEY); } catch {}
    await loadWinningLists();
    alert(`${Number(result.undone_count || 0).toLocaleString()}件を未抽出へ戻しました。`);
  } catch (error) { alert(error.message); }
}

async function openSingleExport() {
  const productId = state.exportProductId;
  if (!productId) return;
  $("exportActionDialog").close();
  state.exportItem = null;
  if (!$("exportItemDialog").open) $("exportItemDialog").showModal();
  await loadNextExportItem(productId);
}

async function loadNextExportItem(productId) {
  $("exportItemContext").textContent = productContext(winningProduct(productId));
  $("exportItemRemaining").textContent = "確認中…";
  $("exportItemValue").textContent = "データを確認しています…";
  $("exportItemOpen").disabled = true; $("exportItemComplete").disabled = true;
  $("exportItemMessage").textContent = "";
  try {
    const query = state.exportPaypayKind ? `?paypay_kind=${encodeURIComponent(state.exportPaypayKind)}` : "";
    const result = await api(`/api/products/${productId}/export-next${query}`);
    state.exportItem = result.item || null;
    const kind = result.paypay_kind === "url" ? "PayPay URL" : result.paypay_kind === "code" ? "PayPayコード" : "1件ずつ";
    $("exportItemTitle").textContent = `${result.product_name}・${kind}`;
    $("exportItemRemaining").innerHTML = `未抽出<strong>${Number(result.remaining_count || 0).toLocaleString()}件</strong>`;
    if (!result.item) {
      $("exportItemValue").textContent = "すべて抽出済みです";
      $("exportItemOpen").textContent = "抽出対象なし";
      await loadWinningLists();
      return;
    }
    $("exportItemValue").textContent = result.item.value;
    $("exportItemOpen").textContent = /^https:\/\//i.test(result.item.value) ? "URLを開く" : "文字列をコピー";
    $("exportItemOpen").disabled = false;
  } catch (error) { $("exportItemMessage").textContent = error.message; }
}

async function useCurrentExportItem() {
  if (!state.exportItem) return;
  try {
    if (/^https:\/\//i.test(state.exportItem.value)) {
      window.open(state.exportItem.value, "_blank", "noopener");
      $("exportItemMessage").textContent = "URLを開きました。確認後「抽出済み・次へ」を押してください。";
    } else {
      await writeClipboard(state.exportItem.value);
      $("exportItemMessage").textContent = "文字列をコピーしました。";
    }
    $("exportItemComplete").disabled = false;
  } catch (error) { $("exportItemMessage").textContent = error.message; }
}

async function completeCurrentExportItem() {
  if (!state.exportItem || !state.exportProductId) return;
  $("exportItemComplete").disabled = true;
  try {
    await api(`/api/products/${state.exportProductId}/items/${state.exportItem.id}/export-complete`, { method:"POST" });
    await Promise.all([loadWinningLists(), loadNextExportItem(state.exportProductId)]);
  } catch (error) { $("exportItemMessage").textContent = error.message; }
}

function campaignLabel(campaign) {
  return `${campaign.campaign_name}　${campaign.lottery_start_date}`;
}

function campaignHtml(campaign) {
  const labels = { active: "実施中", closing: "終了確認待ち", closed: "終了済み", correcting: "訂正中" };
  const count = campaign.status === "closed" ? campaign.final_winner_count : campaign.current_winner_count;
  const action = campaign.status === "closing" || campaign.status === "correcting"
    ? `<button data-close-campaign="${esc(campaign.campaign_id)}">終了確認</button>`
    : campaign.status === "closed"
      ? `<button class="secondary" data-correct-campaign="${esc(campaign.campaign_id)}">訂正</button>` : "";
  return `<article class="campaign-row status-${esc(campaign.status)}">
    <div><strong>${esc(campaign.campaign_name)}</strong><small><span>開始 ${esc(campaign.lottery_start_date || '未取得')}</span><span>${esc(labels[campaign.status] || campaign.status)}</span><span>${campaign.status === 'closed' ? '確定当選' : '当選'}${Number(count || 0).toLocaleString()}件${campaign.status === 'closed' ? '' : '（URL・コード）'}</span></small></div><div class="campaign-actions">${action}</div>
  </article>`;
}

function renderCampaigns() {
  const groups = {all:state.campaigns,active:state.campaigns.filter(c=>c.status==='active'),attention:state.campaigns.filter(c=>['closing','correcting'].includes(c.status)),closed:state.campaigns.filter(c=>c.status==='closed')};
  const query = $('campaignSearch').value.trim().toLocaleLowerCase();
  const shown = groups[campaignFilter].filter(c=>(c.campaign_name+' '+c.lottery_start_date).toLocaleLowerCase().includes(query));
  const labels = {all:'すべて',active:'実施中',attention:'要対応',closed:'終了済み'};
  document.querySelectorAll('[data-cp-filter]').forEach(b=>{b.textContent=`${labels[b.dataset.cpFilter]} ${groups[b.dataset.cpFilter].length}`;b.setAttribute('aria-pressed',String(b.dataset.cpFilter===campaignFilter));});
  $('campaignMetric').textContent = `表示 ${shown.length}件／全体 ${state.campaigns.length}件（CP）`;
  $('campaigns').innerHTML = shown.length ? shown.map(campaignHtml).join('') : '<div class="empty">該当するキャンペーンはありません</div>';
  bindCampaignControls();
}
async function loadOutbox() {
  try {
    const status = await api("/api/ledger/outbox");
    const message = `中央台帳同期：済 ${status.sent.toLocaleString()} / 待ち ${status.pending.toLocaleString()} / 失敗 ${status.failed.toLocaleString()}`;
    $("ledgerSyncStatus").className = status.failed ? "sync-summary sync-error" : "sync-summary";
    $("ledgerSyncStatus").textContent = message;
    if (status.failed) {
      $("ledgerSyncStatus").insertAdjacentHTML("beforeend", ' <button id="retryLedgerSync" class="secondary">再送</button>');
      $("retryLedgerSync").onclick = async () => { await api("/api/ledger/outbox/retry", { method: "POST" }); await Promise.all([load(), loadOutbox()]); };
    }
  } catch (error) {
    $("ledgerSyncStatus").className = "sync-summary sync-error";
    $("ledgerSyncStatus").textContent = error.message;
  }
}

async function loadCampaigns() {
  $("refreshCampaigns").disabled = true;
  try {
    const result = await api("/api/ledger/campaigns");
    state.campaigns = result.campaigns || [];
    renderCampaigns();
    if (result.stale) $("ledgerSyncStatus").textContent = `キャッシュ表示中：${result.warning}`;
    bindCampaignControls();
    await loadOutbox();
  } catch (error) {
    $("campaigns").innerHTML = `<div class="empty error">${esc(error.message)}</div>`;
    await loadOutbox();
  } finally { $("refreshCampaigns").disabled = false; }
}

function bindCampaignControls() {
  document.querySelectorAll("[data-close-campaign]").forEach(button => button.onclick = () => openClose(button.dataset.closeCampaign));
  document.querySelectorAll("[data-correct-campaign]").forEach(button => button.onclick = () => openCorrection(button.dataset.correctCampaign));
}

async function openAssignment(cardId, title) {
  state.assignmentCardId = cardId;
  state.assignmentPreview = null;
  $("assignmentTitle").textContent = `${title} を振り分け`;
  const available = state.campaigns.filter(campaign => !campaign.is_archived && ["active", "closing", "correcting"].includes(campaign.status));
  $("assignmentCampaign").innerHTML = available.map(campaign =>
    `<option value="${esc(campaign.campaign_id)}">${esc(campaignLabel(campaign))}${campaign.status === "closing" ? "（終了確認待ち）" : campaign.status === "correcting" ? "（訂正中）" : ""}</option>`).join("");
  const predicted = predictAssignmentCampaign(state.cards.get(cardId), available);
  if (predicted) {
    $("assignmentCampaign").value = predicted.campaign_id;
    $("assignmentPrediction").textContent = `前回の仕分け先から予測：${campaignLabel(predicted)}（変更できます）`;
    $("assignmentPrediction").classList.remove("hidden");
  } else {
    $("assignmentPrediction").textContent = "";
    $("assignmentPrediction").classList.add("hidden");
  }
  $("assignmentDecision").innerHTML = available.length ? "" : '<div class="empty">仕分け可能なキャンペーンがありません</div>';
  $("assignmentMessage").textContent = "";
  $("assignmentConfirm").disabled = !available.length;
  $("assignmentDialog").showModal();
  if (available.length) await loadAssignmentPreview();
}

async function loadAssignmentPreview() {
  const campaignId = $("assignmentCampaign").value;
  if (!campaignId || !state.assignmentCardId) return;
  $("assignmentConfirm").disabled = true;
  $("assignmentMessage").textContent = "商品重複を確認中…";
  try {
    const preview = await api(`/api/cards/${state.assignmentCardId}/assignment-preview?campaign_id=${encodeURIComponent(campaignId)}`);
    state.assignmentPreview = preview;
    let html = `<p><strong>${Number(preview.card.unassigned_count).toLocaleString()}件</strong>を仕分けます。</p>`;
    if (preview.exact_product) {
      html += `<label class="choice"><input type="radio" name="productChoice" value="${esc(preview.exact_product.product_id)}" checked>完全一致の既存商品「${esc(preview.exact_product.product_name)}」へ追加</label>`;
    } else if (preview.possible_products.length) {
      html += '<p class="warning">似ている商品があります。同一商品か別商品かを選んでください。</p>';
      html += preview.possible_products.map(product => `<label class="choice"><input type="radio" name="productChoice" value="${esc(product.product_id)}">既存「${esc(product.product_name)} / ${esc(product.product_spec || "規格なし")} / ${esc(product.valid_until || "期限なし")}"へ追加</label>`).join("");
      html += '<label class="choice"><input type="radio" name="productChoice" value="separate">別商品として登録</label>';
    } else {
      html += '<p>同一商品はありません。キャンペーン内の新しい正式商品として登録します。</p>';
    }
    $("assignmentDecision").innerHTML = html;
    $("assignmentMessage").textContent = preview.campaign.status === "closing" ? "終了確認待ちです。遅れて回収したURLとして仕分けできます。" : "";
    $("assignmentConfirm").disabled = false;
  } catch (error) {
    state.assignmentPreview = null;
    $("assignmentDecision").innerHTML = "";
    $("assignmentMessage").textContent = error.message;
  }
}

async function confirmAssignment() {
  if (!state.assignmentPreview) return;
  const selected = document.querySelector('input[name="productChoice"]:checked')?.value || "";
  if (state.assignmentPreview.possible_products.length && !selected) {
    $("assignmentMessage").textContent = "同一商品か別商品かを選択してください。";
    return;
  }
  $("assignmentConfirm").disabled = true;
  $("assignmentMessage").textContent = "仕分け・同期登録中…";
  try {
    const body = { campaign_id: $("assignmentCampaign").value };
    if (selected === "separate") body.create_separate = true;
    else if (selected) body.product_id = selected;
    const result = await api(`/api/cards/${state.assignmentCardId}/assign`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    });
    $("assignmentDialog").close();
    await Promise.all([load(), loadCampaigns(), loadWinningLists(), loadRevenueSummary()]);
    switchTab("winning");
    alert(`${result.assigned_count.toLocaleString()}件を仕分けました。`);
  } catch (error) {
    $("assignmentMessage").textContent = error.message;
    $("assignmentConfirm").disabled = false;
  }
}

async function openClose(campaignId) {
  state.closeCampaignId = campaignId;
  const campaign = state.campaigns.find(item => item.campaign_id === campaignId);
  $("closeTitle").textContent = `${campaign ? campaignLabel(campaign) : campaignId} を終了`;
  $("closePreview").innerHTML = '<div class="empty">終了前の数値を確認中…</div>';
  $("closeMessage").textContent = "";
  $("closeConfirm").disabled = true;
  $("closeDialog").showModal();
  try {
    const preview = await api(`/api/ledger/campaigns/${campaignId}/close-preview`);
    state.closePreview = preview;
    $("closePreview").innerHTML = `<div class="close-totals">
      <span>キャンペーン総当選数<strong>${Number(preview.final_winner_count).toLocaleString()}</strong></span>
      <span>商品別合計<strong>${Number(preview.final_product_winner_count).toLocaleString()}</strong></span>
      <span>差分<strong>${Number(preview.winner_count_difference).toLocaleString()}</strong></span></div>
      ${preview.has_mismatch ? '<p class="warning">不一致があります。数値は自動補正せず、この差分を承認した場合だけ終了できます。</p>' : '<p class="success">総数と商品別合計は一致しています。</p>'}
      <div class="preview-products">${(preview.products || []).map(product => `<div><span>${esc(product.product_name)}</span><strong>${Number(product.final_winner_count).toLocaleString()}件</strong></div>`).join("")}</div>`;
    $("closeConfirm").textContent = preview.has_mismatch ? "差分を承認して終了" : "終了を確定";
    $("closeConfirm").disabled = false;
  } catch (error) { $("closeMessage").textContent = error.message; }
}

async function confirmClose() {
  $("closeConfirm").disabled = true;
  $("closeMessage").textContent = "最終値を確定中…";
  try {
    const result = await api(`/api/ledger/campaigns/${state.closeCampaignId}/close`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ accept_mismatch: state.closePreview?.has_mismatch === true })
    });
    if (!result.delivery?.ok) throw new Error("終了要求は保存されましたが中央台帳への送信に失敗しました。自動再送します。");
    $("closeDialog").close();
    await Promise.all([loadCampaigns(),loadWinningLists()]);
  } catch (error) {
    $("closeMessage").textContent = error.message;
    $("closeConfirm").disabled = false;
  }
}

function openCorrection(campaignId) {
  state.correctionCampaignId = campaignId;
  const campaign = state.campaigns.find(item => item.campaign_id === campaignId);
  $("correctionTitle").textContent = `${campaign ? campaignLabel(campaign) : campaignId} の訂正`;
  $("correctionReason").value = "";
  $("correctionMessage").textContent = "";
  $("correctionDialog").showModal();
}

async function confirmCorrection() {
  $("correctionConfirm").disabled = true;
  $("correctionMessage").textContent = "訂正開始を送信中…";
  try {
    const result = await api(`/api/ledger/campaigns/${state.correctionCampaignId}/corrections`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: $("correctionReason").value })
    });
    if (!result.delivery?.ok) throw new Error("訂正要求は保存されましたが中央台帳への送信に失敗しました。自動再送します。");
    $("correctionDialog").close();
    await Promise.all([loadCampaigns(),loadWinningLists()]);
  } catch (error) {
    $("correctionMessage").textContent = error.message;
  } finally { $("correctionConfirm").disabled = false; }
}

function bindDynamic() {
  document.querySelectorAll('[data-edit-sorting-name]').forEach(button => button.onclick = () => openDisplayName('sorting',button.dataset.editSortingName));
  document.querySelectorAll("[data-card]").forEach(button => button.onclick = () => openItems(button.dataset.card, button.dataset.title));
  document.querySelectorAll("[data-assign-card]").forEach(button => button.onclick = () => openAssignment(button.dataset.assignCard, button.dataset.title));
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
    `容量・規格・金額: ${[value("specification"), analysisAmount(item)].filter(Boolean).join(" / ") || "なし"}`,
    `利用先: ${value("redeem_place")}`,
    ...(isEraberuPay(item) ? [] : [`使用期限: ${value("expires_on")}`]),
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
  if (!values.length) return false;
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
    if (result.provisional) {
      state.activeJobId = null;
      $("receiveInput").value = "";
      $("receiveProgress").classList.add("hidden");
      $("receiveResult").textContent = "暫定" + result.mode + " に " +
        Number(result.received || 0) + "件保管しました（重複 " +
        Number(result.duplicate || 0) + "件）。";
      await refreshProvisionalUI();
      return true;
    }
    state.activeJobId = result.job.id;
    $("receiveInput").value = "";
    showJobProgress(result.job);
    await load();
    await loadJob();
    return true;
  } catch (error) {
    $("progressStatus").textContent = "受付失敗";
    $("receiveResult").textContent = error.message;
    return false;
  } finally { controls.forEach(button => button.disabled = false); }
}

async function resumePendingShare() {
  let pending;
  try { pending = JSON.parse(localStorage.getItem(PENDING_SHARE_KEY) || "null"); }
  catch { localStorage.removeItem(PENDING_SHARE_KEY); return; }
  if (!pending?.text) return;
  if (Date.now() - Number(pending.createdAt || 0) > 24 * 60 * 60 * 1000) {
    localStorage.removeItem(PENDING_SHARE_KEY);
    return;
  }
  $("receiveInput").value = pending.text;
  $("receiveResult").textContent = "共有されたURLを自動受付します…";
  document.querySelector(".receive")?.scrollIntoView({ block: "start" });
  if (await receive()) localStorage.removeItem(PENDING_SHARE_KEY);
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

async function refreshVisibleData() {
  if (!state.authenticated || document.hidden || state.refreshing) return;
  state.refreshing = true;
  try {
    await Promise.allSettled([loadJob(), load()]);
    if (document.body.dataset.activeTab === "sorting") {
      await refreshProvisionalUI().catch(error => console.warn("provisional refresh", error));
    }
  } finally {
    state.refreshing = false;
  }
}

// Keep a signed, already-authenticated browser signed in during ordinary use.
// The status endpoint can only renew a still-valid HttpOnly session cookie.
// No password or token is stored in localStorage, JavaScript or the PWA cache.
let lastSessionCheck = 0;
let sessionCheckInFlight = false;
async function keepSessionAlive() {
  if (!state.authenticated || document.hidden || sessionCheckInFlight ||
      Date.now() - lastSessionCheck < 6 * 60 * 60 * 1000) return;
  sessionCheckInFlight = true;
  lastSessionCheck = Date.now();
  try {
    const status = await api("/api/auth/status");
    if (!status.authenticated) {
      if (status.deviceOnlyMode) {
        try {
          if (await loginWithDeviceKey()) return;
        } catch (error) { console.warn("device reauthentication", error); }
      }
      stopPolling();
      showLogin("この端末の認証が必要です");
    }
  } catch (error) {
    // Temporary network outages must not log out a valid local session.
    lastSessionCheck = 0;
    console.warn("session renewal", error);
  } finally {
    sessionCheckInFlight = false;
  }
}

function startPolling() {
  stopPolling();
  // Android may suspend network operations when the PWA is in the background.
  // Poll less often, and refresh immediately upon returning to the foreground.
  void keepSessionAlive();
  state.pollTimer = setInterval(() => {
    void keepSessionAlive();
    void refreshVisibleData();
  }, 8000);
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    void keepSessionAlive();
    void refreshVisibleData();
  }
});
window.addEventListener("pageshow", event => {
  if (event.persisted) void refreshVisibleData();
});
window.addEventListener("focus", () => { void refreshVisibleData(); });
window.addEventListener("online", () => { void refreshVisibleData(); });

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

$('settingsInspectUnexported').onclick=openUnexportedContents;
$('settingsMoveFinished').onclick=toggleFinished;
$('unexportedContentsClose').onclick=()=>$('unexportedContentsDialog').close();
$('unexportedContentsMore').onclick=()=>loadUnexportedContents();
$('unexportedContentsRefresh').onclick=()=>loadUnexportedContents(true);
$('unexportedContentsDialog').addEventListener('close',()=>{contentsGeneration++;contentsProductId=null;contentsLoading=false;$('unexportedContentsList').replaceChildren();});
$('displayNameClose').onclick = () => $('displayNameDialog').close();
$('displayNameInput').oninput = checkDisplayName;
$('displayNameSave').onclick = saveDisplayAlias;
$('editWinningName').onclick = () => openDisplayName('winning',state.outputProductId);
window.addEventListener('resize',()=>{if($('displayNameDialog').open)checkDisplayName();});
$('pendingBanner').onclick = () => {$('pendingSection').scrollIntoView({block:'start'});};
$('campaignSearch').oninput = renderCampaigns;
$('campaignFilters').onclick = event => {const b=event.target.closest('[data-cp-filter]');if(b){campaignFilter=b.dataset.cpFilter;renderCampaigns();}};
$("receive").onclick = receive;
$("clear").onclick = clearReceive;
$("retry").onclick = retry;
$("paste").onclick = async () => {
  try { $("receiveInput").value = await navigator.clipboard.readText(); }
  catch { $("receiveResult").textContent = "入力欄を長押しして貼り付けてください。"; }
};
$("pasteCouponImage").onclick = pasteCouponImage;
$("couponImageFile").onchange = event => setCouponImage(event.currentTarget.files?.[0]);
$("reanalyzeCouponImage").onclick = analyzeSelectedImage;
$("confirmCouponImage").onclick = confirmSelectedImage;
$("imageAnalysisClose").onclick = () => $("imageAnalysisDialog").close();
$("imageAnalysisDialog").addEventListener("close", () => {
  state.imageAnalysisItemId = null;
  resetImageAnalysis();
});
$("dialogClose").onclick = () => $("itemsDialog").close();
$("loadMore").onclick = loadItems;
$("loginForm").onsubmit = login;
$("deviceLoginButton").onclick = async () => {
  $("deviceLoginButton").disabled = true;
  $("deviceLoginMessage").textContent = "端末鍵を確認しています…";
  try {
    if (!await loginWithDeviceKey()) throw Error("この端末は未登録です。下の端末登録から開始してください。");
    await boot();
  } catch (error) { $("deviceLoginMessage").textContent = error.message; }
  finally { $("deviceLoginButton").disabled = false; }
};
$("deviceSetupButton").onclick = async () => {
  $("deviceSetupButton").disabled = true;
  $("deviceLoginMessage").textContent = "端末鍵を作成しています…";
  try {
    const result = await prepareDevicePairing();
    $("devicePairingHash").value = result.hash;
    $("deviceSetupSteps").classList.remove("hidden");
    $("deviceLoginMessage").textContent = "ハッシュをCloudflareのDEVICE_PAIRING_SHA256に登録してください。";
  } catch (error) { $("deviceLoginMessage").textContent = error.message; }
  finally { $("deviceSetupButton").disabled = false; }
};
$("copyDevicePairingHash").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("devicePairingHash").value);
    $("deviceLoginMessage").textContent = "端末登録用ハッシュをコピーしました。";
  } catch (error) {
    $("devicePairingHash").select();
    $("deviceLoginMessage").textContent = "選択された文字列を長押ししてコピーしてください。";
  }
};
$("confirmDeviceSetup").onclick = async () => {
  $("confirmDeviceSetup").disabled = true;
  $("deviceLoginMessage").textContent = "登録端末を検証しています…";
  try {
    await finishDevicePairing();
    $("deviceSetupSteps").classList.add("hidden");
    $("devicePairingHash").value = "";
    await boot();
  } catch (error) { $("deviceLoginMessage").textContent = error.message; }
  finally { $("confirmDeviceSetup").disabled = false; }
};

$("logout").onclick = logout;
$("openTrialReset").onclick = openTrialReset;
$("refreshCampaigns").onclick = loadCampaigns;
$("assignmentCampaign").onchange = loadAssignmentPreview;
$("assignmentConfirm").onclick = confirmAssignment;
$("assignmentClose").onclick = () => $("assignmentDialog").close();
$("closeConfirm").onclick = confirmClose;
$("closeDialogClose").onclick = () => $("closeDialog").close();
$("correctionConfirm").onclick = confirmCorrection;
$("correctionDialogClose").onclick = () => $("correctionDialog").close();
$("cancelTrialReset").onclick = () => $("trialResetDialog").close();
$("trialResetConfirmation").oninput = event => {
  $("confirmTrialReset").disabled = event.currentTarget.value !== "完全削除";
};
$("confirmTrialReset").onclick = resetTrialData;
document.querySelectorAll("[data-tab]").forEach(button => button.onclick = () => switchTab(button.dataset.tab));
$("refreshWinningLists")?.addEventListener("click", loadWinningLists);
$('winningSearch').value = winningView.query;
$('winningSearch').oninput = event => applyWinningView({query:event.target.value});
$('winningRemaining').onclick = () => applyWinningView({status:winningView.status === 'remaining' ? 'all' : 'remaining'});
$('winningAttention').onclick = () => applyWinningView({status:winningView.status === 'attention' ? 'all' : 'attention'});
$('clearWinningFilters').onclick = () => applyWinningView({query:'',status:'all',place:'',month:'',permanent:false});
$('retryWinningLoad').onclick = loadWinningLists;
$('winningClosed').addEventListener('toggle', () => { if (!winningView.query.trim()) closedManuallyOpen=$('winningClosed').open; });
$('openWinningFilters').onclick = openWinningFilters;
$('winningFiltersClose').onclick = () => $('winningFiltersDialog').close();
$('winningFiltersReset').onclick = () => { applyWinningView(DEFAULT_VIEW,true); $('winningFiltersDialog').close(); };
$('winningFiltersForm').onsubmit = event => {
  event.preventDefault();
  applyWinningView({status:$('winningStatus').value,place:$('winningPlace').value,month:$('winningMonth').value,sort:$('winningSort').value,grouping:$('winningGrouping').value,permanent:$('winningPermanent').checked,showCampaign:$('winningShowCampaign').checked,relativeDates:$('winningRelativeDates').checked},true);
  $('winningFiltersDialog').close();
};
$('settingsReassign').onclick = () => { const id=state.outputProductId; $('outputMethodDialog').close(); openReassignment(id); };
$('settingsRecheck').onclick = openBalanceRecheckConfirmation;
$('balanceRecheckClose').onclick = () => $('balanceRecheckDialog').close();
$('balanceRecheckConfirm').onclick = () => { const id=recheckConfirmProductId; recheckConfirmProductId=null; $('balanceRecheckDialog').close(); if (id) void recheckWinningBalances(id); };
$("undoLastExport").onclick = undoLastExport;
$("outputMethodClose").onclick = () => $("outputMethodDialog").close();
$("reassignClose").onclick = () => $("reassignDialog").close();
$("reassignCampaign").onchange = loadReassignmentPreview;
$("reassignConfirm").onclick = confirmReassignment;
$("saveFolderVisibility").onclick = saveFolderVisibility;
$("saveUnitPrice").onclick = saveUnitPrice;
$("outputMethodDialog").addEventListener("click", event => {
  const button = event.target.closest("[data-output-method]");
  if (button) saveOutputMethod(button.dataset.outputMethod);
});
$("exportActionClose").onclick = () => $("exportActionDialog").close();
$("paypayKindChooser").addEventListener("click", event => {
  const button = event.target.closest("[data-paypay-kind]");
  if (button) selectPaypayKind(button.dataset.paypayKind);
});
$("exportOneByOne").onclick = openSingleExport;
$("exportBulk").onclick = () => startBulkExport("received");
$("exportBulkAsc").onclick = () => startBulkExport("asc");
$("exportBatchAgain").onclick = async () => {
  if (!state.exportBatch) return;
  try { await writeClipboard(batchText(state.exportBatch)); $("exportBatchMessage").textContent = "もう一度コピーしました。"; }
  catch (error) { $("exportBatchMessage").textContent = error.message; }
};
$("exportBatchCancel").onclick = cancelExportBatch;
$("exportBatchComplete").onclick = completeExportBatch;
$("exportItemOpen").onclick = useCurrentExportItem;
$("exportItemStop").onclick = () => $("exportItemDialog").close();
$("exportItemComplete").onclick = completeCurrentExportItem;
$("pendingDialog").addEventListener("cancel", event => event.preventDefault());
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js")
    .then(registration => registration.update())
    .catch(error => console.warn("service worker", error));
}
boot();


async function loadSendingTokens() {
  const result=await api('/api/sending-tokens');
  const list=$('sendingTokenList');list.replaceChildren();
  for(const token of result.tokens){
    const row=document.createElement('div');row.className='row';
    const label=document.createElement('span');label.textContent=`端末${token.device_id} — ${token.revoked_at?'失効済み':'有効'}`;row.append(label);
    if(!token.revoked_at){const button=document.createElement('button');button.className='secondary';button.textContent='失効';
      button.onclick=async()=>{if(!confirm(`端末${token.device_id}の送信トークンを失効しますか？`))return;
        try{await api(`/api/sending-tokens/${token.id}/revoke`,{method:'POST'});await loadSendingTokens();}
        catch(error){$('sendingTokenMessage').textContent=error.message;}};row.append(button);}
    list.append(row);
  }
}
$('openSendingTokens').onclick=async()=>{
  $('sendingEndpoint').value=location.origin+'/api/receive';$('sendingTokenMessage').textContent='';
  $('sendingTokensDialog').showModal();
  try{await loadSendingTokens();}catch(error){$('sendingTokenMessage').textContent=error.message;}
};
$('sendingTokensClose').onclick=()=>$('sendingTokensDialog').close();
$('sendingTokensDialog').addEventListener('close',()=>{$('issuedSendingToken').value='';$('issuedTokenPanel').classList.add('hidden');});
$('issueSendingToken').onclick=async()=>{
  const deviceId=$('sendingDeviceId').value.trim();
  if(!/^\d{2,4}$/.test(deviceId)){$('sendingTokenMessage').textContent='端末番号を2〜4桁で入力してください';return;}
  if(!confirm(`端末${deviceId}のトークンを発行します。同じ番号の既存トークンは無効になります。続けますか？`))return;
  $('issueSendingToken').disabled=true;
  try{const data=await api('/api/sending-tokens',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({deviceId})});
    $('issuedSendingToken').value=data.token;$('issuedTokenPanel').classList.remove('hidden');
    $('sendingTokenMessage').textContent='発行しました。閉じる前にコピーしてください。';await loadSendingTokens();
  }catch(error){$('sendingTokenMessage').textContent=error.message;}finally{$('issueSendingToken').disabled=false;}
};
for(const [button,input] of [['copySendingEndpoint','sendingEndpoint'],['copySendingToken','issuedSendingToken']]){
  $(button).onclick=async()=>{try{await navigator.clipboard.writeText($(input).value);$('sendingTokenMessage').textContent='コピーしました。';}
    catch{$(input).select();$('sendingTokenMessage').textContent='入力欄を長押ししてコピーしてください。';}};
}


function renderUsedCount(ids) {
  state.usedIds = ids || [];
  $("deleteUsed").textContent = `使用済み ${state.usedIds.length.toLocaleString()}件`;
  $("deleteUsed").classList.toggle("hidden", state.usedIds.length === 0);
}

async function recheckSortingUsage() {
  const button=$("recheckUsage");
  if (button.disabled) return;
  button.disabled=true;
  $("deleteUsed").disabled=true;
  button.textContent="確認中…";
  stopPolling();
  let done=0, used=0, notUsed=0, unknown=0;
  try {
    const overview=await api("/api/usage");
    unknown=overview.unsupported;
    const total=overview.ids.length;
    for(let start=0;start<total;start+=5) {
      $("usageMessage").textContent=`使用状況を確認中 ${done}/${total}件`;
      const result=await api("/api/usage/recheck",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ids:overview.ids.slice(start,start+5)})});
      done+=overview.ids.slice(start,start+5).length;
      used+=result.used; notUsed+=result.notUsed; unknown+=result.unknown;
      $("usageMessage").textContent=`使用状況を確認中 ${done}/${total}件`;
    }
    await load();
    $("usageMessage").textContent=total || unknown ? `確認完了：使用済み ${used}件／使用済み表示なし ${notUsed}件／確認できない ${unknown}件` : "再確認できる仕分け前のURLはありません。";
  } catch(error) {
    $("usageMessage").textContent=`${done}件まで確認しました。${error.message} 再確認ボタンで再実行できます。`;
    await load();
  } finally {
    button.disabled=false;
    $("deleteUsed").disabled=false;
    button.textContent="使用済み再確認";
    if(state.authenticated) startPolling();
  }
}

async function deleteUsedCoupons() {
  const ids=[...(state.usedIds || [])];
  if(!ids.length || !confirm(`使用済みの${ids.length.toLocaleString()}件を削除しますか？`)) return;
  const button=$("deleteUsed");
  button.disabled=true;
  try {
    const result=await api("/api/usage/delete",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ids,confirmation:"使用済みを削除"})});
    await load();
    $("usageMessage").textContent=`使用済み ${result.deleted.toLocaleString()}件を削除しました。`;
  } catch(error) { $("usageMessage").textContent=error.message; }
  finally {button.disabled=false;}
}
$("recheckUsage").onclick=recheckSortingUsage;
$("retrySortingLoad").onclick = () => { void refreshVisibleData(); };
$("deleteUsed").onclick=deleteUsedCoupons;
