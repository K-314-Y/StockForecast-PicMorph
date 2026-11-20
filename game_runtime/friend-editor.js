const byId = id => document.getElementById(id);
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const colorPattern = /^#[0-9a-f]{6}$/;
const accountPattern = /^[A-Za-z0-9]{1,32}$/;
const modelPattern = /^companion-v1(?:_\d{1,3}){5}$/;
const frozenModelPattern = /^(?:companion-v1|appearance-v[1-9]\d{0,2})(?:_\d{1,3}){5}$/;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);
const exact = (value, keys) => isObject(value) && Object.keys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key));

const groups = {
  companion: {
    form:byId('companion-form'), fields:byId('companion-fields'), label:'相棒と戦略',
    revision:byId('companion-revision'), apiKey:'companion',
    inputs:{name:byId('companion-name'), hair_color:byId('hair-color'), clothing_color:byId('clothing-color'),
      approach:byId('approach'), risk_percent:byId('risk')},
  },
  look: {
    form:byId('look-form'), fields:byId('look-fields'), label:'外見パーツ',
    revision:byId('look-revision'), apiKey:'looks',
    inputs:{hair_style:byId('hair-style'), expression:byId('expression'), accessory:byId('accessory')},
  },
};
for (const [kind, group] of Object.entries(groups)) {
  group.dirtyStatus = byId(kind + '-dirty');
  group.conflict = byId(kind + '-conflict');
  group.restore = byId('restore-' + kind);
  group.reapply = byId('reapply-' + kind);
}
const options = input => Array.from(input.options, option => option.value);
const approaches = options(groups.companion.inputs.approach);
const lookChoices = Object.entries(groups.look.inputs).map(([key, input]) => [key, options(input)]);

function validName(name) {
  return typeof name === 'string' && Boolean(name.trim()) && [...name].length <= 16 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(name);
}

function validCompanion(companion) {
  return validName(companion.name) && matches(colorPattern, companion.hair_color) &&
    matches(colorPattern, companion.clothing_color) && approaches.includes(companion.approach) &&
    Number.isInteger(companion.risk_percent) && companion.risk_percent >= 5 &&
    companion.risk_percent <= 100 && companion.risk_percent % 5 === 0;
}

function validLook(look) {
  return lookChoices.every(([key, choices]) => choices.includes(look[key]));
}

function validRevision(record, group) {
  return exact(record, ['created', 'revision', ...Object.keys(group.inputs)]) &&
    Number.isSafeInteger(record.revision) && record.revision >= 0 &&
    record.created === (record.revision > 0);
}

function checked(condition) {
  if (!condition) throw new Error('unexpected_response');
}

function validateProfile(value) {
  checked(exact(value, ['companion', 'looks', 'model_version']) &&
    validRevision(value.companion, groups.companion) && validCompanion(value.companion) &&
    validRevision(value.looks, groups.look) && validLook(value.looks) &&
    (value.companion.created ? matches(modelPattern, value.model_version) : value.model_version === null));
  return value;
}

const login = byId('login');
const invite = byId('invite');
const workspace = byId('workspace');
const profile = byId('profile');
const preview = byId('preview');
const profileError = byId('profile-error');
const account = byId('account');
const accountId = byId('account-id');
const logout = byId('logout');
const logoutDialog = byId('logout-dialog');
const retryReads = byId('retry-reads');
const refreshMock = byId('refresh-mock');
const practiceRefresh = byId('practice-refresh');
const practiceStart = byId('practice-start');
const practiceReveal = byId('practice-reveal');
const practiceRequirement = byId('practice-requirement');
const wallet = byId('wallet');
const forecast = byId('forecast');
const savedCompanion = byId('saved-companion');
const editableVersion = byId('editable-version');
const predictionStep = byId('prediction-step');
const resultStep = byId('result-step');
const previewName = byId('preview-name');
const riskValue = byId('risk-value');

const hairShapes = document.querySelectorAll('[data-hair-color]');
const clothingShape = document.querySelector('[data-clothing-color]');
const parts = document.querySelectorAll('#avatar .part');

