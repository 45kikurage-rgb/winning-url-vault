const $ = id => document.getElementById(id);
const state = { cursor: null, cardId: null };

async function api(path, options) {
  const response = await fetch(path, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `API error ${response.status}`);
  return payload;
}

function esc(value = "") {
  return String(value).replace(/[&<>"']/g, char => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[char]);
}

function pendingCard(item) {
  const image = item.image_data_uri
    ? `<img src="${esc(item.image_data_uri)}" alt="${esc(item.raw_name)}の商品画像">`
    : '<div class="image-empty">画像なし</div>';
  return `<article class="pending-card" data-pending="${esc(item.id)}">
    ${image}<div class="pending-fields">
      <label>正式商品名<input name="raw_name" value="${esc(item.raw_name)}" readonly></label>
      <label>判定用商品名<input name="normalized_name" value="${esc(item.normalized_name)}" readonly></label>
      <label>画面表示名<input name="display_name" value="${esc(item.display_name)}" readonly></label>
      <div class="field-row"><label>容量・規格<input name="specification" value="${esc(item.specification)}" readonly></label>
      <label>利用先<input name="redeem_place" value="${esc(item.redeem_place)}" readonly></label></div>
      <label>使用期限<input name="expires_on" type="date" value="${esc(item.expires_on)}" readonly></label>
      <p class="waiting">同じ条件の確認待ち ${Number(item.item_count || 0).toLocaleString()}件</p>
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
  document.querySelectorAll("[data-pending]").forEach(card => {
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
  });
}

async function submitConfirmation(card, action) {
  const buttons = [...card.querySelectorAll("button")];
  buttons.forEach(button => button.disabled = true);
  const body = { action };
  if (action === "edit") card.querySelectorAll("input[name]").forEach(input => body[input.name] = input.value);
  try {
    await api(`/api/pending/${card.dataset.pending}/confirm`, { method:"POST", headers:{ "content-type":"application/json" }, body:JSON.stringify(body) });
    await load();
  } catch (error) {
    alert(error.message);
    buttons.forEach(button => button.disabled = false);
  }
}

async function receive() {
  const text = $("receiveInput").value.trim();
  if (!text) return;
  $("receive").disabled = true;
  $("receiveResult").textContent = "解析中…";
  try {
    const result = await api("/api/receive", { method:"POST", headers:{ "content-type":"application/json" }, body:JSON.stringify({ text }) });
    $("receiveResult").textContent = `受信 ${result.received}件 / 重複 ${result.duplicate}件 / 確認待ち ${result.counts.pending_confirmation || 0}件 / 未判定 ${result.counts.unresolved || 0}件`;
    $("receiveInput").value = "";
    await load();
  } catch (error) { $("receiveResult").textContent = error.message; }
  finally { $("receive").disabled = false; }
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
$("retry").onclick = retry;
$("paste").onclick = async () => {
  try { $("receiveInput").value = await navigator.clipboard.readText(); }
  catch { $("receiveResult").textContent = "入力欄を長押しして貼り付けてください。"; }
};
$("dialogClose").onclick = () => $("itemsDialog").close();
$("loadMore").onclick = loadItems;
load();
