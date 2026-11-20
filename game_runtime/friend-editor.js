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
const wallet = byId('wallet');
const forecast = byId('forecast');
const frozen = byId('frozen');
const frozenVersion = byId('frozen-version');
const editableVersion = byId('editable-version');
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
  if (hasUnsaved()) window.addEventListener('beforeunload', warnBeforeLeaving);
  else window.removeEventListener('beforeunload', warnBeforeLeaving);
}

function clearAccount() {
  session = undefined;
  failedReads = [];
  if (logoutDialog.open) logoutDialog.close('');
  login.hidden = false;
  for (const panel of [workspace, account, profile, preview, profileError, frozen]) panel.hidden = true;
  for (const element of [accountId, wallet, forecast, frozenVersion, editableVersion, previewName,
    profileError, groups.companion.revision, groups.look.revision]) element.textContent = '';
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
  if (kind === 'companion') editableVersion.textContent = data.model_version ?? '未作成';
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

function forecastInfo(data) {
  checked(exact(data, ['status', 'records']) && Array.isArray(data.records));
  if (data.status === 'unconnected' && data.records.length === 0) return {text:'予測記録は未接続です。'};
  const [record] = data.records;
  checked(data.status === 'MOCK_NONLIVE' && data.records.length === 1 && isObject(record) &&
    record.sourceMode === 'MOCK_NONLIVE' && ['PENDING', 'SCORED_MOCK_NONLIVE'].includes(record.status) &&
    matches(frozenModelPattern, record.model_version));
  return {text:record.status === 'PENDING' ? '確定済み・採点待ち' : '採点済み', version:record.model_version};
}

const panelReads = [
  {
    path:'/friend/character', validate:validateProfile, render:renderProfile,
    fail() {
      profileError.textContent = '編集設定を読み込めませんでした。再読み込みをお試しください。';
      profileError.hidden = false;
    },
  },
  {
    path:'/friend/forward/summary', validate:walletText,
    render(value) { wallet.textContent = value; },
    fail() { wallet.textContent = '財布を読み込めませんでした。'; },
  },
  {
    path:'/friend/forward/records', validate:forecastInfo,
    render({text, version}) {
      forecast.textContent = text;
      frozenVersion.textContent = version ?? '';
      frozen.hidden = !version;
    },
    fail() { forecast.textContent = '予測記録を読み込めませんでした。'; },
  },
];

async function readPanels(controller, panels) {
  const results = await Promise.allSettled(panels.map(({path, validate}) =>
    request(path, controller, {auth:session}).then(validate)));
  controller.signal.throwIfAborted();
  failedReads = panels.filter((panel, index) => {
    const result = results[index];
    if (result.status === 'fulfilled') panel.render(result.value);
    else panel.fail();
    return result.status === 'rejected';
  });
}

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
    await readPanels(controller, panelReads);
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
