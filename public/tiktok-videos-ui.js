import { TIKTOK_VIDEO_NAME } from './tiktok-video.js';

export function tikTokVideoCardHtml(item) {
  const remaining = Number(item.unexported_count || 0);
  return `<div class="product-heading"><h3>${TIKTOK_VIDEO_NAME}</h3><span class="product-total">合計${Number(item.total_count || 0).toLocaleString()}件</span></div>
    <div class="product-body"><div class="product-meta"><span>サブ機から受信した動画URL</span><span>単価登録不要・収益集計対象外</span></div>
    <div class="product-controls"><small class="product-method">受信順・URLのみ</small><div class="product-actions"><button class="extract-button" data-tiktok-copy ${remaining ? '' : 'disabled'}><span>一括コピー</span><strong>${remaining.toLocaleString()}</strong><span>件</span></button></div></div></div><button type="button" class="secondary" data-tiktok-undo>直前の動画抽出を取り消す</button>`;
}

export function initTikTokVideosUI({api,writeClipboard,refresh}) {
  const dialog = document.createElement('dialog');
  dialog.id = 'tiktokVideoCopyDialog';
  dialog.setAttribute('aria-labelledby','tiktokVideoCopyTitle');
  dialog.innerHTML = `<h2 id="tiktokVideoCopyTitle">${TIKTOK_VIDEO_NAME}</h2><p data-summary></p>
    <p>あるてぃかーのURL入力欄に貼り付けてください。貼り付け後に「抽出済みにする」を押します。</p>
    <textarea data-links rows="8" readonly aria-label="コピーする動画URL"></textarea>
    <p data-message role="status"></p><div class="dialog-actions">
    <button type="button" data-copy>一括コピー</button><button type="button" data-complete>抽出済みにする</button>
    <button type="button" class="secondary" data-cancel>中断する</button>
    <button type="button" class="secondary" data-close>閉じる</button></div>`;
  document.body.appendChild(dialog);
  const el = selector => dialog.querySelector(selector);
  const message = text => { el('[data-message]').textContent = text; };
  let batch = null, busy = false, copied = false;
  const key = 'winning-url-vault:last-tiktok-batch';
  function show(next) {
    batch = next; copied = false;
    el('[data-summary]').textContent = `${next.count.toLocaleString()}件・受信順`;
    el('[data-links]').value = next.items.map(item=>item.value).join('\n');
    el('[data-complete]').disabled = true;
    message('コピーに成功してから抽出済みにできます。');
    if (!dialog.open) dialog.showModal();
  }
  async function copy() {
    await writeClipboard(el('[data-links]').value);
    copied = true; el('[data-complete]').disabled = false;
    message('コピーしました。あるてぃかーに貼り付けてください。');
  }
  async function run(action) {
    if (busy) return;
    busy = true;
    try { await action(); } catch(error) { message(error.message); }
    finally { busy = false; }
  }
  el('[data-copy]').onclick = () => run(copy);
  el('[data-close]').onclick = () => { if (!busy) dialog.close(); };
  dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
  el('[data-cancel]').onclick = () => run(async()=>{
    await api(`/api/tiktok-videos/export-batches/${batch.id}`,{method:'DELETE'});
    batch = null; dialog.close(); await refresh();
  });
  el('[data-complete]').onclick = () => run(async()=>{
    if (!batch || !copied) return;
    const result = await api(`/api/tiktok-videos/export-batches/${batch.id}/complete`,{method:'POST'});
    try { localStorage.setItem(key,batch.id); } catch {}
    batch = null; dialog.close(); await refresh();
    alert(`${result.changed_count.toLocaleString()}件を抽出済みにしました。`);
  });
  return {
    async open() {
      if (busy) return;
      busy = true;
      try {
        const result = await api('/api/tiktok-videos/export-batches',{method:'POST'});
        show(result.batch);
        try { await copy(); } catch { message('自動コピーできませんでした。「一括コピー」を押してください。'); }
      } catch(error) { alert(error.message); } finally { busy = false; }
    },
    async undo() {
      let id = ''; try { id = localStorage.getItem(key) || ''; } catch {}
      if (!id || !confirm('直前に抽出済みにした動画URLを未抽出へ戻しますか？')) return;
      try {
        await api(`/api/tiktok-videos/export-batches/${id}/undo`,{method:'POST'});
        try { localStorage.removeItem(key); } catch {}
        await refresh();
      } catch(error) { alert(error.message); }
    }
  };
}