function previewEdits() {
  const {name, hair_color, clothing_color, risk_percent} = groups.companion.inputs;
  const {hair_style, expression, accessory} = groups.look.inputs;
  previewName.textContent = name.value || '相棒';
  riskValue.value = risk_percent.value + '%';
  for (const shape of hairShapes) {
    if (matches(colorPattern, hair_color.value)) shape.setAttribute('fill', hair_color.value);
  }
  if (matches(colorPattern, clothing_color.value)) clothingShape.setAttribute('fill', clothing_color.value);
  for (const part of parts) {
    part.classList.toggle('selected', part.dataset.hair === hair_style.value ||
      part.dataset.expression === expression.value || part.dataset.accessory === accessory.value);
  }
}

// Module scope is private to this page. Each operation owns an abort signal so a
// previous page/session cannot render after the UI has been cleared.
let session;
let operation;
let failedReads = [];
let practiceState = null;

function draftValues(group) {
  return Object.fromEntries(Object.entries(group.inputs).map(([key, input]) =>
    [key, input.type === 'range' ? input.valueAsNumber : input.value]));
}

function writeValues(group, values) {
  for (const [key, input] of Object.entries(group.inputs)) {
    if (Object.hasOwn(values, key)) input.value = values[key];
  }
}

function isDirty(group) {
  return Boolean(group.pendingDraft || (group.saved &&
    Object.entries(draftValues(group)).some(([key, value]) => value !== group.saved[key])));
}

function hasUnsaved() {
  return Object.values(groups).some(isDirty);
}

function warnBeforeLeaving(event) {
  event.preventDefault();
  event.returnValue = true;
}

function feedback(message = '', error = false) {
  byId('message').textContent = message;
  byId('feedback').classList.toggle('error', error);
}

function syncControls() {
  const busy = Boolean(operation);
  byId('spinner').hidden = !busy;
  invite.disabled = busy;
  byId('login-button').disabled = busy;
  logout.disabled = busy;
  retryReads.disabled = busy;
  retryReads.hidden = failedReads.length === 0;
  refreshMock.disabled = busy;
  practiceRefresh.disabled = busy;
  for (const group of Object.values(groups)) {
    const dirty = isDirty(group);
    const hasConflict = Boolean(group.pendingDraft);
    group.fields.disabled = busy || !group.saved || hasConflict;
    group.restore.disabled = busy || !dirty;
    group.reapply.disabled = busy;
    group.reapply.hidden = group.conflict.hidden = !hasConflict;
    const text = hasConflict ? '未保存の下書きあり' : dirty ? '未保存の変更あり' : '';
    if (group.dirtyStatus.textContent !== text) group.dirtyStatus.textContent = text;
  }
  const unsaved = hasUnsaved();
  const practiceBlocked = unsaved || !groups.companion.saved?.created || failedReads.includes(profileRead);
  practiceStart.disabled = busy || practiceBlocked;
  practiceReveal.disabled = busy;
  practiceRequirement.hidden = practiceState?.status !== 'ready' || !practiceBlocked;
  practiceRequirement.textContent = practiceRequirement.hidden ? '' :
    '相棒と戦略を保存し、両方のフォームの未保存の変更を解消すると開始できます。';
  if (unsaved) window.addEventListener('beforeunload', warnBeforeLeaving);
  else window.removeEventListener('beforeunload', warnBeforeLeaving);
}

function clearAccount() {
  session = undefined;
  failedReads = [];
  if (logoutDialog.open) logoutDialog.close('');
  login.hidden = false;
  for (const panel of [workspace, account, profile, preview, profileError]) panel.hidden = true;
  for (const element of [accountId, wallet, forecast, savedCompanion, editableVersion, previewName,
    predictionStep, resultStep, profileError, groups.companion.revision, groups.look.revision]) element.textContent = '';
  clearRecord();
  renderPractice(null);
  for (const group of Object.values(groups)) {
    group.saved = group.pendingDraft = undefined;
    group.form.reset();
  }
  for (const part of parts) part.classList.remove('selected');
  for (const shape of [...hairShapes, clothingShape]) shape.removeAttribute('fill');
  riskValue.value = '';
  invite.value = '';
}

