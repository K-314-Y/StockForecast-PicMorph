const $ = id => document.getElementById(id);
const fmt = n => Number(n).toLocaleString('ja-JP', {maximumFractionDigits: 2});
let growthRevision = null;
let currentGrowth = null;
let ticket = null;
let busy = false;
let skipArmed = false;
let result = null;
let dayIndex = 0;
let savedCompanion = null;
let savedLook = null;
let lookSaving = false;
const lookIds = ['lookHair','lookExpression','lookAccessory'];
let companionSaving = false;
let handoffPending = false;
let handoffInvalid = false;
const artworkSlots = ['base','hair','face','outfit'];
const artworkNames = {base:'完成イラスト',hair:'髪',face:'顔',outfit:'服'};
const artworkId = slot => slot[0].toUpperCase() + slot.slice(1);
let savedArtwork = null;
let artworkSaving = false;
let artworkActive = false;
const artworkPreviews = new Map();
const artworkDimensions = new Map();
const artworkSelectionErrors = new Map();
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
  refreshArtworkButtons();
  $('saveLook').disabled = busy || lookSaving || savedLook === null;
  $('reloadLook').disabled = busy || lookSaving;
  for (const id of lookIds) $(id).disabled = busy || lookSaving;
  $('play').disabled = busy || companionSaving || ticket !== null || handoffPending || handoffInvalid;
  $('adventureMode').disabled = $('play').disabled;
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
  $('next').disabled = busy || !result || dayIndex >= result.decisions.length - 1;
}

async function loadGrowth() {
  const growth = await call('/api/growth');
  const mine = Array.isArray(growth.slots) && growth.slots.find(item => item.slot === 'mine');
  if (!mine || !Array.isArray(mine.achievements) || !Number.isSafeInteger(growth.revision)) {
    throw Error('育成記録の形式が不正です');
  }
  currentGrowth = mine;
  growthRevision = growth.revision;
  $('growthInfo').textContent = 'Lv.' + mine.level + ' / ' + mine.xp + ' XP';
  $('growthAchievements').textContent = mine.achievements.length ?
    '達成課題：' + mine.achievements.map(id =>
      growth.challenges?.find(item => item.id === id)?.name || id).join(' / ') :
    '達成課題：まだありません';
  refreshButtons();
  return growth;
}

