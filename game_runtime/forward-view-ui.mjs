const walletPath = '/api/companion/forward-ai?view=summary';
const recordsPath = '/api/companion/forward-records';
const modelPath = '/api/companion/forward-model';
const aiId = /^[a-z][a-z0-9_-]{1,39}$/;
const companionVersion = /^companion-v1(?:_\d{1,3}){5}$/;
const modelVersion = /^(?:appearance-v[1-9]\d{0,2}|companion-v1)(?:_\d{1,3}){5}$/;
const maxMedals = 1_000_000_000_000;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);
const revision = value => Number.isSafeInteger(value) && value >= 0;
const finite = (value, min, max = Infinity) => Number.isFinite(value) && value >= min && value <= max;
const symbol = value => matches(value, /^[0-9A-Z]{4,5}$/);
const date = value => matches(value, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/) && Number.isFinite(Date.parse(value));
const directions = {UP:'上がる', FLAT:'横ばい', DOWN:'下がる'};
const tradeSides = {LONG:'買い', SHORT:'売り'};
const orderText = {NONE:'未記録', QUEUED:'予約中', CANCELLED:'取り消し', OPENED:'取引開始', CLOSED:'決済済み'};
const approaches = {trend:'トレンド', momentum:'勢い', reversion:'反転', volatility:'変動'};
const mockLabel = '架空（MOCK_NONLIVE）';
const number = new Intl.NumberFormat('ja-JP', {maximumFractionDigits:6});
const signed = new Intl.NumberFormat('ja-JP', {maximumFractionDigits:6, signDisplay:'exceptZero'});
const japanTime = new Intl.DateTimeFormat('ja-JP', {timeZone:'Asia/Tokyo', dateStyle:'short', timeStyle:'medium'});

function invalid() { throw Error('Invalid forward response'); }

function walletState(value) {
  if (value?.mode !== 'FORWARD_WALLETS_MARKET_UNCONNECTED' ||
      !(value.revision === null || revision(value.revision)) || typeof value.created !== 'boolean' ||
      typeof value.mock !== 'boolean' || !finite(value.initialMedals, 1, maxMedals) ||
      !revision(value.unallocated) || value.unallocated > value.initialMedals ||
      !Array.isArray(value.generations) || !isObject(value.wallets)) invalid();
  const ids = Object.keys(value.wallets);
  if (ids.length > 50 || value.generations.length > ids.length ||
      (value.revision === null && (ids.length || value.created || value.unallocated !== value.initialMedals)) ||
      !ids.every(id => {
        const wallet = value.wallets[id];
        const pos = wallet?.position;
        return matches(id, aiId) && finite(wallet?.cash, 0) && finite(wallet?.equity, 0) &&
          ['ACTIVE','LIQUIDATED'].includes(wallet.status) &&
          (pos === null || (symbol(pos?.symbol) && Object.hasOwn(tradeSides, pos.direction)));
      })) invalid();
  const seen = new Set();
  for (const item of value.generations) {
    if (!matches(item?.aiId, aiId) || !Object.hasOwn(value.wallets, item.aiId) ||
        seen.has(item.aiId) || !matches(item.model_version, modelVersion)) invalid();
    seen.add(item.aiId);
  }
  if (value.currentAiId !== (value.generations.at(-1)?.aiId ?? null)) invalid();
  return value;
}

function savedModelState(value) {
  if (typeof value?.created !== 'boolean' || !Object.hasOwn(approaches, value.approach) ||
      !Number.isInteger(value.risk_percent) || value.risk_percent < 5 || value.risk_percent > 100 ||
      value.risk_percent % 5 !== 0 ||
      !(value.created ? matches(value.model_version, companionVersion) : value.model_version === null)) invalid();
  return value;
}

function validOrder(value, filledStatus) {
  return value?.status === 'NONE' ? value.at === null :
    ['QUEUED','CANCELLED',filledStatus].includes(value?.status) && date(value.at);
}