function invalidate(message = '', focus = false) {
  operation?.abort();
  operation = undefined;
  clearAccount();
  feedback(message, Boolean(message));
  syncControls();
  if (focus) invite.focus();
}

class RequestError extends Error {
  constructor(status) {
    super('request_failed');
    this.status = status;
  }
}

async function request(path, controller, {method = 'GET', auth, body} = {}) {
  const headers = {Accept:'application/json'};
  if (auth) headers.Authorization = 'Bearer ' + auth.token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method === 'POST' && auth) headers['X-CSRF-Token'] = auth.csrf;
  const response = await fetch(path, {
    method, headers, body:body === undefined ? undefined : JSON.stringify(body),
    credentials:'omit', cache:'no-store', redirect:'error', referrerPolicy:'no-referrer',
    signal:controller.signal,
  });
  controller.signal.throwIfAborted();
  if (response.status === 401) {
    const message = path === '/friend/invite/redeem' ? 'この招待コードは使用できません。' :
      'セッションが終了しました。新しい招待コードでログインしてください。';
    invalidate(message, true);
  }
  if (!response.ok) throw new RequestError(response.status);
  checked(response.status === 200 && response.headers.get('content-type') === 'application/json; charset=utf-8');
  const data = await response.json();
  controller.signal.throwIfAborted();
  return data;
}

async function run(pending, fallback, action) {
  if (operation) return;
  const controller = new AbortController();
  operation = controller;
  feedback(pending);
  syncControls();
  let focus;
  try {
    focus = await action(controller);
  } catch (error) {
    if (operation !== controller) return;
    feedback(error.status === 429 ? '試行回数の上限に達しました。少し待ってからお試しください。' : fallback, true);
    focus = login.hidden ? undefined : invite;
  } finally {
    if (operation === controller) {
      operation = undefined;
      syncControls();
      focus?.focus();
    }
  }
}

function renderGroup(kind, data) {
  const group = groups[kind];
  const record = data[group.apiKey];
  group.saved = record;
  group.pendingDraft = undefined;
  writeValues(group, record);
  group.revision.textContent = record.created ? String(record.revision) : '0（初期値）';
  if (kind === 'companion') {
    savedCompanion.textContent = record.created ? '保存済み · ' + record.name : '相棒は初期設定';
    editableVersion.textContent = data.model_version ?? '戦略を保存すると表示';
  }
}

function renderProfile(data) {
  renderGroup('companion', data);
  renderGroup('look', data);
  profile.hidden = false;
  preview.hidden = false;
  profileError.hidden = true;
  profileError.textContent = '';
  previewEdits();
}

function walletText(data) {
  checked(exact(data, ['status', 'summary']));
  if (data.status === 'uninitialized' && data.summary === null) return '財布は未作成です。';
  const summary = data.summary;
  checked(data.status === 'MOCK_NONLIVE' && isObject(summary) && summary.mock === true &&
    Number.isFinite(summary.unallocated) && summary.unallocated >= 0 &&
    Number.isFinite(summary.initialMedals) && summary.initialMedals >= summary.unallocated);
  const format = new Intl.NumberFormat('ja-JP', {maximumFractionDigits:6});
  return '未配分 ' + format.format(summary.unallocated) + ' 枚 ／ 初期 ' + format.format(summary.initialMedals) + ' 枚';
}

const directions = ['UP', 'FLAT', 'DOWN'];
const symbolPattern = /^[0-9A-Z]{4,5}$/;
const aiPattern = /^[a-z][a-z0-9_-]{1,39}$/;
const timestampPattern = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