$('scene').addEventListener('animationend', () => {
  $('scene').dataset.growing = 'false';
});

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
  const allocations = ['mine','owl','turtle'].map(slot => value.characters?.[slot]?.allocation_pct);
  const [mine, owl, turtle] = allocations;
  const allocationValid = allocations.every(n => Number.isInteger(n) && n >= 0 && n <= 100) &&
    mine + owl + turtle <= 100;
  const practiceLabel = mine === 100 && owl === 0 && turtle === 0 ? 'ひとり練習' :
    mine === 50 && owl === 50 && turtle === 0 ? 'チーム練習' : '練習';
  $('resultAllocation').textContent = allocationValid ?
    practiceLabel + ' / APIで確認した配分：自分の相棒（mine）' + mine +
    '%・フクロウ（owl）' + owl + '%・カメ（turtle）' + turtle + '%' :
    '配分を確認できません。API応答に有効なキャラ別配分がありません。';
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
    ' / 実行モデル: ' + value.brain.effective_sha256 : '';
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
  $('growthCelebration').textContent = '';
  $('scene').dataset.growing = 'false';
  $('result').hidden = true;
  result = null;
  refreshButtons();
  scene('thinking', '未来は見ないで、今日の判断を考えているよ…');
  $('status').textContent = 'Pythonで予測判断を作成し、Node.jsで架空コインを計算しています…';
  try {
    const mode = $('adventureMode').value;
    if (mode !== 'solo' && mode !== 'team') throw Error('冒険の作戦を選び直してください');
    const selectedId = $('brainSelect').value;
    const payload = {allocations: mode === 'team' ?
      {mine: 50, owl: 50, turtle: 0} : {mine: 100, owl: 0, turtle: 0}};
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
    $('status').textContent = '練習完了！ 12日間を振り返り、XPを受け取って冒険を記録しよう。';
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
  const before = currentGrowth;
  $('growthCelebration').textContent = '';
  $('scene').dataset.growing = 'false';
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
    const after = response.growth?.slots?.find(item => item.slot === 'mine');
    if (response.earned_xp?.mine > 0 && before && after && after.xp > before.xp) {
      const messages = [];
      if (after.level > before.level) messages.push('Lv.' + before.level + ' → Lv.' + after.level);
      $('growthCelebration').textContent = messages.join(' / ');
      $('scene').dataset.growing = 'true';
      scene('growth', '自分の相棒の冒険記録が増えたね！');
    }
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
  artworkActive = false;
  if ($('artworkStage')) $('artworkStage').hidden = true;
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
  artworkActive = false;
  if ($('artworkStage')) $('artworkStage').hidden = true;
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
$('discard').addEventListener('click', discard);
$('refreshGrowth').addEventListener('click', async () => {
  if (busy) return;
  busy = true; refreshButtons();
  try {
    await loadGrowth();
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

// The cosmetic parts have their own revision and never touch the model or XP.
function lookValue() {
  return {hair_style:$('lookHair').value,expression:$('lookExpression').value,
    accessory:$('lookAccessory').value};
}
function previewLook() {
  const value=lookValue();
  const hair=['bob','long','twintails'].includes(value.hair_style)?value.hair_style:'bob';
  const expression=['cheerful','calm','determined'].includes(value.expression)?value.expression:'cheerful';
  const accessory=['ribbon','glasses','star','none'].includes(value.accessory)?value.accessory:'ribbon';
  $('chibi').dataset.hairStyle=hair;
  $('chibi').dataset.expression=expression;
  $('chibi').dataset.accessory=accessory;
}
function displayLook(record) {
  savedLook=record;
  $('lookHair').value=record.look.hair_style;
  $('lookExpression').value=record.look.expression;
  $('lookAccessory').value=record.look.accessory;
  previewLook();
  refreshButtons();
}
async function loadLook() {
  const record=await call('/api/looks');
  displayLook(record);
  $('lookStatus').textContent=record.created ?
    '保存済みの見た目を復元しました（revision '+record.revision+'）。' :
    'パーツは未保存です。自分で組み立てて保存できます。';
}
for(const id of lookIds) $(id).addEventListener('change',()=>{
  $('skinSelect').value='';
  defaultSkin('自分で組み立てた2Dパーツを表示しています。');
  previewLook();
  $('lookStatus').textContent='編集中の見た目です。保存するまで他の画面には反映されません。';
});
$('lookForm').addEventListener('submit',async event=>{
  event.preventDefault();
  if(busy || lookSaving || !savedLook)return;
  lookSaving=true;refreshButtons();
  try {
    const value=await call('/api/looks',{expected_revision:savedLook.revision,look:lookValue()});
    displayLook(value);
    $('skinSelect').value='';
    defaultSkin('自分で組み立てた2Dパーツを表示しています。');
    $('lookStatus').textContent='見た目を保存しました。ゲームとChatGPTで同じパーツを使えます。';
  }catch(error){
    $('lookStatus').textContent='外見を保存できません: '+error.message+'。再読込すれば保存済みのパーツを確認できます。';
  }finally{lookSaving=false;refreshButtons();}
});
$('reloadLook').addEventListener('click',async()=>{
  if(busy || lookSaving)return;
  lookSaving=true;refreshButtons();
  try{await loadLook();}
  catch(error){$('lookStatus').textContent='外見の再取得に失敗しました: '+error.message;}
  finally{lookSaving=false;refreshButtons();}
});
loadLook().catch(error=>{
  $('lookStatus').textContent='外見パーツを読み込めません: '+error.message;
  refreshButtons();
});

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

// Local File previews are separate from the revision-guarded saved source bytes.
function savedArtworkSource(slot) {
  return savedArtwork?.slots[slot]?.exists ?
    '/api/artwork/image/' + slot + '?revision=' + savedArtwork.revision : '';
}
// Decode only local preview URLs and the existing same-origin image endpoint.
function artworkSize(src) {
  if (!src) return null;
  if (artworkDimensions.has(src)) return artworkDimensions.get(src);
  const size = {pending:typeof Image === 'function',width:0,height:0};
  artworkDimensions.set(src, size);
  if (size.pending) {
    const img = new Image();
    const finish = () => {
      if (artworkDimensions.get(src) !== size) return;
      size.pending = false;
      size.width = img.naturalWidth; size.height = img.naturalHeight;
      refreshArtworkButtons();
    };
    img.onload = finish; img.onerror = finish;
    img.src = src;
  }
  return size;
}
const knownArtworkSize = size => size?.width > 0 && size?.height > 0;
const artworkSizeText = size => size?.pending ? '寸法確認中…' :
  knownArtworkSize(size) ? size.width + '×' + size.height + 'px' : '寸法を確認できません';
const differentArtworkSize = (a,b) => knownArtworkSize(a) && knownArtworkSize(b) &&
  (a.width !== b.width || a.height !== b.height);
function artworkLayerCheck(slot) {
  const layer = artworkSize(artworkSource(slot));
  const base = artworkSize(artworkSource('base'));
  const storedBase = artworkSize(savedArtworkSource('base'));
  if (layer?.pending || base?.pending || storedBase?.pending)
    return {blocked:true,message:'SAVE前に画像の寸法を確認中です…'};
  if (differentArtworkSize(base, layer)) return {blocked:true,invalid:true,message:
    '寸法が違います（base ' + artworkSizeText(base) + ' / ' + artworkNames[slot] + ' ' + artworkSizeText(layer) +
    '）。余白を切り詰めず、baseと同じキャンバス寸法・位置で書き出して選び直してください。このレイヤーはSAVEできません。'};
  if (differentArtworkSize(storedBase, layer)) return {blocked:true,invalid:true,message:
    '保存済みbase（' + artworkSizeText(storedBase) + '）と寸法が違うため、このレイヤーはSAVEできません。先に新しいbaseをSAVEするか、同じキャンバス寸法のレイヤーを選び直してください。'};
  if (!knownArtworkSize(base) || (savedArtwork?.slots.base.exists && !knownArtworkSize(storedBase)))
    return {blocked:false,message:'注意：base寸法が確認できないため、重ね合わせのサイズが合うか判断できません。原画と同じキャンバス寸法・位置か確認してください。'};
  if (!knownArtworkSize(layer)) return {blocked:false,message:
    '注意：レイヤー寸法が確認できないため、baseとの一致は判断できません。画像を確認して選び直してください。'};
  return {blocked:false,message:'base ' + artworkSizeText(base) + ' と同じ寸法です。位置は自動調整しません。余白・重なりを確認してください。'};
}
function refreshArtworkButtons() {
  const pendingNotice = $('artworkPendingNotice');
  if (pendingNotice) {
    pendingNotice.dataset.pending = String(artworkPreviews.size > 0);
    pendingNotice.textContent = artworkPreviews.size ?
      '未保存の画像があります。SAVEするまで保存されません。' : '保存前の変更はありません。';
  }
  for (const slot of artworkSlots) {
    const suffix = artworkId(slot);
    const save = $('artworkSave' + suffix);
    if (!save) continue;
    const src = artworkSource(slot);
    const size = artworkSize(src);
    const check = slot !== 'base' && src ? artworkLayerCheck(slot) : null;
    const selectionError = artworkSelectionErrors.get(slot);
    save.disabled = artworkSaving || savedArtwork === null || !artworkPreviews.has(slot) ||
      Boolean(size?.pending || check?.blocked);
    $('artworkClear' + suffix).disabled = artworkSaving || !savedArtwork?.slots[slot]?.exists;
    $('artworkFile' + suffix).disabled = artworkSaving;
    $('artworkFile' + suffix).setAttribute('aria-invalid', String(Boolean(selectionError || check?.invalid)));
    const preview = artworkPreviews.get(slot);
    const stored = savedArtwork?.slots[slot];
    const info = preview ?
      '未保存：' + preview.file.name + ' / ' + preview.file.size + ' bytes' :
      stored?.exists ? '保存済み：' + stored.mime + ' / ' + stored.size + ' bytes' :
      savedArtwork ? '画像なし' : '保存状況は未取得（選択してプレビューできます）';
    $('artworkInfo' + suffix).textContent = info + (src ? ' / ' + artworkSizeText(size) : '') +
      (check ? '。' + check.message : '') + (selectionError ? '。' + selectionError : '');
  }
  if ($('reloadArtwork')) $('reloadArtwork').disabled = artworkSaving;
}
function discardArtworkPreview(slot) {
  const preview = artworkPreviews.get(slot);
  if (preview) {
    URL.revokeObjectURL(preview.url);
    artworkDimensions.delete(preview.url);
  }
  artworkPreviews.delete(slot);
  artworkSelectionErrors.delete(slot);
  $('artworkFile' + artworkId(slot)).value = '';
}
function artworkSource(slot) {
  return artworkPreviews.get(slot)?.url || savedArtworkSource(slot);
}
function showArtwork() {
  const base = artworkSource('base');
  if (!base) {
    defaultSkin('完成イラストを選ぶと、自分の画像で遊べます。');
    $('artworkStatus').textContent = 'まず完成イラストを1枚選んでください。髪・顔・服は任意です。';
    return;
  }
  const epoch = ++skinEpoch;
  artworkActive = true;
  $('skinSelect').value = '';
  const portrait = $('portrait');
  portrait.onload = null; portrait.onerror = null; portrait.hidden = true;
  $('artworkStage').hidden = true;
  $('chibi').hidden = false;
  for (const slot of artworkSlots) {
    const img = $('artwork' + artworkId(slot));
    const src = artworkSource(slot);
    img.onload = null; img.onerror = null;
    img.hidden = !src;
    if (src) {
      img.onerror = () => {
        if (epoch !== skinEpoch || !artworkActive) return;
        img.hidden = true;
        if (slot === 'base') defaultSkin('完成イラストを表示できません。カスタムchibiを表示しています。');
        $('artworkStatus').textContent = artworkNames[slot] + 'を表示できません。画像の形式や保存状況を確認してください。';
      };
      if (slot === 'base') img.onload = () => {
        if (epoch !== skinEpoch || !artworkActive) return;
        $('artworkStage').hidden = false;
        $('chibi').hidden = true;
      };
      img.src = src;
    } else {
      img.src = '';
    }
  }
  $('skinCaption').textContent = '外見：私のイラスト' + (artworkPreviews.size ? '（未保存のプレビューあり）' : '（保存済み）');
  $('skinStatus').textContent = '自分のイラストを表示中です。予測ルールやXPは変わりません。';
}
function previewArtwork(slot) {
  const input = $('artworkFile' + artworkId(slot));
  const file = input.files?.[0];
  if (!file || artworkSaving) return;
  const allowed = slot === 'base' ? ['image/png','image/jpeg','image/webp'] : ['image/png','image/webp'];
  if (!allowed.includes(file.type) || file.size <= 0 || file.size > 450 * 1024) {
    const message = file.size > 450 * 1024 ?
      '選択した画像は ' + file.size.toLocaleString('ja-JP') + ' bytes（' + (file.size / 1024).toFixed(1) +
      'KB）で、上限450KB（460,800 bytes）を超えています。画像編集ソフトで圧縮して選び直してください。パーツは余白を切らず、baseと同じキャンバス寸法・位置を保ってください。' :
      '完成イラストはPNG/JPEG/WebP、レイヤーはPNG/WebPの空でない画像を選んでください。1枚450KBまでです。';
    discardArtworkPreview(slot);
    artworkSelectionErrors.set(slot, message);
    refreshArtworkButtons();
    if (artworkActive) showArtwork();
    $('artworkStatus').textContent = message;
    return;
  }
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    $('artworkStatus').textContent = 'このブラウザーではローカル画像をプレビューできません。';
    return;
  }
  const url = URL.createObjectURL(file);
  discardArtworkPreview(slot);
  artworkPreviews.set(slot, {file,url});
  refreshArtworkButtons();
  $('artworkStatus').textContent = artworkNames[slot] + 'の未保存プレビューです。この画像のSAVEを押すと保存します。';
  showArtwork();
}
async function artworkBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}
async function saveArtworkSlot(slot, clear = false) {
  if (artworkSaving || !savedArtwork || (!clear && !artworkPreviews.has(slot))) return;
  if (clear || (slot === 'base' && savedArtwork.slots.base.exists)) {
    const message = clear ?
      artworkNames[slot] + 'の保存画像をこのPCから削除しますか？\nこの部位だけを削除し、他の部位は変更しません。' :
      '完成イラスト（base）の既存の保存画像を、選択中の画像で置き換えてSAVEしますか？\n髪・顔・服の保存画像は変更しません。';
    if (typeof window === 'undefined' || typeof window.confirm !== 'function' || !window.confirm(message)) return;
  }
  if (!clear) {
    if (artworkSize(artworkSource(slot))?.pending) return;
    if (slot !== 'base') {
      const check = artworkLayerCheck(slot);
      if (check.blocked) { $('artworkStatus').textContent = check.message; return; }
      const message = artworkNames[slot] + '（' + artworkSizeText(artworkSize(artworkSource(slot))) + '）をSAVEしますか？\n' +
        check.message + '\n重なる順はbase→服→顔→髪です。この部位だけをこのPCに保存します。';
      if (typeof window === 'undefined' || typeof window.confirm !== 'function' || !window.confirm(message)) return;
    }
  }
  artworkSaving = true; refreshArtworkButtons();
  try {
    const file = artworkPreviews.get(slot)?.file;
    const image = clear ? null : {mime:file.type,base64:await artworkBase64(file)};
    savedArtwork = await call('/api/artwork', {expected_revision:savedArtwork.revision,slot,image});
    artworkDimensions.clear();
    discardArtworkPreview(slot);
    $('artworkStatus').textContent = artworkNames[slot] + (clear ? 'の保存画像を削除しました。' : 'を保存しました。再読込後も使えます。');
    if (artworkActive) showArtwork();
  } catch (error) {
    $('artworkStatus').textContent = '保存できません: ' + error.message + '。「未保存を破棄して再取得」で現在の保存状況を確認できます。';
  } finally {artworkSaving = false; refreshArtworkButtons();}
}
async function loadArtwork(restore = false, discardPending = false) {
  const epoch = skinEpoch;
  const record = await call('/api/artwork');
  if (discardPending) for (const slot of artworkSlots) discardArtworkPreview(slot);
  savedArtwork = record;
  artworkDimensions.clear();
  refreshArtworkButtons();
  $('artworkStatus').textContent = record.created ? '保存済みイラストを復元しました。revision ' + record.revision :
    'まだ画像は保存されていません。完成イラスト1枚から使えます。';
  if (restore || (epoch === skinEpoch && !artworkPreviews.size && record.slots.base.exists)) showArtwork();
}
for (const slot of artworkSlots) {
  const suffix = artworkId(slot);
  $('artworkFile' + suffix)?.addEventListener('change', () => previewArtwork(slot));
  $('artworkSave' + suffix)?.addEventListener('click', () => saveArtworkSlot(slot));
  $('artworkClear' + suffix)?.addEventListener('click', () => saveArtworkSlot(slot, true));
}
$('artworkReturn')?.addEventListener('click', () => {
  $('quickForm')?.scrollIntoView?.({behavior:'instant', block:'start'});
});
$('showArtwork')?.addEventListener('click', showArtwork);
$('showChibi')?.addEventListener('click', () => {
  $('skinSelect').value = '';
  defaultSkin('自分で組み立てたカスタムchibiを表示しています。');
});
$('reloadArtwork')?.addEventListener('click', async () => {
  if (artworkSaving) return;
  if (artworkPreviews.size && (typeof window === 'undefined' || typeof window.confirm !== 'function' ||
    !window.confirm('未保存の画像プレビューを破棄して、保存済みの画像を再取得しますか？\nSAVEしていない画像は失われます。'))) return;
  artworkSaving = true; refreshArtworkButtons();
  try {
    await loadArtwork(true, true);
  } catch (error) {
    $('artworkStatus').textContent = '読み込めません: ' + error.message;
  } finally {artworkSaving = false; refreshArtworkButtons();}
});
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('beforeunload', event => {
    if (!artworkPreviews.size) return;
    event.preventDefault();
    event.returnValue = '';
  });
  window.addEventListener('pagehide', () => {
    for (const slot of artworkSlots) discardArtworkPreview(slot);
  });
}
loadArtwork().catch(error => {
  if ($('artworkStatus')) $('artworkStatus').textContent = 'イラストを読み込めません: ' + error.message + '。再取得してください。';
  refreshArtworkButtons();
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