function recordState(value) {
  if (!Array.isArray(value?.records)) invalid();
  if (value.status === 'unconnected' && value.records.length === 0) return value;
  const [item] = value.records;
  if (value.status !== 'MOCK_NONLIVE' || value.records.length !== 1 || item?.sourceMode !== value.status ||
      !matches(item.aiId, aiId) || !matches(item.model_version, modelVersion) || !symbol(item.symbol) ||
      !date(item.confirmedAt) || !date(item.targetAt) || item.confirmedAt >= item.targetAt ||
      !(item.direction === null || Object.hasOwn(directions, item.direction)) ||
      !(item.predictedChangePct === null || finite(item.predictedChangePct, -100, 10_000)) ||
      !validOrder(item.open, 'OPENED') || !validOrder(item.close, 'CLOSED') ||
      (item.close.status !== 'NONE' && item.open.status !== 'OPENED') ||
      (item.close.status === 'CLOSED' ? !Number.isFinite(item.realizedPnl) : item.realizedPnl !== null)) invalid();
  if (item.status === 'PENDING' && item.score === null) return value;
  const score = item.score;
  if (item.status !== 'SCORED_MOCK_NONLIVE' || item.close.status !== 'CLOSED' ||
      !finite(score?.brier, 0, 2) || !Object.hasOwn(directions, score.actualDirection) ||
      !(score.directionCorrect === null || typeof score.directionCorrect === 'boolean') ||
      !(score.absoluteChangeErrorPctPoints === null || finite(score.absoluteChangeErrorPctPoints, 0)) ||
      !date(score.scoredAt)) invalid();
  return value;
}

async function request(path, validate, body) {
  const options = {cache:'no-store', signal:AbortSignal.timeout(8000)};
  if (body) Object.assign(options, {method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify(body)});
  let response;
  try { response = await fetch(path, options); }
  catch { throw Object.assign(Error('Disconnected'), {disconnected:true}); }
  if (!response.ok) throw Object.assign(Error('Request failed'), {status:response.status});
  return validate(await response.json());
}

const messageFor = (error, subject) => error.disconnected ?
  '一時切断しました。接続を確認して再取得してください。' : subject + 'を読み取れません。再取得してください。';

const element = id => document.getElementById(id);

function fillFacts(list, entries) {
  list.replaceChildren(...entries.flatMap(([label, value]) => {
    const name = document.createElement('dt');
    const detail = document.createElement('dd');
    name.textContent = label;
    detail.textContent = value;
    return [name, detail];
  }));
}

const medals = value => number.format(value) + ' 枚';
const timestamp = value => japanTime.format(Date.parse(value)) + '（日本時間）';
const directionText = value => directions[value] ?? '方向の指定なし';
const displayOrder = order => orderText[order.status] + (order.at ? '・' + timestamp(order.at) : '');

