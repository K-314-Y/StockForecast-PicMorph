const $ = id => document.getElementById(id);
const fmt = n => Number(n).toLocaleString('ja-JP', {maximumFractionDigits: 2});
let growthRevision = null;
let currentGearId = null;
let ticket = null;
let busy = false;
let skipArmed = false;
let result = null;
let dayIndex = 0;
let savedCompanion = null;
let companionSaving = false;
let handoffPending = false;
let handoffInvalid = false;
const approachLabels = {trend:'トレンド', momentum:'勢い', reversion:'反転', volatility:'変動'};
const creatorIds = ['creatorName','creatorHair','creatorClothing','creatorApproach','creatorRisk'];
const resultName = () => result?.brain?.kind === 'trained_practice_only' ?
  '学習済み練習版' : result?.companion_name || '標準モデル';

async function call(path, body) {
  const response = await fetch(path, body === undefined ? undefined : {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body),
  });
  let value;
  try { value = await response.json(); }
  catch { throw Error('サーバーの応答を読み込めません'); }
  if (!response.ok) throw Error(value.error || 'ゲームサーバーに接続できません');
  return value;
}

function scene(mood, message) {
  $('scene').dataset.mood = mood;
  $('speech').textContent = message;
}

function refreshButtons() {
  $('play').disabled = busy || companionSaving || ticket !== null || handoffPending || handoffInvalid;
  $('saveCompanion').disabled = busy || companionSaving || savedCompanion === null;
  $('reloadCompanion').disabled = busy || companionSaving;
  for (const id of creatorIds) $(id).disabled = busy || companionSaving;
  $('claim').disabled = busy || ticket === null || growthRevision === null;
  $('discard').hidden = ticket === null;
  $('discard').disabled = busy;
  $('refreshGrowth').disabled = busy;
  $('loadSkins').disabled = busy;
  $('skinSelect').disabled = busy;
  $('loadBrains').disabled = busy || companionSaving || ticket !== null;
  $('brainSelect').disabled = busy || companionSaving || ticket !== null;
  $('gear').disabled = busy || growthRevision === null;
  $('equip').disabled = busy || growthRevision === null ||
    !$('gear').value || $('gear').value === currentGearId;
  $('next').disabled = busy || !result || dayIndex >= result.decisions.length - 1;
}

async function loadGrowth() {
  const growth = await call('/api/growth');
  const mine = Array.isArray(growth.slots) && growth.slots.find(item => item.slot === 'mine');
  if (!mine || !Array.isArray(mine.gear_options) || !Number.isSafeInteger(growth.revision)) {
    throw Error('育成記録の形式が不正です');
  }
  growthRevision = growth.revision;
  currentGearId = mine.gear;
  $('growthInfo').textContent = 'Lv.' + mine.level + ' / ' + mine.xp + ' XP';
  const options = $('gear');
  options.replaceChildren();
  for (const item of mine.gear_options) {
    const option = document.createElement('option');
    option.value = item.id;
    option.disabled = !item.unlocked;
    option.textContent = item.icon + ' ' + item.name +
      (item.unlocked ? '' : '（解放まであと ' + (item.unlock_xp - mine.xp) + ' XP）');
    options.append(option);
  }
  options.value = mine.gear;
  const equipped = mine.gear_options.find(item => item.id === mine.gear);
  $('currentGear').textContent = '現在の装備: ' + (equipped ? equipped.icon + ' ' + equipped.name : mine.gear);
  refreshButtons();
  return growth;
}

function chooseDay(index) {
  if (!result || index < 0 || index >= result.decisions.length) return;
  dayIndex = index;
  for (const [i, button] of [...$('days').children].entries()) {
    button.setAttribute('aria-pressed', String(i === index));
  }
  const choice = result.decisions[index];
  const signal = choice.signals.mine;
  const brainLabel = result.brain?.kind === 'trained_practice_only' ?
    '保存した練習版' : '標準モデル';
  $('dayCount').textContent = (index + 1) + ' / ' + result.decisions.length + ' 日目';
  $('dayDetail').textContent = (index + 1) + '日目: 架空価格 ' +
    fmt(choice.price) + ' C / 判断 ' + signal +
    ' / 仮想コイン残高 ' + fmt(result.equity_path[index + 1]) + ' C';
  if (signal === 'CASH') {
    scene('cautious', resultName() + 'は今日は現金待機。動かない判断も大切だよ。');
  } else if (signal === 'LONG') {
    scene('thinking', resultName() + 'は上昇を狙う判断。結果を確かめよう。');
  } else {
    scene('thinking', resultName() + 'の判断は「' + signal + '」。結果を確かめよう。');
  }
  $('next').textContent = index === result.decisions.length - 1 ?
    '12日間を確認しました' : '次の日を見る';
  refreshButtons();
}

