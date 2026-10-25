const $ = id => document.getElementById(id);
let apiFn;
let afterPublish;
let initialized = false;

function escapeText(value) {
  return String(value ?? "").replace(/[&<>"']/g, char =>
    ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[char]);
}
function shortValue(value) {
  const text = String(value || "");
  return text.length > 200 ? text.slice(0, 200) + "…" : text;
}
function renderOverview(data) {
  for (const button of document.querySelectorAll("[data-provisional-mode]")) {
    const mode = button.dataset.provisionalMode;
    button.classList.toggle("is-selected", data.mode === mode);
    button.setAttribute("aria-pressed", String(data.mode === mode));
    const count = data.buckets?.find(bucket => bucket.slot === mode)?.count;
    button.textContent = mode === "normal" ? "通常" : "暫定" + mode + (count ? " (" + count + ")" : "");
  }
  $("receive").textContent = data.mode === "normal" ? "解析して保管" : "暫定" + data.mode + "に保管";
  $("provisionalModeStatus").textContent = "現在の受信先： " + (data.mode === "normal" ? "通常" : "暫定" + data.mode) +
    "（ARUNOMATICを含む全端末共通）";
  $("receiveContext").textContent = $("provisionalModeStatus").textContent;
  const container = $("provisionalSortingResults");
  if (!container) return;
  const buckets = (data.buckets || []).filter(bucket => bucket.count > 0);
  if (!buckets.length) {
    container.innerHTML = '<p class="provisional-empty">暫定保管中のデータはありません。</p>';
    return;
  }
  container.innerHTML = buckets.map(bucket => {
    const codes = (bucket.items || []).map(item =>
      '<li><code>' + escapeText(shortValue(item.value)) + '</code>' +
      (item.source === "coin_plus" ? ' <span>COIN+</span>' : "") +
      (item.expires_on ? ' <span>受取期限 ' + escapeText(item.expires_on) + '</span>' : "") +
      (item.source === "coin_plus_unparsed" ? ' <span>コード要確認</span>' : "") +
      '</li>').join("");
    const coin = bucket.items.length && bucket.items.every(item => item.source === "coin_plus");
    const expiryDates = [...new Set(bucket.items.map(item => item.expires_on).filter(Boolean))];
    const expiry = expiryDates.length === 1 && !bucket.truncated ? expiryDates[0] : "";
    return '<section class="provisional-result-group" data-provisional-slot="' + escapeText(bucket.slot) + '">' +
      '<div class="row"><strong>暫定' + escapeText(bucket.slot) + ' の解析結果　' +
      Number(bucket.count).toLocaleString() + '件</strong></div>' +
      '<details><summary>保管内容を確認・カード化</summary>' +
      '<ul class="provisional-codes">' + codes + '</ul>' +
      (bucket.truncated ? '<p>先頭40件を表示しています。全件がカード化対象です。</p>' : "") +
      '<p>この保管箱にある全件を一つのカードにします。別キャンペーンは別の保管箱を選択してください。</p>' +
      '<div class="provisional-fields">' +
      '<label>カード名（任意）<input name="name" maxlength="160" value="' +
        (coin ? "COIN+ ギフトコード" : "") + '" placeholder="未入力でもカード化できます"></label>' +
      '<label>受取期限（任意）<input name="expires_on" type="date" value="' + escapeText(expiry) + '"></label>' +
      '<label>利用先（任意）<input name="redeem_place" maxlength="64" value="' +
        (coin ? "エアウォレット" : "") + '"></label>' +
      '<label>金額（任意・円）<input name="amount" type="number" min="1" step="1" placeholder="未設定"></label>' +
      '<label>規格・補足（任意）<input name="specification" maxlength="80"></label>' +
      '</div>' +
      '<button type="button" data-publish-slot="' + escapeText(bucket.slot) +
      '" data-bucket-id="' + escapeText(bucket.bucketId) + '">この暫定をカード化</button>' +
      '<p class="provisional-publish-message" aria-live="polite"></p>' +
      '</details></section>';
  }).join("");
  for (const button of container.querySelectorAll("[data-publish-slot]")) {
    button.addEventListener("click", async () => {
      const section = button.closest("[data-provisional-slot]");
      const slot = button.dataset.publishSlot;
      const fields = Object.fromEntries([...section.querySelectorAll("input[name]")].map(input => [input.name, input.value]));
      const count = data.buckets.find(bucket => bucket.slot === slot)?.count || 0;
      if (!confirm("暫定" + slot + " の " + count + "件を同じカードに移しますか？")) return;
      const message = section.querySelector(".provisional-publish-message");
      button.disabled = true;
      message.textContent = "カード化中…";
      try {
        const result = await apiFn("/api/provisional/" + slot + "/publish", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...fields, bucket_id: button.dataset.bucketId })
        });
        message.textContent = result.warning || "カード化しました。仕分け用タブに表示されます。";
        await Promise.resolve(afterPublish?.());
        await refreshProvisionalUI();
      } catch (error) {
        message.textContent = error.message;
        button.disabled = false;
      }
    });
  }
}

export async function refreshProvisionalUI() {
  if (!apiFn) return;
  const data = await apiFn("/api/provisional");
  renderOverview(data);
}

export async function initProvisionalUI(api, refreshCards) {
  apiFn = api;
  afterPublish = refreshCards;
  if (!initialized) {
    initialized = true;
    for (const button of document.querySelectorAll("[data-provisional-mode]")) {
      button.addEventListener("click", async () => {
        const buttons = [...document.querySelectorAll("[data-provisional-mode]")];
        buttons.forEach(item => item.disabled = true);
        $("provisionalModeStatus").textContent = "受信先を切替中…";
        try {
          const data = await apiFn("/api/receive-mode", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ mode: button.dataset.provisionalMode })
          });
          // Re-read group counts and the state after the server confirmed the change.
          renderOverview({ ...data, buckets: (await apiFn("/api/provisional")).buckets });
        } catch (error) {
          $("provisionalModeStatus").textContent = "切替失敗：" + error.message;
        } finally {
          buttons.forEach(item => item.disabled = false);
        }
      });
    }
    $("refreshProvisional").addEventListener("click", () =>
      refreshProvisionalUI().catch(error => { $("provisionalModeStatus").textContent = error.message; }));
  }
  await refreshProvisionalUI();
}
