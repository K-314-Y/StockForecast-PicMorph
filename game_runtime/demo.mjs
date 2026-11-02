const $ = id => document.getElementById(id);
const fmt = n => Number(n).toLocaleString('ja-JP', {maximumFractionDigits: 2});
let growthRevision = null;
let currentGearId = null;
let ticket = null;
let busy = false;
let skipArmed = false;
let result = null;
let dayIndex = 0;

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
  $('play').disabled = busy || ticket !== null;
  $('claim').disabled = busy || ticket === null || growthRevision === null;
  $('discard').hidden = ticket === null;
  $('discard').disabled = busy;
  $('refreshGrowth').disabled = busy;
  $('loadSkins').disabled = busy;
  $('skinSelect').disabled = busy;
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
  $('dayCount').textContent = (index + 1) + ' / ' + result.decisions.length + ' 日目';
  $('dayDetail').textContent = (index + 1) + '日目: 架空価格 ' +
    fmt(choice.price) + ' C / 判断 ' + signal +
    ' / 仮想コイン残高 ' + fmt(result.equity_path[index + 1]) + ' C';
  if (signal === 'CASH') {
    scene('cautious', '標準モデルは今日は現金待機。動かない判断も大切だよ。');
  } else if (signal === 'LONG') {
    scene('thinking', '標準モデルは上昇を狙う判断。結果を確かめよう。');
  } else {
    scene('thinking', '標準モデルの判断は「' + signal + '」。結果を確かめよう。');
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
  if (busy || ticket !== null) return;
  busy = true; skipArmed = false;
  $('reward').textContent = '';
  $('result').hidden = true;
  result = null;
  refreshButtons();
  scene('thinking', '未来は見ないで、今日の判断を考えているよ…');
  $('status').textContent = 'Pythonで予測判断を作成し、Node.jsで架空コインを計算しています…';
  try {
    const value = await call('/api/practice', {
      allocations: {mine: 100, owl: 0, turtle: 0},
    });
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
  $('skinCaption').textContent = '外見：デモ用2D相棒';
  $('skinStatus').textContent = message;
}
async function loadSkins() {
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
    fallback.textContent = 'デモ用キャラ';
    select.append(fallback);
    for (const draft of catalog.drafts) {
      if (!/^bp_[a-f0-9]{32}$/.test(draft.id) || typeof draft.name !== 'string') continue;
      const option = document.createElement('option');
      option.value = draft.id;
      option.disabled = !draft.has_image;
      option.textContent = draft.name + (draft.has_image ? ' · 外見だけ' : ' · 画像なし');
      select.append(option);
    }
    select.value = '';
    defaultSkin(catalog.drafts.length ?
      '保存キャラを読み込みました。選択すると外見だけ変わります。' :
      '保存キャラはまだありません。デモ用キャラでそのまま遊べます。');
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
    $('skinStatus').textContent = '外見のみ変更済み。予測は標準モデルmineのままです。';
  };
  img.onerror = () => {
    if (epoch !== skinEpoch) return;
    select.value = '';
    defaultSkin('外見データが見つからないか壊れています。初期外見に戻しました。');
  };
  img.src = '/api/appearance/image/' + id;
}
$('loadSkins').addEventListener('click', loadSkins);
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