function showResult(value) {
  if (value.mode !== 'PRACTICE_SYNTHETIC_ONLY' ||
      !Array.isArray(value.decisions) || value.decisions.length !== 12 ||
      !Array.isArray(value.equity_path) || value.equity_path.length !== 13 ||
      !value.decisions.every(item => item && item.signals &&
        typeof item.signals.mine === 'string' && Number.isFinite(item.price)) ||
      !value.equity_path.every(n => Number.isFinite(n)) ||
      !Number.isFinite(value.final_coins) ||
      !Number.isFinite(value.profit_coins) || !Number.isFinite(value.max_drawdown_pct)) {
    throw Error('練習結果の形式が不正です');
  }
  result = value;
  const trained = value.brain?.kind === 'trained_practice_only';
  $('resultTitle').textContent = resultName() + 'の12日間の練習結果';
  $('resultCompanion').textContent = trained ?
    '保存した学習済み練習版を予測に使用しました。相棒フォームの判断ルールは適用していません。架空40点で学習・実相場精度は未検証です。' :
    value.companion_created ?
    resultName() + ' / 保存revision ' + value.companion_revision + ' / ' +
    approachLabels[value.approach] + 'を重視 / 資金使用率 ' + value.risk_percent + '%。保存した独自設定を練習に反映しました。' :
    '未作成の標準モデルで練習しました。相棒を保存すると独自設定が反映されます。';
  $('modelJudgmentHeading').textContent = trained ?
    '日ごとに保存した練習版の判断を見よう' : '日ごとに相棒の判断を見よう';
  $('brainResult').textContent = trained ?
    '実行に使ったモデル：学習済み練習版 ' + value.brain.version_id +
    '（固定架空40点で学習・実相場精度未検証）' :
    value.companion_created ? '実行に使ったモデル：保存した相棒 ' + resultName() :
    '実行に使ったモデル：標準モデル mine';
  $('brainProof').hidden = !trained;
  $('brainProofText').textContent = trained ?
    '保存版のモデル設定: ' + value.brain.parameters_sha256 +
    ' / 装備込みの実行モデル: ' + value.brain.effective_sha256 : '';
  $('final').textContent = fmt(value.final_coins) + ' C';
  $('profit').textContent = (value.profit_coins >= 0 ? '+' : '') + fmt(value.profit_coins) + ' C';
  $('drawdown').textContent = fmt(value.max_drawdown_pct) + '%';
  const container = $('days');
  container.replaceChildren();
  for (let i = 0; i < value.decisions.length; i++) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = String(i + 1);
    button.setAttribute('aria-label', (i + 1) + '日目の結果');
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => chooseDay(i));
    container.append(button);
  }
  $('result').hidden = false;
  $('play').textContent = '↻ もう一度練習する';
  chooseDay(0);
}

