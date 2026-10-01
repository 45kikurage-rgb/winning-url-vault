(() => {
  let campaigns = [];
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
  const api = async (path, options) => {
    const response = await fetch(path, options);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) throw new Error(payload.error || `API error ${response.status}`);
    return payload;
  };
  const dateLabel = campaign => campaign.lottery_start_date || "開始日未設定";
  const stateLabel = status => ({active:"実行中",closing:"終了確認待ち",closed:"終了済み",correcting:"訂正中"})[status] || status;

  function ensureUi() {
    if (document.getElementById("ledgerPanel")) return;
    const panel = document.createElement("section");
    panel.id = "ledgerPanel";
    panel.className = "panel";
    panel.innerHTML = `<div class="row"><div><h2>キャンペーン仕分け</h2><p>中央管理台帳のcampaign_idで商品を紐付けます。</p></div><button id="ledgerRetry" class="secondary">同期再送</button></div>
      <p id="ledgerSync" class="result"></p><h3>仕分け待ち</h3><div id="ledgerCards" class="grid"></div><h3>キャンペーン</h3><div id="ledgerCampaigns" class="grid"></div>`;
    const unresolved = document.querySelector(".unresolved.panel");
    (unresolved?.parentNode || document.querySelector("main"))?.insertBefore(panel, unresolved || null);

    const assignDialog = document.createElement("dialog");
    assignDialog.id = "assignCampaignDialog";
    assignDialog.innerHTML = `<div class="dialog-head"><div><small>商品仕分け</small><h2 id="assignTitle">キャンペーンを選択</h2></div><button id="assignClose" class="secondary">閉じる</button></div>
      <label>キャンペーン<select id="assignCampaign"></select></label><p id="assignMessage" class="result"></p><button id="assignConfirm">振り分ける</button>`;
    document.body.append(assignDialog);

    const closeDialog = document.createElement("dialog");
    closeDialog.id = "closeCampaignDialog";
    closeDialog.innerHTML = `<div class="dialog-head"><div><small>終了確認</small><h2 id="closeTitle"></h2></div><button id="closeCancel" class="secondary">閉じる</button></div>
      <div id="closePreview"></div><label id="mismatchConfirm" class="hidden"><input id="acceptMismatch" type="checkbox"> 差分を確認して終了する</label>
      <p id="closeMessage" class="result"></p><button id="closeConfirm">終了を確定</button>`;
    document.body.append(closeDialog);

    document.getElementById("assignClose").onclick = () => assignDialog.close();
    document.getElementById("closeCancel").onclick = () => closeDialog.close();
    document.getElementById("ledgerRetry").onclick = retrySync;
  }

  function campaignOptions() {
    return campaigns.filter(c => c.assignable).map(c => `<option value="${esc(c.campaign_id)}">${esc(c.campaign_name)} / ${esc(dateLabel(c))} / ${esc(stateLabel(c.status))}</option>`).join("");
  }
  function renderCampaign(c) {
    const action = c.status === "closing" || c.status === "correcting"
      ? `<button class="secondary" data-close="${esc(c.campaign_id)}">終了確認</button>`
      : c.status === "closed"
        ? `<button class="secondary" data-correct="${esc(c.campaign_id)}">訂正開始</button>` : "";
    return `<article class="coupon"><div><h3>${esc(c.campaign_name)}</h3><div class="meta">抽選開始日 ${esc(dateLabel(c))}</div><div class="meta">${esc(stateLabel(c.status))}</div></div><div class="coupon-foot">${action}</div></article>`;
  }
  function renderCard(card) {
    const assignments = card.assignments.map(a => `<small>${esc(a.campaign_id)}: ${a.winner_count.toLocaleString()}件</small>`).join(" ");
    return `<article class="coupon"><div><h3>${esc(card.display_name)}</h3><div class="meta">${esc(card.redeem_place || "")} ${card.specification ? `/ ${esc(card.specification)}` : ""}</div><div class="meta">期限 ${esc(card.expires_on || "期限なし")}</div>${assignments ? `<div class="meta">${assignments}</div>` : ""}</div>
      <div class="coupon-foot"><strong>未仕分け ${card.unassigned_count.toLocaleString()}件</strong>${card.unassigned_count ? `<button class="secondary" data-assign="${esc(card.card_id)}" data-name="${esc(card.display_name)}">振り分け</button>` : ""}</div></article>`;
  }
  async function loadLedger() {
    ensureUi();
    if (document.getElementById("app")?.classList.contains("hidden")) return;
    try {
      const [campaignResult, cardResult] = await Promise.all([api("/api/ledger/campaigns"),api("/api/ledger/sorting/cards")]);
      campaigns = campaignResult.campaigns || [];
      document.getElementById("ledgerCampaigns").innerHTML = campaigns.length ? campaigns.map(renderCampaign).join("") : '<div class="empty">キャンペーンがありません</div>';
      document.getElementById("ledgerCards").innerHTML = cardResult.cards?.length ? cardResult.cards.map(renderCard).join("") : '<div class="empty">仕分け対象がありません</div>';
      document.getElementById("ledgerSync").textContent = `中央台帳同期: 未送信 ${cardResult.sync?.pending || 0}件 / エラー ${cardResult.sync?.failed || 0}件`;
      bindActions();
    } catch (error) {
      document.getElementById("ledgerSync").textContent = error.message;
    }
  }
  function bindActions() {
    document.querySelectorAll("[data-assign]").forEach(button => button.onclick = () => openAssign(button.dataset.assign,button.dataset.name));
    document.querySelectorAll("[data-close]").forEach(button => button.onclick = () => openClose(button.dataset.close));
    document.querySelectorAll("[data-correct]").forEach(button => button.onclick = () => startCorrection(button.dataset.correct));
  }
  function openAssign(cardId,name) {
    const dialog = document.getElementById("assignCampaignDialog");
    dialog.dataset.cardId = cardId;
    document.getElementById("assignTitle").textContent = name || "キャンペーンを選択";
    document.getElementById("assignCampaign").innerHTML = campaignOptions();
    document.getElementById("assignMessage").textContent = campaigns.some(c=>c.assignable) ? "" : "仕分け可能なキャンペーンがありません";
    document.getElementById("assignConfirm").disabled = !campaigns.some(c=>c.assignable);
    document.getElementById("assignConfirm").onclick = assignCampaign;
    dialog.showModal();
  }
  async function assignCampaign() {
    const dialog=document.getElementById("assignCampaignDialog"), button=document.getElementById("assignConfirm");
    button.disabled=true;
    try {
      const result=await api(`/api/ledger/cards/${dialog.dataset.cardId}/assign`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({campaign_id:document.getElementById("assignCampaign").value})});
      document.getElementById("assignMessage").textContent=`${result.assigned}件を仕分けました`;
      await loadLedger(); setTimeout(()=>dialog.close(),500);
    } catch(error) { document.getElementById("assignMessage").textContent=error.message; }
    finally { button.disabled=false; }
  }
  async function openClose(campaignId) {
    const campaign=campaigns.find(c=>c.campaign_id===campaignId), dialog=document.getElementById("closeCampaignDialog");
    dialog.dataset.campaignId=campaignId; document.getElementById("closeTitle").textContent=campaign ? `${campaign.campaign_name} ${dateLabel(campaign)}` : campaignId;
    document.getElementById("closePreview").textContent="確認中…"; document.getElementById("closeMessage").textContent=""; dialog.showModal();
    try {
      const result=await api(`/api/ledger/campaigns/${campaignId}/close-preview`), p=result.preview;
      dialog.dataset.previewToken=p.preview_token;
      document.getElementById("closePreview").innerHTML=`<p>総当選数 <strong>${Number(p.final_winner_count||0).toLocaleString()}件</strong></p><p>商品別合計 <strong>${Number(p.final_product_winner_count||0).toLocaleString()}件</strong></p><p>差分 <strong>${Number(p.winner_count_difference||0).toLocaleString()}件</strong></p>`;
      document.getElementById("mismatchConfirm").classList.toggle("hidden",!p.has_mismatch); document.getElementById("acceptMismatch").checked=false;
      document.getElementById("closeConfirm").onclick=confirmClose;
    } catch(error) { document.getElementById("closePreview").textContent=error.message; }
  }
  async function confirmClose() {
    const dialog=document.getElementById("closeCampaignDialog"), button=document.getElementById("closeConfirm"); button.disabled=true;
    try {
      await api(`/api/ledger/campaigns/${dialog.dataset.campaignId}/close`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({preview_token:dialog.dataset.previewToken,accept_mismatch:document.getElementById("acceptMismatch").checked})});
      document.getElementById("closeMessage").textContent="終了確定を中央管理台帳へ送信しました"; await loadLedger(); setTimeout(()=>dialog.close(),700);
    } catch(error) { document.getElementById("closeMessage").textContent=error.message; }
    finally { button.disabled=false; }
  }
  async function startCorrection(campaignId) {
    const reason=prompt("訂正理由を入力してください"); if (!reason?.trim()) return;
    try { await api(`/api/ledger/campaigns/${campaignId}/corrections`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({reason:reason.trim()})}); await loadLedger(); }
    catch(error) { alert(error.message); }
  }
  async function retrySync() {
    const button=document.getElementById("ledgerRetry"); button.disabled=true;
    try { const result=await api("/api/ledger/outbox/retry",{method:"POST"}); document.getElementById("ledgerSync").textContent=`再送: ${result.sent||0}件成功 / 未送信 ${result.pending||0}件 / エラー ${result.failed||0}件`; await loadLedger(); }
    catch(error) { document.getElementById("ledgerSync").textContent=error.message; }
    finally { button.disabled=false; }
  }
  const timer=setInterval(loadLedger,5000);
  window.addEventListener("beforeunload",()=>clearInterval(timer));
  setTimeout(loadLedger,800);
})();
