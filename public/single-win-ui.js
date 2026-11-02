const STORAGE_KEY = 'winning-url-vault:single-win-pending:v1';
const confirmation = '単発当選として登録';
const sourceOf = value => value === 'chiritumo' ? 'chiritumo' : 'arunomatic';

// Keep only operation metadata on the device, never the URL/code payload.
export function createSingleWinController({ api, storage = localStorage, requestId = () => crypto.randomUUID() }) {
  const inflight = new Map();
  function pending() {
    let records;
    try { records = JSON.parse(storage.getItem(STORAGE_KEY) || '[]'); }
    catch { throw new Error('単発登録の確認情報を読み込めませんでした。端末の保存データは消していません。'); }
    if (!Array.isArray(records) || records.some(record => !record || typeof record.request_id !== 'string' ||
      typeof record.card_id !== 'string' || !['arunomatic', 'chiritumo'].includes(record.intake_source) ||
      !Number.isSafeInteger(record.count) || record.count <= 0 || !Array.isArray(record.ids) || record.ids.length !== record.count ||
      record.ids.some(id => typeof id !== 'string') || typeof record.preview_token !== 'string')) {
      throw new Error('単発登録の確認情報を読み込めませんでした。端末の保存データは消していません。');
    }
    return records;
  }
  function save(records) {
    try { storage.setItem(STORAGE_KEY, JSON.stringify(records)); }
    catch { throw new Error('単発登録の確認情報を端末に保存できません。保存領域を確認してから再操作してください。'); }
  }
  function prepare(preview) {
    if (!preview || !Number.isSafeInteger(preview.count) || preview.count <= 0 ||
      !Array.isArray(preview.ids) || preview.ids.length !== preview.count || new Set(preview.ids).size !== preview.count ||
      preview.ids.some(id => typeof id !== 'string') || !['arunomatic', 'chiritumo'].includes(preview.intake_source) ||
      !preview.preview_token || !preview.card_id) {
      throw new Error('登録対象を確認できません。仕分け一覧を更新してください。');
    }
    const records = pending();
    const existing = records.find(record => record.card_id === preview.card_id && record.intake_source === sourceOf(preview.intake_source));
    if (existing) return existing;
    const record = { request_id: requestId(), card_id: preview.card_id, intake_source: sourceOf(preview.intake_source),
      ids: [...preview.ids], preview_token: preview.preview_token, count: preview.count,
      product_name: preview.product_name || preview.display_name || '商品名未取得',
      product_spec: preview.product_spec || '', redemption_place: preview.redemption_place || '',
      valid_until: preview.valid_until || '', registration_date: preview.registration_date || '', attempted: false };
    save([...records, record]); return record;
  }
  function complete(record, receipt) {
    if (receipt?.state !== 'completed' || receipt.card_id !== record.card_id ||
      receipt.intake_source !== record.intake_source || !receipt.request_id || !receipt.campaign_id || !receipt.product_id ||
      !Number.isSafeInteger(receipt.assigned_count) || receipt.assigned_count < 0 || receipt.assigned_count > record.count) {
      throw new Error('単発登録の完了を確認できません。同じ受付情報で結果を確認できます。');
    }
    try { save(pending().filter(item => item.request_id !== record.request_id)); }
    catch { return { ...receipt, device_warning: '登録は完了しました。端末の確認表示が残る場合は、登録結果をもう一度確認してください。' }; }
    return receipt;
  }
  async function run(record) {
    if (record.attempted) {
      try {
        const receipt = await api(`/api/single-wins/${encodeURIComponent(record.request_id)}`);
        if (receipt.state === 'completed') return complete(record, receipt);
        if (receipt.state === 'needs_review') throw Object.assign(new Error('登録対象が変更されています。対象を確認し直してください。'), { code: 'SINGLE_WIN_PREVIEW_CHANGED' });
        if (receipt.state !== 'pending') throw new Error('登録結果を確認できません。もう一度結果を確認してください。');
      } catch (error) {
        if (error.status !== 404 || error.code !== 'SINGLE_WIN_NOT_FOUND') throw error;
      }
    }
    const records = pending(), saved = records.find(item => item.request_id === record.request_id);
    if (!saved) throw new Error('登録の確認情報が見つかりません。一覧を更新してください。');
    saved.attempted = true; record.attempted = true; save(records);
    const receipt = await api(`/api/cards/${encodeURIComponent(record.card_id)}/single-win?intake_source=${record.intake_source}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request_id: record.request_id, ids: record.ids, preview_token: record.preview_token, confirmation })
    });
    return complete(record, receipt);
  }
  function submit(record) {
    if (inflight.has(record.request_id)) return inflight.get(record.request_id);
    const result = run(record).finally(() => inflight.delete(record.request_id));
    inflight.set(record.request_id, result); return result;
  }
  async function replaceChanged(record) {
    // Only an absent or server-invalidated operation may be replaced. A pending
    // operation keeps its original IDs so a lost response cannot create a second campaign.
    try {
      const receipt = await api(`/api/single-wins/${encodeURIComponent(record.request_id)}`);
      if (receipt.state !== 'needs_review' || receipt.card_id !== record.card_id || receipt.intake_source !== record.intake_source) {
        throw new Error('登録処理が保存されています。登録結果の確認を続けてください。');
      }
    } catch (error) {
      if (error.status !== 404 || error.code !== 'SINGLE_WIN_NOT_FOUND') throw error;
    }
    save(pending().filter(item => item.request_id !== record.request_id));
  }
  return { pending, prepare, submit, replaceChanged };
}

export function initSingleWinUI({ api, onSaved, onChange = () => {}, storage = localStorage }) {
  const controller = createSingleWinController({ api, storage });
  let dialog, current, busy = false, writing = false, generation = 0;
  function ensureDialog() {
    if (dialog) return dialog;
    dialog = document.createElement('dialog'); dialog.id = 'singleWinDialog';
    dialog.setAttribute('aria-labelledby', 'singleWinTitle');
    dialog.innerHTML = '<div class="dialog-head"><h2 id="singleWinTitle">単発当選を登録</h2><button type="button" class="secondary" data-close>閉じる</button></div><p>キャンペーン名の入力は不要です。</p><p class="single-win-details" data-details></p><p data-message role="status"></p><div class="actions"><button type="button" data-submit>単発当選として登録</button><button type="button" class="secondary hidden" data-preview>対象を確認し直す</button></div>';
    document.body.append(dialog);
    dialog.querySelector('[data-close]').onclick = () => { if (!writing) { generation++; busy = false; dialog.close(); } };
    dialog.addEventListener('cancel', event => { if (writing) event.preventDefault(); else { generation++; busy = false; } });
    dialog.querySelector('[data-submit]').onclick = submit;
    dialog.querySelector('[data-preview]').onclick = async () => {
      const record = current?.record;
      if (!record || busy) return;
      setBusy(true, true);
      try { await controller.replaceChanged(record); onChange(); setBusy(false); await open(record.card_id, record.intake_source); }
      catch (error) { message(error.message); setBusy(false); }
    };
    return dialog;
  }
  function message(text) { dialog.querySelector('[data-message]').textContent = text; }
  function setBusy(value, lockClose = false) {
    busy = value; writing = value && lockClose;
    dialog.querySelectorAll('button').forEach(button => { button.disabled = value; });
    dialog.querySelector('[data-close]').disabled = writing;
  }
  function showDetails(data) {
    dialog.querySelector('[data-details]').textContent = [data.product_name || data.display_name || '商品名未取得',
      [data.product_spec, data.redemption_place].filter(Boolean).join(' / '), data.valid_until ? `期限 ${data.valid_until}` : '',
      `登録対象 ${data.count.toLocaleString()}件`, data.registration_date ? `登録日 ${data.registration_date}` : ''].filter(Boolean).join('\n');
  }
  async function open(cardId, source = 'arunomatic') {
    if (busy) return;
    ensureDialog(); const request = ++generation; source = sourceOf(source); current = null;
    dialog.querySelector('[data-details]').textContent = '';
    dialog.querySelector('[data-preview]').classList.add('hidden');
    dialog.querySelector('[data-submit]').textContent = '単発当選として登録';
    message('登録対象を確認中…'); if (!dialog.open) dialog.showModal(); setBusy(true);
    try {
      const existing = controller.pending().find(record => record.card_id === cardId && record.intake_source === source);
      const preview = existing || await api(`/api/cards/${encodeURIComponent(cardId)}/single-win-preview?intake_source=${source}`);
      if (request !== generation || !dialog.open) return;
      if (preview.card_id !== cardId || preview.intake_source !== source) throw new Error('登録対象の照合に失敗しました。一覧を更新してください。');
      if (!preview.count) { message('登録できる未仕分けデータはありません。一覧を更新してください。'); return; }
      current = { cardId, source, preview, record: existing || null }; showDetails(preview);
      dialog.querySelector('[data-submit]').textContent = existing ? '登録結果を確認・再送' : '単発当選として登録';
      message(existing ? '前回の登録結果を確認します。必要な場合も同じ受付情報で再送します。' : 'この件数を単発当選として登録します。');
    } catch (error) { if (request === generation && dialog.open) message(error.message); }
    finally { if (request === generation) { setBusy(false); dialog.querySelector('[data-submit]').disabled = !current; } }
  }
  async function submit() {
    if (busy || !current) return;
    setBusy(true, true); message('登録を確認中…');
    let result;
    try {
      current.record ||= controller.prepare(current.preview); onChange();
      result = await controller.submit(current.record);
    } catch (error) {
      message(error.code === 'SINGLE_WIN_PRODUCT_INVALID' ? error.message : `登録の完了を確認できませんでした。${error.message}`);
      dialog.querySelector('[data-submit]').textContent = '登録結果を確認・再送';
      dialog.querySelector('[data-preview]').classList.toggle('hidden', error.code !== 'SINGLE_WIN_PREVIEW_CHANGED');
      setBusy(false); onChange(); return;
    }
    const source = current.source; current = null; setBusy(false); generation++; dialog.close(); onChange();
    // A committed registration never becomes a send failure if refreshing fails.
    try { await onSaved(result, source); }
    catch { /* The application keeps its previous list and exposes its refresh state. */ }
  }
  function renderRecovery(source) {
    let panel = document.getElementById('singleWinRecovery');
    if (!panel) {
      panel = document.createElement('section'); panel.id = 'singleWinRecovery'; panel.className = 'sorting-action-notice hidden';
      panel.setAttribute('role', 'status'); document.getElementById('sortingMetric').after(panel);
    }
    panel.replaceChildren();
    try {
      const records = controller.pending().filter(record => record.intake_source === sourceOf(source));
      panel.classList.toggle('hidden', !records.length);
      for (const record of records) {
        const row = document.createElement('div'), text = document.createElement('p'), button = document.createElement('button');
        text.textContent = `${record.product_name}・${record.count}件：単発登録の結果が未確認です。`;
        button.type = 'button'; button.className = 'secondary'; button.textContent = '登録結果を確認・再送';
        button.onclick = () => open(record.card_id, record.intake_source); row.append(text, button); panel.append(row);
      }
    } catch (error) { panel.classList.remove('hidden'); panel.textContent = error.message; }
  }
  return { open, renderRecovery };
}