async function play() {
  if (busy || companionSaving || ticket !== null || handoffPending || handoffInvalid) return;
  busy = true; skipArmed = false;
  $('reward').textContent = '';
  $('result').hidden = true;
  result = null;
  refreshButtons();
  scene('thinking', '未来は見ないで、今日の判断を考えているよ…');
  $('status').textContent = 'Pythonで予測判断を作成し、Node.jsで架空コインを計算しています…';
  try {
    const selectedId = $('brainSelect').value;
    const payload = {allocations: {mine: 100, owl: 0, turtle: 0}};
    if (selectedId) {
      if (!/^tv_[0-9a-f]{32}$/.test(selectedId)) throw Error('練習版IDが不正です');
      payload.trained_version_id = selectedId;
    }
    const value = await call('/api/practice', payload);
    if (selectedId && (value.brain?.version_id !== selectedId ||
        value.brain?.kind !== 'trained_practice_only')) {
      throw Error('選択した練習版の実行確認ができません');
    }
    showResult(value);
    ticket = typeof value.training_ticket === 'string' ? value.training_ticket : null;
    $('status').textContent = '練習完了！ 12日間を振り返り、XPを受け取って装備を変えよう。';
    if (ticket) $('reward').textContent = '受取前のXPがあります。次の練習の前に受け取ってください。';
    else $('reward').textContent = '受取可能なXPはありません。';
    try { await loadGrowth(); }
    catch (error) {
      growthRevision = null;
      $('growthInfo').textContent = '育成を読み込めません: ' + error.message;
      $('reward').textContent += ' 育成の取得に失敗しました。再読込して確認してください。';
    }
  } catch (error) {
    result = null;
    ticket = null;
    $('result').hidden = true;
    $('status').textContent = '練習に失敗しました: ' + error.message;
    scene('ready', 'まだ練習は始まっていないよ。もう一度挑戦しよう。');
  } finally {
    busy = false;
    refreshButtons();
  }
}

async function claim() {
  if (busy || ticket === null || growthRevision === null) return;
  busy = true; skipArmed = false; refreshButtons();
  $('discard').textContent = '報酬を辞退して再挑戦';
  $('reward').textContent = 'XPを受け取っています…';
  const requestedTicket = ticket;
  try {
    const response = await call('/api/training/complete', {
      ticket: requestedTicket, expected_growth_revision: growthRevision,
    });
    const earned = Object.entries(response.earned_xp || {}).map(
      ([name, amount]) => name + ': +' + amount + ' XP'
    ).join(' / ');
    ticket = null;
    $('reward').textContent = earned ?
      earned + '。同じ実績からのXPは一度だけです。' : 'この実績のXPはすでに受け取り済みです。';
    try { await loadGrowth(); }
    catch (error) {
      $('growthInfo').textContent = 'XP受取は成功しました。育成表示の再読込が必要です: ' + error.message;
    }
    scene('growth', '冒険の記録が増えたね！装備を選んで再挑戦しよう。');
  } catch (error) {
    $('reward').textContent = '受取結果を確定できません: ' + error.message +
      '。育成を再確認してから再試行してください。';
    try { await loadGrowth(); }
    catch (refreshError) {
      growthRevision = null;
      $('growthInfo').textContent = '育成確認に失敗: ' + refreshError.message;
    }
  } finally {
    busy = false;
    refreshButtons();
  }
}

async function equip() {
  if (busy || growthRevision === null || !$('gear').value ||
      $('gear').value === currentGearId) return;
  busy = true; refreshButtons();
  $('gearStatus').textContent = '装備を保存しています…';
  try {
    await call('/api/growth/equip', {
      slot: 'mine', gear_id: $('gear').value,
      expected_growth_revision: growthRevision,
    });
    $('gearStatus').textContent = '装備を変更しました。次の練習で効果を試そう。';
    try { await loadGrowth(); }
    catch (error) {
      growthRevision = null;
      $('growthInfo').textContent = '装備変更は成功しました。育成表示は再読込してください: ' + error.message;
    }
    scene('happy', '新しい装備、似合ってる？次の冒険に行こう！');
  } catch (error) {
    $('gearStatus').textContent = '装備を確認できません: ' + error.message;
    try { await loadGrowth(); }
    catch {
      growthRevision = null;
      $('growthInfo').textContent = '育成を読み込めません。画面を再読込してください。';
    }
  } finally {
    busy = false;
    refreshButtons();
  }
}

function discard() {
  if (busy || ticket === null) return;
  if (!skipArmed) {
    skipArmed = true;
    $('discard').textContent = '本当にXPを辞退する（再度押す）';
    $('reward').textContent = 'この練習の受取券を破棄します。取り消す場合は「XPを受け取る」を押してください。';
    return;
  }
  ticket = null; skipArmed = false;
  $('discard').textContent = '報酬を辞退して再挑戦';
  $('reward').textContent = '受取券を破棄しました。練習はもう一度できます。';
  scene('ready', 'もう一度、12日間を試してみよう！');
  refreshButtons();
}