function mountForwardPanel(panel) {
  const walletStatus = element('forwardWalletStatus');
  const saveStatus = element('forwardSaveStatus');
  const recordStatus = element('forwardRecordsStatus');
  const unallocated = element('forwardUnallocated');
  const walletDetails = element('forwardWallet');
  const recordsDetails = element('forwardRecords');
  const select = element('forwardAI');
  const refreshButton = element('forwardRefresh');
  const saveFields = element('forwardSaveFields');
  const amountInput = element('forwardMedals');
  const modelDetails = element('forwardModel');
  let wallet, records, savedModel;
  let selected = '';
  let busy = false;
  let mustRefresh = false;
  let recordError = '';

  function updateControls() {
    refreshButton.setAttribute('aria-disabled', String(busy));
    select.disabled = !wallet?.generations.length;
    saveFields.disabled = busy || mustRefresh || !savedModel?.created ||
      !(wallet?.unallocated > 0) || Object.keys(wallet.wallets).length >= 50;
    if (wallet?.unallocated > 0) amountInput.max = String(wallet.unallocated);
  }

  function renderWallet() {
    unallocated.hidden = !wallet;
    walletDetails.hidden = !selected || !wallet;
    if (!wallet) {
      select.replaceChildren(new Option('未選択', ''));
      walletDetails.replaceChildren();
      unallocated.textContent = '';
      return;
    }
    unallocated.textContent = '未配分の仮想メダル ' + medals(wallet.unallocated) +
      (wallet.revision === null ? '（初回保存時に用意）' : '');
    const generation = wallet.generations.find(item => item.aiId === selected);
    walletDetails.hidden = !generation;
    if (!generation) {
      walletDetails.replaceChildren();
      return;
    }
    const {cash, equity, status, position} = wallet.wallets[selected];
    const label = name => wallet.mock ? name + '・' + mockLabel : name;
    fillFacts(walletDetails, [
      ['AI ID', selected],
      ['モデルの由来', companionVersion.test(generation.model_version) ? '保存済みの判断ルール' :
        '外見由来の旧実験モデルです。予測スタジオの判断ルールとは連動しません。'],
      ['モデルの版', generation.model_version],
      [label('使えるメダル'), medals(cash)],
      [label('保有分を含む残高'), medals(equity)],
      [label('財布の状態'), status === 'ACTIVE' ? '利用可' : '強制決済済み'],
      [label('保有中'), position ? position.symbol + '・' + tradeSides[position.direction] : 'なし'],
    ]);
  }

  function renderRecords() {
    recordsDetails.hidden = true;
    recordsDetails.replaceChildren();
    if (!records) {
      recordStatus.textContent = recordError || '運用記録を読み込んでいます…';
      return;
    }
    if (records.status === 'unconnected') {
      recordStatus.textContent = '実市場は未接続です。先出し予測・模擬注文・損益・採点は未記録です。';
      return;
    }
    const item = records.records[0];
    if (!wallet?.generations.some(generation =>
      generation.aiId === selected && generation.model_version === item.model_version) || item.aiId !== selected) {
      recordStatus.textContent = '実市場は未接続です。選択したAIの模擬運用記録はありません。';
      return;
    }
    const score = item.score;
    recordStatus.textContent = '実市場は未接続です。' + mockLabel +
      (score ? 'の採点済み記録です。' : 'の記録です。未採点です。') +
      '本番の予測精度は未計測です。';
    const cards = [
      ['先出し予測', [
        ['対象', item.symbol], ['予測の確定', timestamp(item.confirmedAt)],
        ['結果を確認する時刻', timestamp(item.targetAt)], ['予測した方向', directionText(item.direction)],
        ['予測した値動き', item.predictedChangePct === null ? '未指定' : signed.format(item.predictedChangePct) + '％'],
      ]],
      ['模擬注文とメダル損益', [
        ['取引開始の注文', displayOrder(item.open)], ['決済の注文', displayOrder(item.close)],
        ['決済したメダル損益', item.realizedPnl === null ? '未記録' : signed.format(item.realizedPnl) + ' 枚'],
      ]],
      ['予測の採点', score ? [
        ['採点時刻', timestamp(score.scoredAt)],
        ['実際の値動き（架空）', directionText(score.actualDirection)],
        ['確率の誤差（Brier・小さいほど良い）', number.format(score.brier)],
        ['方向の的中', score.directionCorrect === null ? '判定なし' : score.directionCorrect ? '的中' : '外れ'],
        ['値幅の誤差', score.absoluteChangeErrorPctPoints === null ? '判定なし' :
          number.format(score.absoluteChangeErrorPctPoints) + ' ポイント'],
      ] : [['採点状況', '未採点']]],
    ];
    for (const [title, entries] of cards) {
      const heading = document.createElement('h3');
      heading.textContent = title + '・' + mockLabel;
      const list = document.createElement('dl');
      list.className = 'forward-facts';
      fillFacts(list, entries);
      recordsDetails.append(heading, list);
    }
    recordsDetails.hidden = false;
  }

  function showWallet(value, preferred) {
    wallet = value;
    const options = wallet.generations.map(({aiId}, index) => new Option('第' + (index + 1) + '世代', aiId));
    selected = options.some(option => option.value === preferred) ? preferred : wallet.currentAiId ?? '';
    select.replaceChildren(...(options.length ? options : [new Option('未選択', '')]));
    select.value = selected;
    walletStatus.textContent = wallet.revision === null ? 'まだAIの財布は作られていません。' :
      wallet.generations.length ? '保存したAIの財布を読み込みました。' : '保存したAIはまだありません。';
    renderWallet();
  }

  async function refresh() {
    if (busy) return;
    busy = true;
    const previousSelection = selected;
    wallet = records = savedModel = undefined;
    modelDetails.hidden = true;
    recordError = '';
    walletStatus.textContent = '保存したAIを読み込んでいます…';
    saveStatus.textContent = '';
    updateControls();
    renderWallet();
    renderRecords();
    const [walletResult, recordResult, modelResult] = await Promise.allSettled([
      request(walletPath, walletState), request(recordsPath, recordState),
      request(modelPath, savedModelState),
    ]);
    if (walletResult.status === 'fulfilled') showWallet(walletResult.value, previousSelection);
    else walletStatus.textContent = messageFor(walletResult.reason, 'AIの財布');
    if (recordResult.status === 'fulfilled') records = recordResult.value;
    else recordError = messageFor(recordResult.reason, '模擬運用記録');
    if (modelResult.status === 'fulfilled') {
      savedModel = modelResult.value;
      if (savedModel.created) {
        modelDetails.textContent = '保存する判断ルール：' + approaches[savedModel.approach] +
          'を重視 ／ 資金使用率 ' + savedModel.risk_percent + '％';
        modelDetails.hidden = false;
        if (wallet?.unallocated === 0) saveStatus.textContent = '配分できる仮想メダルはありません。';
        else if (wallet && Object.keys(wallet.wallets).length >= 50) saveStatus.textContent = '保存できるAIの上限に達しました。';
      } else {
        saveStatus.textContent = '予測スタジオで判断ルールを保存してから、再取得してください。';
      }
    } else {
      saveStatus.textContent = messageFor(modelResult.reason, '保存済みの判断ルール');
    }
    mustRefresh = false;
    busy = false;
    updateControls();
    renderRecords();
  }

  select.addEventListener('change', () => {
    selected = select.value;
    renderWallet();
    renderRecords();
  });
  refreshButton.addEventListener('click', refresh);
  panel.addEventListener('toggle', () => { if (panel.open) void refresh(); });
  element('forwardSaveForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (saveFields.disabled || busy) return;
    const amount = amountInput.valueAsNumber;
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > wallet.unallocated) return;
    busy = true;
    const id = 'ai_' + crypto.randomUUID().replaceAll('-', '');
    updateControls();
    saveStatus.textContent = 'AIを保存しています…';
    try {
      const result = await request(walletPath, walletState, {aiId:id, medals:amount,
        expected_revision:wallet.revision, model_version:savedModel.model_version});
      if (result.generations.at(-1)?.model_version !== savedModel.model_version ||
          (result.created && result.currentAiId !== id)) invalid();
      showWallet(result, result.created ? id : selected);
      renderRecords();
      saveStatus.textContent = result.created ? 'AIを保存し、' + medals(amount) + 'を配分しました。' :
        'モデルの内容は同じです。新しいAIと財布は作成されず、配分額も変わりません。';
      amountInput.value = '';
    } catch (error) {
      mustRefresh = true;
      saveStatus.textContent = error.status === 409 ?
        '保存状態が変わったか、配分できませんでした。再取得して内容を確認してください。' :
        '保存を確認できません。表示は最後に確認した残高です。再取得してください。';
    } finally {
      busy = false;
      updateControls();
      if (document.activeElement === document.body) {
        (saveFields.disabled ? refreshButton : amountInput).focus();
      }
    }
  });
  if (panel.open) void refresh();
}

const panel = element('forwardPanel');
if (panel) mountForwardPanel(panel);