function validTimestamp(value) {
  return matches(timestampPattern, value) && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

function validOrder(order, filledStatus) {
  return exact(order, ['status', 'at']) && ['NONE', 'QUEUED', 'CANCELLED', filledStatus].includes(order.status) &&
    (order.status === 'NONE' ? order.at === null : validTimestamp(order.at));
}

function validScore(record) {
  const {score, open, close, targetAt, direction, predictedChangePct} = record;
  if (record.status === 'PENDING') return score === null;
  return record.status === 'SCORED_MOCK_NONLIVE' &&
    exact(score, ['brier', 'directionCorrect', 'actualDirection', 'absoluteChangeErrorPctPoints', 'scoredAt']) &&
    open.status === 'OPENED' && close.status === 'CLOSED' && close.at === targetAt &&
    directions.includes(score.actualDirection) &&
    score.directionCorrect === (direction === null ? null : direction === score.actualDirection) &&
    Number.isFinite(score.brier) && score.brier >= 0 && score.brier <= 2 &&
    (predictedChangePct === null ? score.absoluteChangeErrorPctPoints === null :
      Number.isFinite(score.absoluteChangeErrorPctPoints) && score.absoluteChangeErrorPctPoints >= 0) &&
    validTimestamp(score.scoredAt) && Date.parse(score.scoredAt) >= Date.parse(targetAt);
}

function validFx(record) {
  const {fx} = record;
  return fx === undefined || fx === null || (record.score !== null &&
    exact(fx, ['rawPnl', 'gamePnl', 'basisPoints', 'commitment']) && fx.rawPnl === record.realizedPnl &&
    Number.isFinite(fx.gamePnl) && [9800, 9900, 10000, 10100, 10200].includes(fx.basisPoints) &&
    matches(/^[a-f0-9]{64}$/, fx.commitment));
}

function validateForecast(data) {
  checked(exact(data, ['status', 'records']) && Array.isArray(data.records));
  if (data.status === 'unconnected' && data.records.length === 0) return null;
  const [record] = data.records;
  const fields = ['aiId', 'model_version', 'symbol', 'sourceMode', 'confirmedAt', 'targetAt',
    'direction', 'predictedChangePct', 'open', 'close', 'realizedPnl', 'score', 'status'];
  if (isObject(record) && Object.hasOwn(record, 'fx')) fields.push('fx');
  checked(data.status === 'MOCK_NONLIVE' && data.records.length === 1 && exact(record, fields));
  const {predictedChangePct:change, direction} = record;
  const pointDirection = change > 0 ? 'UP' : change < 0 ? 'DOWN' : 'FLAT';
  checked(record.sourceMode === 'MOCK_NONLIVE' && matches(aiPattern, record.aiId) &&
    matches(frozenModelPattern, record.model_version) && matches(symbolPattern, record.symbol) &&
    validTimestamp(record.confirmedAt) && validTimestamp(record.targetAt) &&
    Date.parse(record.confirmedAt) < Date.parse(record.targetAt) &&
    (direction === null || directions.includes(direction)) &&
    (change === null || (Number.isFinite(change) && change > -100 && change <= 10_000 &&
      direction === pointDirection)) &&
    validOrder(record.open, 'OPENED') && validOrder(record.close, 'CLOSED') &&
    (record.close.status === 'NONE' || record.open.status === 'OPENED') &&
    (record.close.status === 'CLOSED' ? Number.isFinite(record.realizedPnl) : record.realizedPnl === null) &&
    validScore(record) && validFx(record));
  return record;
}

const recordPanel = byId('mock-record');
const unconnected = byId('mock-unconnected');
const scorePanel = byId('record-score');
const pendingScore = byId('record-pending');
const pnlPanel = byId('record-pnl');
const fxRows = ['fx-rate-row', 'fx-pnl-row', 'fx-note'].map(byId);
const recordValues = recordPanel.querySelectorAll('dd');
const number = new Intl.NumberFormat('ja-JP', {maximumFractionDigits:6});
const signedNumber = new Intl.NumberFormat('ja-JP', {maximumFractionDigits:6, signDisplay:'exceptZero'});
const japanTime = new Intl.DateTimeFormat('ja-JP', {
  timeZone:'Asia/Tokyo', dateStyle:'medium', timeStyle:'medium',
});

function clearRecord() {
  for (const value of recordValues) value.textContent = '';
  for (const panel of [recordPanel, unconnected, scorePanel, pendingScore, pnlPanel, ...fxRows]) panel.hidden = true;
}

function fillRecord(values) {
  for (const [id, value] of Object.entries(values)) byId(id).textContent = value;
}

function renderForecast(record, failed = false) {
  clearRecord();
  if (!record) {
    forecast.textContent = failed ? '予測記録を読み込めませんでした。' : '予測記録は未接続です。';
    predictionStep.textContent = failed ? '取得できませんでした' : '未接続 · 準備中';
    resultStep.textContent = failed ? '取得できませんでした' : 'まだ記録なし';
    unconnected.hidden = failed;
    return;
  }
  const {score, realizedPnl, fx} = record;
  forecast.textContent = score ? '採点済み' : '確定済み・採点待ち';
  predictionStep.textContent = record.symbol + ' · 確定済み';
  resultStep.textContent = score ? '採点済み' : '採点待ち';
  fillRecord({
    'record-ai':record.aiId,
    'frozen-version':record.model_version,
    'record-symbol':record.symbol,
    'record-direction':record.direction ?? '方向未判定',
    'record-change':record.predictedChangePct === null ? '未記録' : signedNumber.format(record.predictedChangePct) + '%',
    'record-confirmed':japanTime.format(new Date(record.confirmedAt)),
    'record-target':japanTime.format(new Date(record.targetAt)),
  });
  if (score) fillRecord({
    'score-direction':score.actualDirection,
    'score-correct':score.directionCorrect === null ? '判定なし' : score.directionCorrect ? '的中' : '不的中',
    'score-brier':number.format(score.brier),
    'score-error':score.absoluteChangeErrorPctPoints === null ? '未記録' :
      number.format(score.absoluteChangeErrorPctPoints) + ' ポイント',
    'score-time':japanTime.format(new Date(score.scoredAt)),
  });
  if (realizedPnl !== null) fillRecord({'raw-pnl':signedNumber.format(realizedPnl) + ' 枚'});
  if (fx) fillRecord({
    'fx-rate':number.format(fx.basisPoints / 10_000) + ' 倍',
    'fx-pnl':signedNumber.format(fx.gamePnl) + ' 枚',
  });
  pendingScore.hidden = Boolean(score);
  scorePanel.hidden = !score;
  pnlPanel.hidden = realizedPnl === null;
  for (const row of fxRows) row.hidden = !fx;
  recordPanel.hidden = false;
}

const practiceIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const practiceLabels = {
  unconfigured:'架空練習は未接続です。',
  ready:'この口座で1ラウンド練習できます。',
  starting:'予測を確定しています。練習状態を再取得できます。',
  frozen:'予測を確定しました。結果を公開すると採点します。',
  exhausted:'結果を公開しました。このサーバーでの1ラウンドは終了です。',
};

function validatePractice(data) {
  checked(isObject(data) && Object.hasOwn(practiceLabels, data.status));
  if (['unconfigured', 'ready', 'starting'].includes(data.status)) {
    checked(exact(data, ['status']));
    return data;
  }
  const fields = ['status', 'round_id', 'companion_revision', 'model_version', 'risk_percent',
    'issuedAt', 'targetAt', 'probabilities', 'direction'];
  const revealed = data.status === 'exhausted';
  if (revealed) fields.push('result');
  const {probabilities, direction, result} = data;
  checked(exact(data, fields) && matches(practiceIdPattern, data.round_id) &&
    Number.isSafeInteger(data.companion_revision) && data.companion_revision > 0 &&
    matches(modelPattern, data.model_version) && Number.isInteger(data.risk_percent) &&
    data.risk_percent >= 5 && data.risk_percent <= 100 && data.risk_percent % 5 === 0 &&
    validTimestamp(data.issuedAt) && validTimestamp(data.targetAt) && data.issuedAt < data.targetAt &&
    exact(probabilities, directions) && directions.every(key =>
      Number.isFinite(probabilities[key]) && probabilities[key] >= 0 && probabilities[key] <= 1) &&
    Math.abs(probabilities.UP + probabilities.FLAT + probabilities.DOWN - 1) <= 1e-12);
  const top = Math.max(...Object.values(probabilities));
  const leaders = directions.filter(key => probabilities[key] === top);
  checked(direction === (leaders.length === 1 ? leaders[0] : null));
  if (revealed) {
    checked(exact(result, ['referencePrice', 'targetPrice', 'scoredAt', 'actualChangePct',
      'actualDirection', 'brier', 'directionCorrect']) &&
      [result.referencePrice, result.targetPrice].every(price =>
        Number.isFinite(price) && price >= .000001 && price <= 1_000_000_000) &&
      result.scoredAt === data.targetAt && Number.isFinite(result.actualChangePct) &&
      directions.includes(result.actualDirection) &&
      result.directionCorrect === (direction === null ? null : direction === result.actualDirection) &&
      Number.isFinite(result.brier) && result.brier >= 0 && result.brier <= 2);
  }
  return data;
}

const practicePrediction = byId('practice-prediction');
const practiceResult = byId('practice-result');
const practiceValues = document.querySelectorAll('.practice dd');

function renderPractice(state, failed = false) {
  practiceState = state;
  const status = state?.status;
  byId('practice-status').textContent = failed ? '練習状態を取得できませんでした。' : practiceLabels[status] ?? '';
  practiceRefresh.hidden = !status || status === 'unconfigured';
  practiceStart.hidden = status !== 'ready';
  practiceReveal.hidden = status !== 'frozen';
  practicePrediction.hidden = status !== 'frozen' && status !== 'exhausted';
  practiceResult.hidden = status !== 'exhausted';
  for (const value of practiceValues) value.textContent = '';
  if (!practicePrediction.hidden) fillRecord({
    'practice-model':state.model_version,
    'practice-revision':String(state.companion_revision),
    'practice-risk':state.risk_percent + '%',
    'practice-issued':japanTime.format(new Date(state.issuedAt)),
    'practice-target':japanTime.format(new Date(state.targetAt)),
    'practice-direction':state.direction ?? '方向未判定',
    'practice-probabilities':directions.map(key => key + ' ' + number.format(state.probabilities[key] * 100) + '%').join(' ／ '),
  });
  if (state?.result) {
    const {targetPrice, referencePrice, actualChangePct, actualDirection, directionCorrect, brier} = state.result;
    fillRecord({
      'practice-reference-price':number.format(referencePrice),
      'practice-target-price':number.format(targetPrice),
      'practice-actual':actualDirection,
      'practice-change':signedNumber.format(actualChangePct) + '%',
      'practice-correct':directionCorrect === null ? '判定なし' : directionCorrect ? '的中' : '不的中',
      'practice-brier':number.format(brier),
    });
  }
}

const practiceRead = {
  path:'/friend/practice', validate:validatePractice, render:renderPractice,
  fail() { renderPractice(null, true); },
};

const profileRead = {
  path:'/friend/character', validate:validateProfile, render:renderProfile,
  fail() {
    savedCompanion.textContent = editableVersion.textContent = '取得できませんでした';
    profileError.textContent = '編集設定を読み込めませんでした。再読み込みをお試しください。';
    profileError.hidden = false;
  },
};
const mockReads = [
  {
    path:'/friend/forward/summary', validate:walletText,
    render(value) { wallet.textContent = value; },
    fail() { wallet.textContent = '財布を読み込めませんでした。'; },
  },
  {
    path:'/friend/forward/records', validate:validateForecast, render:renderForecast,
    fail() { renderForecast(null, true); },
  },
];

async function readPanels(controller, panels) {
  const results = await Promise.allSettled(panels.map(({path, validate}) =>
    request(path, controller, {auth:session}).then(validate)));
  controller.signal.throwIfAborted();
  const failed = new Set(failedReads);
  for (const [index, panel] of panels.entries()) {
    const result = results[index];
    if (result.status === 'fulfilled') {
      panel.render(result.value);
      failed.delete(panel);
    } else {
      panel.fail();
      failed.add(panel);
    }
  }
  failedReads = [...failed];
  return results.every(result => result.status === 'fulfilled');
}

refreshMock.addEventListener('click', () => {
  if (!session || operation) return;
  void run('模擬記録を取得中…', '模擬記録を取得できませんでした。', async controller => {
    const ok = await readPanels(controller, mockReads);
    controller.signal.throwIfAborted();
    feedback(ok ? '模擬記録を再取得しました。' : '取得できない模擬記録があります。', !ok);
    return refreshMock;
  });
});

retryReads.addEventListener('click', () => {
  if (!session || operation || !failedReads.length) return;
  void run('再読み込み中…', '再読み込みできませんでした。', async controller => {
    await readPanels(controller, failedReads);
    controller.signal.throwIfAborted();
    feedback(failedReads.length ? '取得できない項目があります。もう一度お試しください。' : '再読み込みしました。',
      Boolean(failedReads.length));
    return failedReads.length ? retryReads : logout;
  });
});

practiceRefresh.addEventListener('click', () => {
  if (!session || operation) return;
  void run('練習状態を取得中…', '練習状態を取得できませんでした。', async controller => {
    const ok = await readPanels(controller, [practiceRead]);
    controller.signal.throwIfAborted();
    feedback(ok ? '練習状態を再取得しました。' : '練習状態を取得できませんでした。', !ok);
    return practiceRefresh.hidden ? retryReads : practiceRefresh;
  });
});

practiceStart.addEventListener('click', () => {
  if (!session || operation || practiceStart.disabled || practiceState?.status !== 'ready' || hasUnsaved()) return;
  const expected = groups.companion.saved.revision;
  void run('架空の予測を計算中…', '練習を開始できませんでした。練習状態を再取得してください。', async controller => {
    let data;
    try {
      data = validatePractice(await request('/friend/practice/start', controller, {
        method:'POST', auth:session, body:{expected_companion_revision:expected},
      }));
    } catch (error) {
      if (error.status !== 409) throw error;
      await readPanels(controller, [practiceRead]);
      controller.signal.throwIfAborted();
      if (practiceState?.status === 'ready') {
        await readPanels(controller, [profileRead]);
        controller.signal.throwIfAborted();
        feedback('保存版を確認し直しました。相棒の設定を確認して開始してください。', true);
      } else {
        feedback('練習の進行状態を確認してください。', true);
      }
      return practiceRefresh.hidden ? retryReads : practiceRefresh;
    }
    checked(data.status === 'frozen' && data.companion_revision === expected);
    renderPractice(data);
    feedback('架空の予測を確定しました。');
    return practiceReveal;
  });
});

practiceReveal.addEventListener('click', () => {
  if (!session || operation || practiceState?.status !== 'frozen') return;
  const {round_id} = practiceState;
  void run('架空の結果を採点中…', '結果を公開できませんでした。練習状態を再取得してください。', async controller => {
    const data = validatePractice(await request('/friend/practice/reveal', controller, {
      method:'POST', auth:session, body:{round_id},
    }));
    checked(data.status === 'exhausted' && data.round_id === round_id);
    renderPractice(data);
    feedback('架空の結果を公開しました。');
    return practiceRefresh;
  });
});

login.addEventListener('submit', event => {
  event.preventDefault();
  if (operation || !login.reportValidity()) return;
  const code = invite.value.trim();
  invite.value = '';
  if (!tokenPattern.test(code)) {
    feedback('招待コードを確認して入力してください。', true);
    invite.focus();
    return;
  }
  clearAccount();
  void run('ログイン中…', 'ログインできませんでした。招待コードを確認してください。', async controller => {
    const redeemed = await request('/friend/invite/redeem', controller, {method:'POST', body:{invite:code}});
    checked(exact(redeemed, ['authenticated', 'sessionToken']) && redeemed.authenticated === true &&
      matches(tokenPattern, redeemed.sessionToken));
    const token = redeemed.sessionToken;
    const info = await request('/friend/session', controller, {auth:{token}});
    checked(exact(info, ['authenticated', 'accountId', 'csrfToken', 'expiresAt']) && info.authenticated === true &&
      matches(accountPattern, info.accountId) && matches(tokenPattern, info.csrfToken) &&
      Number.isSafeInteger(info.expiresAt) && info.expiresAt > 0);
    session = {token, csrf:info.csrfToken};
    await readPanels(controller, [profileRead, ...mockReads, practiceRead]);
    controller.signal.throwIfAborted();
    accountId.textContent = info.accountId;
    login.hidden = true;
    account.hidden = false;
    workspace.hidden = false;
    feedback('ログインしました。');
    return profile.hidden ? retryReads : groups.companion.inputs.name;
  });
});

for (const [kind, group] of Object.entries(groups)) {
  function refreshDraft() {
    previewEdits();
    syncControls();
  }
  group.form.addEventListener('input', refreshDraft);
  group.restore.addEventListener('click', () => {
    if (operation || !isDirty(group)) return;
    writeValues(group, group.saved);
    group.pendingDraft = undefined;
    refreshDraft();
    Object.values(group.inputs)[0].focus();
    feedback(group.label + 'を保存内容に戻しました。');
  });
  group.reapply.addEventListener('click', () => {
    if (operation || !group.pendingDraft) return;
    writeValues(group, group.pendingDraft);
    group.pendingDraft = undefined;
    refreshDraft();
    Object.values(group.inputs)[0].focus();
    feedback('下書きを再適用しました。内容を確認してから保存してください。');
  });
  group.form.addEventListener('submit', event => {
    event.preventDefault();
    if (!session || operation || !group.saved || group.pendingDraft || !group.form.reportValidity()) return;
    const draft = draftValues(group);
    if (!(kind === 'companion' ? validCompanion(draft) : validLook(draft))) {
      feedback('名前は制御文字を含まない1〜16文字で入力し、各設定を確認してください。', true);
      return;
    }
    const button = event.submitter;
    const expected = group.saved.revision;
    void run('保存中…', '保存結果を確認できませんでした。時間をおいてお試しください。', async controller => {
      try {
        const data = validateProfile(await request('/friend/character/' + kind, controller, {
          method:'POST', auth:session, body:{expected_revision:expected, [kind]:draft},
        }));
        checked(data[group.apiKey].revision === expected + 1);
        renderGroup(kind, data);
        previewEdits();
        feedback(group.label + 'を保存しました。');
      } catch (error) {
        if (error.status !== 409) throw error;
        let latest;
        try {
          latest = validateProfile(await request('/friend/character', controller, {auth:session}));
        } catch {
          controller.signal.throwIfAborted();
          feedback('最新の保存内容を取得できませんでした。入力を保持しました。時間をおいて保存をお試しください。', true);
          return button;
        }
        const changed = Object.entries(draft).filter(([key, value]) =>
          value !== group.saved[key] && value !== latest[group.apiKey][key]);
        renderGroup(kind, latest);
        if (changed.length) group.pendingDraft = Object.fromEntries(changed);
        previewEdits();
        feedback('同時編集がありました。' + group.label + 'の最新の保存内容を表示しました。', true);
        return group.pendingDraft ? group.reapply : button;
      }
      return button;
    });
  });
}

function signOut() {
  if (!session || operation) return;
  const auth = session;
  clearAccount();
  void run('ログアウト中…', 'この画面からログアウトしました。サーバーへの通知は確認できませんでした。', async controller => {
    const result = await request('/friend/logout', controller, {method:'POST', auth});
    checked(exact(result, ['authenticated']) && result.authenticated === false);
    feedback('ログアウトしました。');
    return invite;
  });
}

logout.addEventListener('click', () => {
  if (!session || operation) return;
  if (hasUnsaved()) {
    logoutDialog.returnValue = '';
    logoutDialog.showModal();
  } else signOut();
});

logoutDialog.addEventListener('close', () => {
  const choice = logoutDialog.returnValue;
  logoutDialog.returnValue = '';
  if (choice === 'discard') signOut();
});

window.addEventListener('pagehide', () => invalidate());
invalidate();