// Appearance is purely page-local and never changes the forecast model or XP.
let skinEpoch = 0;
function defaultSkin(message='デモ用キャラを表示しています。') {
  skinEpoch++;
  const img = $('portrait');
  img.hidden = true;
  img.onload = null; img.onerror = null;
  img.src = '';
  $('chibi').hidden = false;
  $('skinCaption').textContent = '外見：カスタムchibi（編集中は一時プレビュー）';
  $('skinStatus').textContent = message;
}
async function loadSkins(preferredId = '') {
  if (busy) return;
  const button = $('loadSkins');
  button.disabled = true;
  $('skinStatus').textContent = '保存キャラを読み込んでいます…';
  try {
    const catalog = await call('/api/appearance/drafts');
    if (!Array.isArray(catalog.drafts)) throw Error('一覧の形式が不正です');
    const select = $('skinSelect');
    select.replaceChildren();
    const fallback = document.createElement('option');
    fallback.value = '';
    fallback.textContent = 'カスタムchibi（自分の外見）';
    select.append(fallback);
    for (const draft of catalog.drafts) {
      if (!/^bp_[a-f0-9]{32}$/.test(draft.id) || typeof draft.name !== 'string') continue;
      const option = document.createElement('option');
      option.value = draft.id;
      option.disabled = !draft.has_image;
      option.textContent = draft.name + (draft.has_image ? ' · 外見だけ' : ' · 画像なし');
      select.append(option);
    }
    const matched = preferredId && [...select.children].some(option =>
      option.value === preferredId && !option.disabled);
    select.value = matched ? preferredId : '';
    if (matched) {
      chooseSkin();
    } else {
      defaultSkin(preferredId ?
        'この下書きの画像は未登録・削除済みです。外見だけ初期表示に戻しました。予測版の選択には影響しません。' :
        catalog.drafts.length ?
        '保存キャラを読み込みました。選択すると外見だけ変わります。' :
        '保存キャラはまだありません。初期キャラでそのまま遊べます。');
    }
  } catch (error) {
    defaultSkin('一覧を読み込めません: ' + error.message + '。デモ用キャラで遊べます。');
  } finally {
    button.disabled = busy;
  }
}
function chooseSkin() {
  const select = $('skinSelect');
  const id = select.value;
  if (!id || !/^bp_[a-f0-9]{32}$/.test(id)) {
    defaultSkin();
    return;
  }
  const item = [...select.children].find(option => option.value === id);
  if (!item || item.disabled) {
    select.value = '';
    defaultSkin('画像がありません。デモ用キャラに戻しました。');
    return;
  }
  const epoch = ++skinEpoch;
  const img = $('portrait');
  img.hidden = true;
  $('chibi').hidden = false;
  $('skinStatus').textContent = '外見の画像を確認しています…';
  img.onload = () => {
    if (epoch !== skinEpoch || select.value !== id) return;
    img.hidden = false;
    $('chibi').hidden = true;
    $('skinCaption').textContent = '外見：' + item.textContent.replace(/ · 外見だけ$/, '') + '（DRAFT）';
    $('skinStatus').textContent = '外見のみ変更済み。予測は保存済み相棒のルール（未作成なら標準モデルmine）です。';
  };
  img.onerror = () => {
    if (epoch !== skinEpoch) return;
    select.value = '';
    defaultSkin('外見データが見つからないか壊れています。初期外見に戻しました。');
  };
  img.src = '/api/appearance/image/' + id;
}
async function loadBrains(preferredId = '', expectedDraftId = '') {
  if (busy || companionSaving || ticket !== null) return;
  const button = $('loadBrains');
  button.disabled = true;
  $('brainNotice').textContent = '保存した練習版を確認しています…';
  try {
    const result = await call('/api/trained/versions');
    if (!Array.isArray(result.versions)) throw Error('練習版の一覧が不正です');
    const select = $('brainSelect');
    select.replaceChildren();
    const standard = document.createElement('option');
    standard.value = ''; standard.textContent = '標準モデル mine';
    select.append(standard);
    for (const version of result.versions) {
      if (!/^tv_[0-9a-f]{32}$/.test(version?.id) ||
          !/^bp_[0-9a-f]{32}$/.test(version?.source_draft_id)) continue;
      const option = document.createElement('option');
      option.value = version.id;
      option.textContent = '練習版 ' + version.id.slice(0, 11) + ' · 元キャラ ' +
        (typeof version.source_name === 'string' && version.source_name ?
          version.source_name : version.source_draft_id.slice(0, 11));
      select.append(option);
    }
    const matched = preferredId && [...select.children].some(option =>
      option.value === preferredId) && result.versions.some(version =>
      version.id === preferredId && (!expectedDraftId ||
      version.source_draft_id === expectedDraftId));
    select.value = matched ? preferredId : '';
    if (preferredId) {
      handoffInvalid = !matched;
      $('resetBrain').hidden = matched;
      refreshButtons();
    }
    $('brainNotice').textContent = preferredId ?
      (matched ?
        '制作画面から練習版を引き継ぎました。「練習スタート」を押すとこのモデルで開始します。' :
        '指定された練習版が存在しないか元の下書きが一致しません。別のモデルを使う前に選択を確認してください。') :
      result.versions.length ?
        '保存した練習版を選択できます。実相場の精度は未検証です。' :
        '学習済み練習版はまだありません。標準モデルで遊べます。';
    showNextBrain();
  } catch (error) {
    if (preferredId) {
      handoffInvalid = true;
      $('resetBrain').hidden = false;
      refreshButtons();
    }
    $('brainNotice').textContent = '練習版を読み込めません: ' + error.message +
      (preferredId ? '。誤ったモデルで始めないよう練習を停止しました。' : '。標準モデルは使えます。');
  } finally { button.disabled = busy || companionSaving || ticket !== null; }
}
function showNextBrain() {
  const select = $('brainSelect');
  const selected = select.value;
  if (!selected) {
    if (savedCompanion) displayCompanion(savedCompanion);
    else $('brainStatus').textContent = '予測：標準モデル mine（未作成）。外見の変更は予測に影響しません。';
  } else {
    $('brainStatus').textContent = '次回の予測：保存した学習済み練習版 ' +
      selected + '。保存した相棒の判断ルールより優先。架空40点での学習のみ、実相場精度は未検証。外見と独立。';
  }
}
$('loadBrains').addEventListener('click', () => loadBrains());
$('brainSelect').addEventListener('change', () => {
  handoffInvalid = false;
  $('resetBrain').hidden = true;
  showNextBrain();
  refreshButtons();
});
$('resetBrain').addEventListener('click', () => {
  if (handoffPending || busy) return;
  handoffInvalid = false;
  $('resetBrain').hidden = true;
  $('brainSelect').value = '';
  $('brainNotice').textContent = '学習版の指定を解除しました。保存した相棒、または標準モデルで練習できます。';
  showNextBrain();
  refreshButtons();
});
$('loadSkins').addEventListener('click', () => loadSkins());
$('skinSelect').addEventListener('change', chooseSkin);
$('play').addEventListener('click', play);
$('claim').addEventListener('click', claim);
$('equip').addEventListener('click', equip);
$('discard').addEventListener('click', discard);
$('gear').addEventListener('change', refreshButtons);
$('refreshGrowth').addEventListener('click', async () => {
  if (busy) return;
  busy = true; refreshButtons();
  try {
    await loadGrowth();
    $('gearStatus').textContent = '育成情報を更新しました。';
  } catch (error) {
    growthRevision = null;
    $('growthInfo').textContent = '育成を再取得できません: ' + error.message;
  } finally { busy = false; refreshButtons(); }
});
$('next').addEventListener('click', () => chooseDay(dayIndex + 1));
loadGrowth().catch(error => {
  growthRevision = null;
  $('growthInfo').textContent = '育成情報を読み込めません: ' + error.message;
  refreshButtons();
});
refreshButtons();

function creatorValue() {
  return {name:$('creatorName').value, hair_color:$('creatorHair').value,
    clothing_color:$('creatorClothing').value, approach:$('creatorApproach').value,
    risk_percent:Number($('creatorRisk').value)};
}
function previewCompanion() {
  const value = creatorValue();
  $('companionName').textContent = value.name || '私の相棒';
  // Only canonical colors reach CSS; names are always plain text.
  const hair = /^#[a-f0-9]{6}$/i.test(value.hair_color) ? value.hair_color : '#8882db';
  const clothing = /^#[a-f0-9]{6}$/i.test(value.clothing_color) ? value.clothing_color : '#92e1d4';
  $('chibi').setAttribute('style', '--hair:' + hair + ';--clothing:' + clothing);
  $('chibi').setAttribute('aria-label', value.name + 'のカスタムchibi');
  $('creatorPreview').textContent = '一時プレビュー：' + (approachLabels[value.approach] || '未選択') +
    'を重視 / 上昇判断時の資金使用率 ' + value.risk_percent + '%。残りは現金で待機。';
}
function displayCompanion(value) {
  savedCompanion = value;
  const c = value.companion;
  $('creatorName').value = c.name;
  $('creatorHair').value = c.hair_color;
  $('creatorClothing').value = c.clothing_color;
  $('creatorApproach').value = c.approach;
  $('creatorRisk').value = String(c.risk_percent);
  previewCompanion();
  $('brainStatus').textContent = value.created ?
    '保存済み：' + c.name + ' / ' + approachLabels[c.approach] + 'を重視 / 資金使用率 ' + c.risk_percent +
    '% / revision ' + value.revision + '。次の練習に反映。色とDRAFT画像は外見だけ。' :
    '未作成：予測は標準モデルmine。フォームを保存すると自分のルールで練習します。';
  if ($('brainSelect').value) showNextBrain();
}
async function loadCompanion() {
  displayCompanion(await call('/api/companion'));
  $('companionStatus').textContent = savedCompanion.created ? '保存済みの相棒を復元しました。' : 'まだ未作成です。自分で設定して保存しよう。';
  refreshButtons();
}
for (const id of creatorIds) $(id).addEventListener('input', () => {
  $('skinSelect').value = '';
  defaultSkin('カスタムchibiの一時プレビューです。');
  previewCompanion();
  $('companionStatus').textContent = '未保存のプレビューです。予測ルールは保存するまで変わりません。';
});
$('companionForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || companionSaving || !savedCompanion) return;
  companionSaving = true; refreshButtons();
  try {
    const value = await call('/api/companion', {expected_revision:savedCompanion.revision, companion:creatorValue()});
    displayCompanion(value);
    $('skinSelect').value = ''; defaultSkin('自分で作った相棒を表示しています。');
    $('companionStatus').textContent = value.companion.name + 'を保存しました！次の練習はこの判断ルールで冒険します。';
  } catch (error) {
    $('companionStatus').textContent = '保存できません: ' + error.message + '。再取得すると編集内容を保存済み設定に戻せます。';
  } finally {companionSaving = false; refreshButtons();}
});
$('reloadCompanion').addEventListener('click', async () => {
  if (busy || companionSaving) return;
  companionSaving = true; refreshButtons();
  try {await loadCompanion();}
  catch (error) {$('companionStatus').textContent = '相棒を読み込めません: ' + error.message;}
  finally {companionSaving = false; refreshButtons();}
});
loadCompanion().catch(error => {
  $('companionStatus').textContent = '相棒を読み込めません: ' + error.message + '。再取得してください。';
  refreshButtons();
});
async function applyCreateHandoff() {
  if (typeof window === 'undefined' || !window.location) return;
  const query = new URLSearchParams(window.location.search);
  const versionId = query.get('trained_version_id');
  const draftId = query.get('draft_id');
  if (!versionId && !draftId) return;
  $('brainControls').open = true;
  $('skinControls').open = true;
  if (versionId) {
    if (!/^tv_[a-f0-9]{32}$/.test(versionId) ||
        (draftId && !/^bp_[a-f0-9]{32}$/.test(draftId))) {
      handoffInvalid = true;
      $('resetBrain').hidden = false;
      $('brainNotice').textContent = '制作画面から渡されたモデルのIDが不正です。練習の開始を停止しました。';
      refreshButtons();
    } else {
      handoffPending = true;
      refreshButtons();
      try {await loadBrains(versionId, draftId || '');}
      finally {handoffPending = false; refreshButtons();}
    }
  }
  if (draftId && /^bp_[a-f0-9]{32}$/.test(draftId)) {
    await loadSkins(draftId);
  }
}
if (typeof window !== 'undefined') {
  applyCreateHandoff().catch(error => {
    handoffPending = false;
    handoffInvalid = true;
    $('resetBrain').hidden = false;
    $('brainNotice').textContent = '学習版の引継ぎを確認できません: ' + error.message;
    refreshButtons();
  });
}
