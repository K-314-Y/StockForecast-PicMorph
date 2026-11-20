import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {request} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createForwardMarketAdapter} from '../../game_runtime/forward-market-adapter.mjs';
import {MOCK_MARKET_PAPER_MODE, MOCK_MARKET_SOURCE} from '../../game_runtime/forward-market-guard.mjs';
import {openForwardStore} from '../../game_runtime/forward-store.mjs';
import {startFriendMockServer} from '../../game_runtime/friend-mock-server.mjs';
import {friendPracticeCampaign, friendPracticeScenario, provisionFriendMockRound} from './friend-mock-record-fixture.mjs';

const character = '/friend/character';
const summary = '/friend/forward/summary';
const records = '/friend/forward/records';
const redeem = '/friend/invite/redeem';
const session = '/friend/session';
const logout = '/friend/logout';

async function setup(t, prepareSources, preparePractice) {
  const walletRoot = await mkdtemp(join(tmpdir(), 'p9h-friends-'));
  t.after(() => rm(walletRoot, {recursive:true, force:true}));
  const ids = ['AliceFixture', 'BobFixture'];
  const accounts = new Map();
  for (const id of ids) {
    const folder = join(walletRoot, id);
    await mkdir(folder, {mode:0o700});
    accounts.set(id, join(folder, 'wallet.json'));
  }
  const accountRecordSources = await prepareSources?.(accounts);
  const practiceScenarios = preparePractice?.(ids);
  const server = await startFriendMockServer({walletRoot, accounts, accountRecordSources, practiceScenarios});
  t.after(() => server.close());
  return {server, ids, accounts};
}

function call(server, path, {method = 'GET', headers = {}, body} = {}) {
  const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = request({
      hostname:'127.0.0.1', port:server.port, path, method,
      headers:{
        Host:new URL(server.origin).host, Connection:'close',
        ...(method === 'POST' ? {Origin:server.origin} : {}),
        ...(bytes ? {'Content-Type':'application/json', 'Content-Length':bytes.length} : {}),
        ...headers,
      },
    }, res => {
      res.setEncoding('utf8');
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({status:res.statusCode, headers:res.headers, text, json:() => JSON.parse(text)}));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(bytes);
  });
}

async function login(server, id) {
  const response = await call(server, redeem, {method:'POST', body:{invite:server.issueInvite(id).token}});
  assert.equal(response.status, 200);
  const {sessionToken} = response.json();
  const bearer = {Authorization:'Bearer ' + sessionToken};
  const info = await call(server, session, {headers:bearer});
  assert.equal(info.status, 200);
  assert.equal(info.json().accountId, id);
  return {bearer, write:{...bearer, 'X-CSRF-Token':info.json().csrfToken}};
}

const companion = {
  name:'ミント', hair_color:'#9a74df', clothing_color:'#45b9a2', approach:'momentum', risk_percent:45,
};
const look = {hair_style:'twintails', expression:'calm', accessory:'star'};

test('P9h serves precisely three public resources with scoped CSP and no account data', async t => {
  const {server, ids} = await setup(t);
  const {token} = server.issueInvite(ids[0]);
  const csp = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
  const lockdown = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
  for (const [path, type] of [
    ['/friend/', 'text/html'], ['/friend/editor.js', 'text/javascript'], ['/friend/editor.css', 'text/css'],
  ]) {
    const res = await call(server, path);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], type + '; charset=utf-8');
    assert.equal(res.headers['content-security-policy'], type === 'text/html' ? csp : lockdown);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.equal(res.headers['cross-origin-resource-policy'], 'same-origin');
    assert.equal(res.headers['set-cookie'], undefined);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
    assert.equal([...ids, token].some(value => res.text.includes(value)), false);
    assert.equal((await call(server, path + '?')).status, 400);
    assert.equal((await call(server, path + '?accountId=BobFixture')).status, 400);
    assert.equal((await call(server, path, {method:'HEAD'})).status, 404);
    assert.equal((await call(server, path, {headers:{Host:'localhost:' + server.port}})).status, 403);
    assert.equal((await call(server, path, {headers:{'Sec-Fetch-Site':'cross-site'}})).status, 403);
    if (type === 'text/html') {
      assert.match(res.text, /<script type="module" src="\/friend\/editor.js"><\/script>/);
      assert.match(res.text, /href="\/friend\/editor.css"/);
      assert.match(res.text, /type="password" autocomplete="off"/);
      assert.doesNotMatch(res.text, /\bon\w+\s*=|<style|\sstyle=|sessionToken|csrfToken/i);
    }
  }
  for (const path of ['/friend', '/friend/friend-editor.js', '/friend/../friend/editor.js',
    '/friend/%65ditor.js', '/friend/editor.js/', '/favicon.ico', '/game', '/api/companion', '/assets/test.png']) {
    assert.equal((await call(server, path)).status, 404, path);
  }
  for (const path of [session, character, summary, records]) {
    const res = await call(server, path);
    assert.equal(res.status, 401);
    assert.equal(res.headers['content-security-policy'], lockdown);
    assert.deepEqual(res.json(), {error:'authentication_required'});
  }
});

test('P9h editor endpoints persist both independent revisions and isolate accounts', async t => {
  const {server, ids} = await setup(t);
  const [a, b] = await Promise.all(ids.map(id => login(server, id)));
  const read = async user => {
    const res = await call(server, character, {headers:user.bearer});
    assert.equal(res.status, 200);
    return res.json();
  };
  const post = (user, kind, value, expected_revision = 0) => call(server, character + '/' + kind, {
    method:'POST', headers:user.write, body:{expected_revision, [kind]:value},
  });
  const before = await read(b);
  assert.equal(before.companion.revision, 0);
  assert.equal(before.looks.revision, 0);
  const saved = await post(a, 'companion', companion);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json().companion, {revision:1, created:true, ...companion});
  assert.equal(saved.json().looks.revision, 0);
  const appearance = await post(a, 'look', look);
  assert.equal(appearance.status, 200);
  assert.deepEqual(appearance.json().looks, {revision:1, created:true, ...look});
  assert.deepEqual(await read(a), appearance.json());
  assert.deepEqual(await read(b), before);
  assert.equal((await post(a, 'look', {...look, accessory:'glasses'})).status, 409);
  assert.equal((await post(b, 'look', {...look, accessory:'ribbon'})).status, 200);
  assert.deepEqual(await read(a), appearance.json());
  assert.equal((await call(server, logout, {method:'POST', headers:a.write})).status, 200);
  assert.equal((await call(server, character, {headers:a.bearer})).status, 401);
  assert.deepEqual(await read(await login(server, ids[0])), appearance.json());
});

async function openChromium(t) {
  let playwright;
  try {
    playwright = await import(process.env.FRIEND_UI_PLAYWRIGHT ?? 'playwright');
  } catch (error) {
    if (!process.env.FRIEND_UI_PLAYWRIGHT && error.code === 'ERR_MODULE_NOT_FOUND') {
      return t.skip('Playwright is optional. Set FRIEND_UI_PLAYWRIGHT to its installed module path.');
    }
    throw error;
  }
  const browser = await playwright.chromium.launch({
    executablePath:process.env.FRIEND_UI_CHROME,
    args:['--host-resolver-rules=MAP friend.localhost 127.0.0.1', '--no-proxy-server'],
  });
  t.after(() => browser.close());
  return browser;
}

test('P9h/P9i isolated Chromium editor, unsaved changes and retry', {timeout:35_000}, async t => {
  const browser = await openChromium(t);
  if (!browser) return;
  const {server, ids, accounts} = await setup(t);
  const marketAdapter = createForwardMarketAdapter({
    sourceId:MOCK_MARKET_SOURCE, licenseRef:'Local P9h fixture', observationIntervalMs:60_000,
    maxAgeMs:60_000, maxPublicationDelayMs:1000, verifyUsage:() => true,
    verifyRecord:() => null, marketStatusAt:() => 'HALTED',
    readBatch:() => assert.fail('The editor must only read saved mock data'),
  });
  await openForwardStore({filePath:accounts.get(ids[0]), marketAdapter, initial:{
    mode:MOCK_MARKET_PAPER_MODE, initialMedals:1000,
    allocations:[{id:'fixture_ai', modelHash:'a'.repeat(64), medals:250}],
  }});
  const page = await browser.newPage({viewport:{width:390, height:844}});
  page.setDefaultTimeout(5000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const at = path => server.origin + path;
  async function text(id, value) {
    await page.waitForFunction(([id, value]) => document.getElementById(id).textContent.includes(value), [id, value]);
  }
  async function openAccount(id) {
    const code = server.issueInvite(id).token;
    await page.locator('#invite').fill('  ' + code + '  ');
    const response = page.waitForResponse(res => res.url() === at(redeem));
    await page.locator('#login-button').click();
    const redeemed = await response;
    assert.equal(redeemed.status(), 200, 'Browser invite POST must satisfy exact Origin and media type');
    await text('account-id', id);
    return {Authorization:'Bearer ' + (await redeemed.json()).sessionToken};
  }
  async function submit(id, path, status) {
    const response = page.waitForResponse(res => res.url() === at(path) && res.request().method() === 'POST');
    await page.locator(id).click();
    assert.equal((await response).status(), status);
  }
  await page.goto(at('/friend/'));
  assert.equal(await page.locator('#workspace').isHidden(), true);
  await page.route(at(records), route => route.fulfill({
    contentType:'application/json; charset=utf-8',
    json:{status:'MOCK_NONLIVE', records:[{
      status:'SCORED_MOCK_NONLIVE', sourceMode:'MOCK_NONLIVE', model_version:'appearance-v1_0_0_0_100_35',
      aiId:'fixture_ai', symbol:'TEST', confirmedAt:'2030-01-07T01:00:00.000Z', targetAt:'2030-01-07T01:10:00.000Z',
      direction:'UP', predictedChangePct:4.5, open:{status:'OPENED', at:'2030-01-07T01:05:00.000Z'},
      close:{status:'CLOSED', at:'2030-01-07T01:10:00.000Z'}, realizedPnl:-50,
      score:{brier:1.46, directionCorrect:false, actualDirection:'DOWN',
        absoluteChangeErrorPctPoints:54.5, scoredAt:'2030-01-07T01:10:01.000Z'},
      fx:{rawPnl:-50, basisPoints:10200, gamePnl:-51, commitment:'b'.repeat(64)},
    }]},
  }), {times:1});
  await openAccount(ids[0]);
  await text('wallet', '未配分 750 枚 ／ 初期 1,000 枚');
  await text('forecast', '採点済み');
  await text('frozen-version', 'appearance-v1_0_0_0_100_35');
  await text('record-symbol', 'TEST');
  await text('record-change', '+4.5%');
  await text('raw-pnl', '-50 枚');
  await text('fx-rate', '1.02 倍');
  await text('fx-pnl', '-51 枚');
  assert.equal(await page.locator('#fx-note').isVisible(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('#companion-name').fill(companion.name);
  await page.locator('#hair-color').fill(companion.hair_color);
  await page.locator('#clothing-color').fill(companion.clothing_color);
  await page.locator('#approach').selectOption(companion.approach);
  await page.locator('#risk').fill(String(companion.risk_percent));
  await text('companion-dirty', '未保存の変更あり');
  assert.equal(await page.locator('#look-dirty').textContent(), '');
  await page.locator('#hair-style').selectOption(look.hair_style);
  await page.locator('#expression').selectOption(look.expression);
  await page.locator('#accessory').selectOption(look.accessory);
  await text('preview-name', companion.name);
  assert.equal(await page.locator('[data-hair-color]').first().getAttribute('fill'), companion.hair_color);
  assert.equal(await page.locator('[data-clothing-color]').getAttribute('fill'), companion.clothing_color);
  for (const selector of ['[data-hair="twintails"]', '[data-expression="calm"]', '[data-accessory="star"]']) {
    assert.equal(await page.locator(selector).isVisible(), true);
  }
  const saveStarted = Promise.withResolvers();
  const allowSave = Promise.withResolvers();
  await page.route(at(character + '/companion'), async route => {
    saveStarted.resolve();
    await allowSave.promise;
    await route.continue();
  }, {times:1});
  const saveResponse = page.waitForResponse(at(character + '/companion'));
  await page.locator('#save-companion').click();
  try {
    await saveStarted.promise;
    assert.equal(await page.locator('#save-companion').isDisabled(), true);
    assert.equal(await page.locator('#save-look').isDisabled(), true);
    assert.equal(await page.locator('#spinner').isVisible(), true);
  } finally {
    allowSave.resolve();
  }
  assert.equal((await saveResponse).status(), 200);
  await text('message', '相棒と戦略を保存しました');
  assert.equal(await page.locator('#companion-dirty').textContent(), '');
  await text('look-dirty', '未保存の変更あり');
  await text('editable-version', 'companion-v1_0_100_0_0_45');
  await text('frozen-version', 'appearance-v1_0_0_0_100_35');
  assert.equal(await page.locator('#accessory').inputValue(), look.accessory);
  await submit('#save-look', character + '/look', 200);
  await text('message', '外見パーツを保存しました');
  await text('companion-revision', '1');
  await text('look-revision', '1');

  await page.locator('#companion-name').fill('未保存の相棒');
  await page.locator('#accessory').selectOption('none');
  await page.locator('#restore-look').click();
  assert.equal(await page.locator('#accessory').inputValue(), look.accessory);
  assert.equal(await page.locator('[data-accessory="star"]').isVisible(), true);
  assert.equal(await page.locator('#look-dirty').textContent(), '');
  await text('preview-name', '未保存の相棒');
  await page.locator('#logout').click();
  const confirmation = page.locator('#logout-dialog');
  assert.equal(await confirmation.isVisible(), true);
  assert.equal(await confirmation.getByRole('button', {name:'編集を続ける'}).evaluate(button =>
    document.activeElement === button), true);
  await confirmation.getByRole('button', {name:'編集を続ける'}).click();
  assert.equal(await confirmation.isHidden(), true);
  await text('companion-dirty', '未保存の変更あり');
  const navigationWarning = page.waitForEvent('dialog');
  await page.evaluate(() => setTimeout(() => location.reload(), 0));
  const navigationDialog = await navigationWarning;
  assert.equal(navigationDialog.type(), 'beforeunload');
  await navigationDialog.dismiss();
  assert.equal(await page.locator('#companion-name').inputValue(), '未保存の相棒');

  // Revoking the current account makes the subsequent save return a real 401.
  server.revokeAccount(ids[0]);
  await submit('#save-look', character + '/look', 401);
  await text('message', 'セッションが終了しました');
  assert.equal(await page.locator('#account-id').textContent(), '');
  assert.equal(await page.locator('#frozen-version').textContent(), '');
  assert.equal(await page.locator('#fx-pnl').textContent(), '');
  assert.equal(await page.locator('#record-score').isHidden(), true);
  assert.equal(await page.locator('#companion-name').inputValue(), '');
  assert.equal(await page.locator('#companion-dirty').textContent(), '');
  assert.equal(await page.locator('#workspace').isHidden(), true);

  const unavailable = route => route.fulfill({status:503, json:{error:'unavailable'}});
  await page.route(at(character), unavailable, {times:1});
  await page.route(at(records), unavailable, {times:1});
  await page.route(at(summary), unavailable, {times:2});
  await openAccount(ids[1]);
  await text('profile-error', '編集設定を読み込めませんでした');
  await text('wallet', '財布を読み込めませんでした');
  await text('forecast', '予測記録を読み込めませんでした');
  await page.locator('#retry-reads').click();
  await text('message', '取得できない項目があります');
  assert.equal(await page.locator('#profile-error').isHidden(), true);
  await text('forecast', '予測記録は未接続');
  await text('preview-name', '私の相棒');
  await page.locator('#companion-name').fill('そのままの下書き');
  const retried = [];
  const captureRead = request => {
    if (request.method() === 'GET') retried.push(new URL(request.url()).pathname);
  };
  page.on('request', captureRead);
  await page.locator('#retry-reads').click();
  await text('message', '再読み込みしました');
  page.off('request', captureRead);
  assert.deepEqual(retried, [summary]);
  await text('wallet', '財布は未作成');
  assert.equal(await page.locator('#retry-reads').isHidden(), true);
  await text('preview-name', 'そのままの下書き');
  await page.locator('#restore-companion').click();
  await text('preview-name', '私の相棒');
  assert.equal(await page.locator('#companion-dirty').textContent(), '');
  await submit('#logout', logout, 200);
  await text('message', 'ログアウトしました');
  assert.equal(await page.locator('#wallet').textContent(), '');

  const bearer = await openAccount(ids[0]);
  assert.equal(await page.locator('#companion-name').inputValue(), companion.name);
  assert.equal(await page.locator('#accessory').inputValue(), look.accessory);
  const {csrfToken} = (await call(server, session, {headers:bearer})).json();
  const newer = {...look, expression:'determined', accessory:'glasses'};
  const otherSave = await call(server, character + '/look', {
    method:'POST', headers:{...bearer, 'X-CSRF-Token':csrfToken},
    body:{expected_revision:1, look:newer},
  });
  assert.equal(otherSave.status, 200);
  await page.locator('#companion-name').fill('戦略側の下書き');
  await page.locator('#accessory').selectOption('none');
  await page.route(at(character), unavailable, {times:1});
  await submit('#save-look', character + '/look', 409);
  await text('message', '入力を保持しました');
  assert.equal(await page.locator('#accessory').inputValue(), 'none');
  await submit('#save-look', character + '/look', 409);
  await text('message', '最新の保存内容を表示しました');
  assert.equal(await page.locator('#accessory').inputValue(), newer.accessory);
  await text('look-revision', '2');
  assert.equal(await page.locator('#companion-name').inputValue(), '戦略側の下書き');
  await text('companion-dirty', '未保存の変更あり');
  await text('look-dirty', '未保存の下書きあり');
  assert.equal(await page.locator('#save-look').isDisabled(), true);
  await submit('#save-companion', character + '/companion', 200);
  await text('message', '相棒と戦略を保存しました');
  await text('look-dirty', '未保存の下書きあり');
  await page.locator('#reapply-look').click();
  await text('look-dirty', '未保存の変更あり');
  assert.equal(await page.locator('#accessory').inputValue(), 'none');
  assert.equal(await page.locator('#expression').inputValue(), newer.expression);
  assert.equal((await call(server, character, {headers:bearer})).json().looks.accessory, newer.accessory);
  await submit('#save-look', character + '/look', 200);
  await text('look-revision', '3');
  assert.equal(await page.locator('#companion-name').inputValue(), '戦略側の下書き');
  await page.locator('#companion-name').fill('破棄する下書き');
  await page.route(at(logout), route => route.fulfill({status:503, json:{error:'unavailable'}}), {times:1});
  await page.locator('#logout').click();
  await submit('#discard-logout', logout, 503);
  await text('message', 'サーバーへの通知は確認できませんでした');
  assert.equal(await page.locator('#workspace').isHidden(), true);
  assert.equal(await page.locator('#companion-name').inputValue(), '');

  const waiting = Promise.withResolvers();
  const release = Promise.withResolvers();
  const oldProfileReleased = Promise.withResolvers();
  await page.route(at(character), async route => {
    const oldProfile = await route.fetch();
    waiting.resolve();
    await release.promise;
    await route.fulfill({response:oldProfile}).catch(() => {});
    oldProfileReleased.resolve();
  }, {times:1});
  await page.route(at(summary), async route => {
    await waiting.promise;
    await route.fulfill({status:401, json:{error:'authentication_required'}});
  }, {times:1});
  try {
    await page.locator('#invite').fill(server.issueInvite(ids[0]).token);
    await page.locator('#login-button').click();
    await text('message', 'セッションが終了しました');
    assert.equal(await page.locator('#account-id').textContent(), '');
    assert.equal(await page.locator('#workspace').isHidden(), true);
    await openAccount(ids[1]);
  } finally {
    release.resolve();
  }
  // The delayed A response is released while B is active.
  await oldProfileReleased.promise;
  await text('preview-name', '私の相棒');
  await text('wallet', '財布は未作成');
  assert.equal(await page.locator('#account-id').textContent(), ids[1]);
  assert.equal(await page.locator('#companion-name').inputValue(), '私の相棒');

  const cleanDialogs = [];
  page.on('dialog', async dialog => {
    cleanDialogs.push(dialog.type());
    await dialog.accept();
  });
  await page.reload();
  assert.deepEqual(cleanDialogs, []);
  assert.equal(await page.locator('#workspace').isHidden(), true);
  await page.route(at(records), unavailable, {times:1});
  await openAccount(ids[0]);
  await page.locator('#companion-name').fill('失効時の下書き');
  server.revokeAccount(ids[0]);
  await page.locator('#retry-reads').click();
  await text('message', 'セッションが終了しました');
  assert.equal(await page.locator('#companion-name').inputValue(), '');
  assert.equal(await page.locator('#companion-dirty').textContent(), '');
  assert.equal(await page.locator('#retry-reads').isHidden(), true);
  await page.reload();
  assert.deepEqual(cleanDialogs, []);

  assert.deepEqual(await page.evaluate(() => ({
    cookies:document.cookie, session:sessionStorage.length, local:localStorage.length, url:location.href,
  })), {cookies:'', session:0, local:0, url:at('/friend/')});
  assert.deepEqual(pageErrors, []);
});

test('P9j Chromium reads a verified P4 record as it moves from pending to scored', {timeout:35_000}, async t => {
  const browser = await openChromium(t);
  if (!browser) return;
  let round;
  const {server, ids} = await setup(t, async accounts => {
    const [id] = accounts.keys();
    round = await provisionFriendMockRound(accounts.get(id), {
      companion, pending:true, predictedChangePct:-4,
    });
    return new Map([[id, round.config]]);
  });
  const page = await browser.newPage({viewport:{width:1280, height:900}});
  page.setDefaultTimeout(5000);
  const at = path => server.origin + path;
  const node = id => page.locator('#' + id);
  async function text(id, expected) {
    await page.waitForFunction(([id, expected]) =>
      document.getElementById(id).textContent.includes(expected), [id, expected]);
  }
  async function openAccount(id) {
    await node('invite').fill(server.issueInvite(id).token);
    await node('login-button').click();
    await text('account-id', id);
  }
  async function refresh() {
    await node('refresh-mock').click();
    await text('message', '模擬記録を再取得しました');
  }
  async function fitsViewport() {
    return page.evaluate(() => {
      const panel = document.getElementById('mock-record');
      return document.documentElement.scrollWidth <= innerWidth && panel.scrollWidth <= panel.clientWidth;
    });
  }

  await page.goto(at('/friend/'));
  await openAccount(ids[0]);
  await text('prediction-step', 'FAKE · 確定済み');
  await text('result-step', '採点待ち');
  await text('record-confirmed', '2030/01/07 10:00:00');
  await text('record-target', '2030/01/07 10:10:00');
  await text('record-direction', 'DOWN');
  await text('record-change', '-4%');
  await text('frozen-version', 'companion-v1_0_100_0_0_45');
  assert.equal(await node('record-pending').isVisible(), true);
  assert.equal(await node('record-score').isHidden(), true);
  assert.equal(await node('record-pnl').isHidden(), true);
  assert.equal(await node('preview-comment').isHidden(), true);
  assert.equal(await node('avatar').getAttribute('data-mood'), null);

  const literalName = '<b>ミント</b>';
  await node('companion-name').fill(literalName);
  await node('approach').selectOption('trend');
  await node('risk').fill('45');
  await node('save-companion').click();
  await text('message', '相棒と戦略を保存しました');
  await text('editable-version', 'companion-v1_100_0_0_0_45');
  assert.equal(await node('saved-companion').textContent(), '保存済み · ' + literalName);
  assert.equal(await node('saved-companion').locator('b').count(), 0);
  assert.equal(await node('preview-name').locator('b').count(), 0);
  await node('companion-name').fill('編集中の相棒');
  await node('accessory').selectOption('glasses');

  await round.finish();
  const refreshedRequests = [];
  const capture = req => refreshedRequests.push([req.method(), new URL(req.url()).pathname]);
  page.on('request', capture);
  await refresh();
  page.off('request', capture);
  assert.deepEqual(refreshedRequests.sort((a, b) => a[1].localeCompare(b[1])), [['GET', records], ['GET', summary]]);
  await text('result-step', '採点済み');
  await text('score-direction', 'UP');
  await text('score-correct', '不的中');
  await text('score-brier', '1.46');
  await text('score-error', '12 ポイント');
  await text('score-time', '2030/01/07 10:10:00');
  await text('raw-pnl', '-8 枚');
  assert.equal(await node('fx-rate-row').isHidden(), true);
  assert.equal(await node('fx-note').isHidden(), true);
  assert.equal(await node('record-pending').isHidden(), true);
  assert.equal(await node('preview-reaction').textContent(), '');
  assert.equal(await node('avatar').getAttribute('data-mood'), null);
  await text('frozen-version', 'companion-v1_0_100_0_0_45');
  await text('editable-version', 'companion-v1_100_0_0_0_45');
  assert.equal(await node('companion-name').inputValue(), '編集中の相棒');
  assert.equal(await node('accessory').inputValue(), 'glasses');
  await text('companion-dirty', '未保存の変更あり');
  await text('look-dirty', '未保存の変更あり');
  assert.equal(await fitsViewport(), true);
  await page.setViewportSize({width:390, height:844});
  assert.equal(await fitsViewport(), true);

  // A malformed response must hide all prior details, and a later GET can recover.
  await page.route(at(records), async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.records[0].symbol = '<b>偽</b>';
    await route.fulfill({response, json:data});
  }, {times:1});
  await node('refresh-mock').click();
  await text('forecast', '予測記録を読み込めませんでした');
  assert.equal(await node('mock-record').isHidden(), true);
  assert.equal(await node('record-symbol').textContent(), '');
  assert.equal(await node('score-brier').textContent(), '');
  assert.equal(await node('raw-pnl').textContent(), '');
  await refresh();
  await text('record-symbol', 'FAKE');
  assert.equal(await node('retry-reads').isHidden(), true);
  assert.equal(await node('companion-name').inputValue(), '編集中の相棒');
  assert.equal(await node('accessory').inputValue(), 'glasses');

  server.revokeAccount(ids[0]);
  await node('refresh-mock').click();
  await text('message', 'セッションが終了しました');
  assert.equal(await node('mock-record').isHidden(), true);
  for (const id of ['account-id', 'saved-companion', 'editable-version', 'frozen-version',
    'record-symbol', 'score-direction', 'score-brier', 'raw-pnl', 'prediction-step', 'result-step']) {
    assert.equal(await node(id).textContent(), '', id);
  }
  assert.equal(await node('companion-name').inputValue(), '');
  await openAccount(ids[1]);
  await text('forecast', '予測記録は未接続です。');
  await text('prediction-step', '未接続 · 準備中');
  await text('result-step', 'まだ記録なし');
  assert.equal(await node('mock-unconnected').isVisible(), true);
  assert.equal(await node('mock-record').isHidden(), true);
  assert.equal(await node('frozen-version').textContent(), '');
  await text('wallet', '財布は未作成です。');
  assert.equal(await round.state.reads, 2);
});

test('P9k Chromium starts and reveals a private practice round without losing drafts', {timeout:35_000}, async t => {
  const browser = await openChromium(t);
  if (!browser) return;
  const {server, ids} = await setup(t, undefined, ([id]) => [friendPracticeScenario(id)]);
  const page = await browser.newPage({viewport:{width:390, height:844}});
  page.setDefaultTimeout(5000);
  const at = path => server.origin + path;
  const node = id => page.locator('#' + id);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  async function text(id, expected) {
    await page.waitForFunction(([id, expected]) =>
      document.getElementById(id).textContent.includes(expected), [id, expected]);
  }
  async function submit(id, path, expected) {
    const pending = page.waitForResponse(res => res.request().method() === 'POST' && res.url() === at(path));
    await node(id).click();
    const response = await pending;
    assert.equal(response.status(), expected);
    return expected === 200 ? response.json() : undefined;
  }
  async function openAccount(id) {
    await node('invite').fill(server.issueInvite(id).token);
    const {sessionToken} = await submit('login-button', redeem, 200);
    await text('account-id', id);
    return {Authorization:'Bearer ' + sessionToken};
  }
  async function fitsViewport() {
    return page.evaluate(() => {
      const card = document.querySelector('.practice');
      return document.documentElement.scrollWidth <= innerWidth && card.scrollWidth <= card.clientWidth;
    });
  }

  await page.goto(at('/friend/'));
  const bearer = await openAccount(ids[0]);
  await text('practice-status', '1ラウンド練習できます');
  assert.equal(await node('practice-start').isDisabled(), true);
  assert.equal(await node('practice-reveal').isHidden(), true);
  await node('companion-name').fill(companion.name);
  await node('approach').selectOption(companion.approach);
  await node('risk').fill('45');
  await node('accessory').selectOption('star');
  await submit('save-companion', character + '/companion', 200);
  await text('companion-revision', '1');
  assert.equal(await node('practice-start').isDisabled(), true);
  await text('practice-requirement', '未保存の変更を解消');
  await node('restore-look').click();
  assert.equal(await node('practice-start').isEnabled(), true);

  const {csrfToken} = (await call(server, session, {headers:bearer})).json();
  const external = await call(server, character + '/companion', {
    method:'POST', headers:{...bearer, 'X-CSRF-Token':csrfToken},
    body:{expected_revision:1, companion:{...companion, risk_percent:50}},
  });
  assert.equal(external.status, 200);
  await submit('practice-start', '/friend/practice/start', 409);
  await text('message', '保存版を確認し直しました');
  assert.equal(await node('risk').inputValue(), '50');
  const frozen = await submit('practice-start', '/friend/practice/start', 200);
  assert.equal(frozen.companion_revision, 2);
  await text('practice-status', '予測を確定しました');
  await text('practice-model', 'companion-v1_0_100_0_0_50');
  await text('practice-risk', '50%');
  await text('practice-probabilities', 'UP');
  assert.equal(await node('practice-result').isHidden(), true);
  assert.equal(await node('practice-target-price').textContent(), '');
  assert.equal(await fitsViewport(), true);

  await page.reload();
  assert.equal(await node('workspace').isHidden(), true);
  assert.equal(await node('practice-model').textContent(), '');
  await openAccount(ids[0]);
  await text('practice-status', '予測を確定しました');
  await node('companion-name').fill('そのままの下書き');
  const revealed = await submit('practice-reveal', '/friend/practice/reveal', 200);
  assert.equal(revealed.round_id, frozen.round_id);
  await text('practice-status', '1ラウンドは終了');
  await text('practice-target-price', '129');
  await text('practice-actual', 'UP');
  await text('practice-brier', String(new Intl.NumberFormat('ja-JP', {maximumFractionDigits:6}).format(revealed.result.brier)));
  assert.equal(await node('practice-start').isHidden(), true);
  assert.equal(await node('practice-reveal').isHidden(), true);
  assert.equal(await node('companion-name').inputValue(), 'そのままの下書き');
  await text('companion-dirty', '未保存の変更あり');
  assert.equal(await fitsViewport(), true);
  await page.setViewportSize({width:1280, height:900});
  assert.equal(await fitsViewport(), true);

  await node('logout').click();
  await node('logout-dialog').getByRole('button', {name:'編集を続ける'}).click();
  await text('practice-target-price', '129');
  await node('logout').click();
  await submit('discard-logout', logout, 200);
  await text('message', 'ログアウトしました');
  assert.equal(await node('practice-target-price').textContent(), '');
  assert.equal(await node('companion-name').inputValue(), '');
  await openAccount(ids[1]);
  await text('practice-status', '架空練習は未接続');
  assert.equal(await node('practice-prediction').isHidden(), true);
  assert.equal(await node('practice-result').isHidden(), true);
  assert.equal(await node('practice-probabilities').textContent(), '');
  await submit('logout', logout, 200);

  await openAccount(ids[0]);
  await text('practice-status', '1ラウンドは終了');
  await text('practice-target-price', '129');
  server.revokeAccount(ids[0]);
  await node('practice-refresh').click();
  await text('message', 'セッションが終了しました');
  for (const id of ['practice-model', 'practice-probabilities', 'practice-target-price', 'practice-brier', 'practice-status']) {
    assert.equal(await node(id).textContent(), '', id);
  }
  assert.equal(await node('workspace').isHidden(), true);
  assert.deepEqual(errors, []);
});

test('P9l Chromium completes three explicit rounds and clears campaign details on account changes', {timeout:35_000}, async t => {
  const browser = await openChromium(t);
  if (!browser) return;
  const {server, ids} = await setup(t, undefined, ([id]) => [friendPracticeCampaign(id, [129, 112, 120])]);
  const page = await browser.newPage({viewport:{width:380, height:844}});
  page.setDefaultTimeout(5000);
  const node = id => page.locator('#' + id);
  const at = path => server.origin + path;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  async function text(id, expected) {
    await page.waitForFunction(([id, expected]) =>
      document.getElementById(id).textContent.includes(expected), [id, expected]);
  }
  async function submit(id, path, expected = 200) {
    const pending = page.waitForResponse(res => res.request().method() === 'POST' && res.url() === at(path));
    await node(id).click();
    const response = await pending;
    assert.equal(response.status(), expected);
    return response;
  }
  async function openAccount(id) {
    await node('invite').fill(server.issueInvite(id).token);
    const response = await submit('login-button', redeem);
    await text('account-id', id);
    return {Authorization:'Bearer ' + (await response.json()).sessionToken};
  }
  async function freezeRound(index) {
    await submit('practice-start', '/friend/practice/start');
    await text('practice-status', '予測を確定しました');
    await text('practice-round-number', '第' + index + '/3ラウンド');
    assert.equal(await node('practice-start').isHidden(), true);
    assert.equal(await node('practice-target-price').textContent(), '');
    assert.equal(await node('practice-result').isHidden(), true);
    assert.equal(await node('practice-history').locator('li').count(), index - 1);
  }
  async function revealRound(index, price) {
    await submit('practice-reveal', '/friend/practice/reveal');
    await text('practice-target-price', String(price));
    await text('practice-stats', '採点済み ' + index + '/3');
    assert.equal(await node('practice-history').locator('li').count(), index);
    assert.equal(await node('practice-reveal').isHidden(), true);
  }
  async function cleared() {
    for (const id of ['practice-round-number', 'practice-stats', 'practice-model', 'practice-target-price', 'practice-history']) {
      assert.equal(await node(id).textContent(), '', id);
    }
    assert.equal(await node('practice-history').locator('li').count(), 0);
    assert.equal(await node('practice-history-panel').isHidden(), true);
  }

  await page.goto(at('/friend/'));
  const bearer = await openAccount(ids[0]);
  await text('practice-round-number', '第1/3ラウンド');
  await text('practice-stats', '平均 Brier —');
  await text('practice-stats', '判定なし');
  assert.equal(await node('practice-start').isDisabled(), true);
  await node('companion-name').fill(companion.name);
  await node('approach').selectOption('momentum');
  await submit('save-companion', character + '/companion');
  await freezeRound(1);
  await text('practice-model', 'companion-v1_0_100_0_0_35');
  await revealRound(1, 129);
  await text('practice-start', '次の練習へ');
  assert.equal(await node('practice-start').evaluate(button => document.activeElement === button), true);
  await node('accessory').selectOption('glasses');
  assert.equal(await node('practice-start').isDisabled(), true);
  await text('practice-requirement', '未保存の変更を解消');
  await node('restore-look').click();
  assert.equal(await node('practice-start').isEnabled(), true);

  const {csrfToken} = (await call(server, session, {headers:bearer})).json();
  const changed = await call(server, character + '/companion', {
    method:'POST', headers:{...bearer, 'X-CSRF-Token':csrfToken},
    body:{expected_revision:1, companion:{...companion, approach:'trend', risk_percent:60}},
  });
  assert.equal(changed.status, 200);
  await page.route(at(character), route => route.fulfill({status:503, json:{error:'unavailable'}}), {times:1});
  await submit('practice-start', '/friend/practice/start', 409);
  await text('message', '保存版を読み込めませんでした。入力は保持しています。');
  assert.equal(await node('risk').inputValue(), '35');
  assert.equal(await node('practice-start').isDisabled(), true);
  await text('practice-target-price', '129');
  await node('retry-reads').click();
  await text('message', '再読み込みしました。');
  assert.equal(await node('risk').inputValue(), '60');
  await freezeRound(2);
  await text('practice-model', 'companion-v1_100_0_0_0_60');
  await text('practice-history', 'companion-v1_0_100_0_0_35');

  await page.reload();
  await cleared();
  await openAccount(ids[0]);
  await text('practice-round-number', '第2/3ラウンド');
  assert.equal(await node('practice-reveal').isVisible(), true);
  assert.equal(await node('practice-target-price').textContent(), '');
  await node('accessory').selectOption('star');
  await revealRound(2, 112);
  assert.equal(await node('practice-start').isDisabled(), true);
  assert.equal(await node('practice-refresh').evaluate(button => document.activeElement === button), true);
  await node('restore-look').click();
  await freezeRound(3);
  await revealRound(3, 120);
  await text('practice-status', '完走しました');
  assert.equal(await node('practice-start').isHidden(), true);
  for (const width of [380,390,1280]) {
    await page.setViewportSize({width,height:900});
    assert.equal(await page.evaluate(() => {
      const history = document.getElementById('practice-history');
      return document.documentElement.scrollWidth <= innerWidth && history.scrollWidth <= history.clientWidth;
    }), true, String(width));
  }

  await submit('logout', logout);
  await cleared();
  await openAccount(ids[1]);
  await text('practice-status', '架空練習は未接続');
  await cleared();
  await submit('logout', logout);
  await openAccount(ids[0]);
  await text('practice-status', '完走しました');
  assert.equal(await node('practice-history').locator('li').count(), 3);
  server.revokeAccount(ids[0]);
  await node('practice-refresh').click();
  await text('message', 'セッションが終了しました');
  await cleared();
  assert.deepEqual(errors, []);
});

test('P9m Chromium reacts to live practice transitions without changing looks or replaying motion', {timeout:35_000}, async t => {
  const browser = await openChromium(t);
  if (!browser) return;
  const {server, ids} = await setup(t, undefined, ([id]) => {
    const campaign = friendPracticeCampaign(id, [129, 112, 78, 129, 133]);
    const tie = campaign.rounds[2];
    tie.history = tie.history.map((point, index) => ({...point, price:index === 11 ? 64.1 : 100}));
    return [campaign];
  });
  const page = await browser.newPage({viewport:{width:380,height:844}, reducedMotion:'no-preference'});
  page.setDefaultTimeout(5000);
  const node = id => page.locator('#' + id);
  const at = path => server.origin + path;
  const lines = {
    focused:'予測を確定したよ。結果はまだ分からないね。',
    pleased:'やった！ 今回の方向は的中したよ。',
    disappointed:'今回は外れたね。次はどうなるかな？',
    neutral:'今回は方向を判定できなかったよ。',
  };
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  async function text(id, expected) {
    await page.waitForFunction(([id, expected]) =>
      document.getElementById(id).textContent.includes(expected), [id, expected]);
  }
  async function submit(id, path, expected = 200) {
    const pending = page.waitForResponse(res => res.request().method() === 'POST' && res.url() === at(path));
    await node(id).click();
    const response = await pending;
    assert.equal(response.status(), expected);
    return response;
  }
  async function openAccount(id) {
    await node('invite').fill(server.issueInvite(id).token);
    const response = await submit('login-button', redeem);
    await text('account-id', id);
    return {Authorization:'Bearer ' + (await response.json()).sessionToken};
  }
  async function face(expression) {
    assert.equal(await node('avatar').locator('.face.selected').getAttribute('data-expression'), expression);
  }
  async function reaction(mood, expression) {
    await text('preview-reaction', lines[mood]);
    await face(expression);
    assert.equal(await node('avatar').getAttribute('data-mood'), mood);
    assert.equal(await node('preview-comment').isVisible(), true);
  }
  async function clearReaction() {
    assert.equal(await node('preview-reaction').textContent(), '');
    assert.equal(await node('preview-comment').isHidden(), true);
    for (const attr of ['data-mood', 'data-motion']) assert.equal(await node('avatar').getAttribute(attr), null);
  }
  async function assertStatic() {
    assert.equal(await node('avatar').getAttribute('data-motion'), null);
    assert.equal(await node('avatar').locator('.chibi').evaluate(chibi => getComputedStyle(chibi).animationName), 'none');
  }
  async function motionEvents(expected) {
    if (expected.length) {
      await page.waitForFunction(count => window.practiceMotions.length >= count, expected.length);
    }
    await page.waitForFunction(() => !document.getElementById('avatar').hasAttribute('data-motion'));
    assert.deepEqual(await page.evaluate(() => window.practiceMotions), expected);
  }
  async function freeze() {
    await submit('practice-start', '/friend/practice/start');
    await reaction('focused', 'determined');
    await assertStatic();
  }
  async function reveal(mood, expression) {
    await submit('practice-reveal', '/friend/practice/reveal');
    await reaction(mood, expression);
  }

  await page.goto(at('/friend/'));
  await page.evaluate(() => {
    window.practiceMotions = [];
    document.getElementById('avatar').addEventListener('animationstart', event => {
      if (event.animationName.startsWith('practice-')) window.practiceMotions.push(event.animationName);
    });
  });
  let bearer = await openAccount(ids[0]);
  await face('cheerful');
  await clearReaction();
  await submit('save-companion', character + '/companion');
  await freeze();
  assert.equal(await node('expression').inputValue(), 'cheerful');
  await node('expression').selectOption('calm');
  await node('hair-style').selectOption('long');
  await node('accessory').selectOption('star');
  await node('hair-color').fill('#123456');
  await node('clothing-color').fill('#654321');
  await reaction('focused', 'calm');
  await reveal('pleased', 'calm');
  assert.equal(await node('expression').inputValue(), 'calm');
  assert.equal(await node('hair-style').inputValue(), 'long');
  assert.equal(await node('accessory').inputValue(), 'star');
  assert.equal(await node('avatar').locator('[data-hair="long"]').isVisible(), true);
  assert.equal(await node('avatar').locator('[data-accessory="star"]').isVisible(), true);
  assert.equal(await node('avatar').locator('[data-hair-color]').first().getAttribute('fill'), '#123456');
  assert.equal(await node('avatar').locator('[data-clothing-color]').getAttribute('fill'), '#654321');
  await text('look-revision', '0');
  await text('look-dirty', '未保存の変更あり');
  for (const width of [375,380,390,1280]) {
    await page.setViewportSize({width,height:900});
    assert.equal(await node('preview-comment').evaluate(comment => {
      const card = document.getElementById('preview');
      return comment.scrollWidth <= comment.clientWidth && card.scrollWidth <= card.clientWidth &&
        document.documentElement.scrollWidth <= innerWidth &&
        (innerWidth > 624 || getComputedStyle(comment).gridColumnEnd === '-1');
    }), true, String(width));
  }
  await motionEvents(['practice-cheer']);
  const navigation = page.waitForEvent('dialog');
  await page.evaluate(() => setTimeout(() => location.reload(), 0));
  const warning = await navigation;
  assert.equal(warning.type(), 'beforeunload');
  await warning.dismiss();
  for (let i = 0; i < 2; i++) {
    await node('practice-refresh').click();
    await text('message', '練習状態を再取得しました。');
    await reaction('pleased', 'calm');
    await assertStatic();
  }
  await motionEvents(['practice-cheer']);

  // Preserve the existing two-step 409 flow while the practice reaction is active.
  const {csrfToken} = (await call(server, session, {headers:bearer})).json();
  const concurrentLook = {hair_style:'bob', expression:'determined', accessory:'glasses'};
  const other = await call(server, character + '/look', {
    method:'POST', headers:{...bearer, 'X-CSRF-Token':csrfToken},
    body:{expected_revision:0, look:concurrentLook},
  });
  assert.equal(other.status, 200);
  await submit('save-look', character + '/look', 409);
  await text('look-dirty', '未保存の下書きあり');
  await reaction('pleased', 'determined');
  await node('reapply-look').click();
  await reaction('pleased', 'calm');
  await node('restore-look').click();
  await node('restore-companion').click();
  await reaction('pleased', 'cheerful');
  assert.equal(await node('expression').inputValue(), 'determined');
  await text('look-revision', '1');

  await submit('logout', logout);
  await clearReaction();
  bearer = await openAccount(ids[0]);
  await reaction('pleased', 'cheerful');
  await assertStatic();
  await motionEvents(['practice-cheer']);
  await freeze();
  await reveal('disappointed', 'sad');
  await motionEvents(['practice-cheer', 'practice-dip']);
  assert.equal(await node('expression').inputValue(), 'determined');

  await node('approach').selectOption('volatility');
  await submit('save-companion', character + '/companion');
  await freeze();
  await reveal('neutral', 'calm');
  await assertStatic();
  await motionEvents(['practice-cheer', 'practice-dip']);

  await page.emulateMedia({reducedMotion:'reduce'});
  await node('approach').selectOption('trend');
  await submit('save-companion', character + '/companion');
  await freeze();
  await reveal('pleased', 'cheerful');
  await assertStatic();
  await motionEvents(['practice-cheer', 'practice-dip']);
  await page.emulateMedia({reducedMotion:'no-preference'});
  await assertStatic();

  // A reveal performed elsewhere leaves this tab frozen until it reads the
  // published state. Clicking here restores that result and sends no new POST.
  await freeze();
  const current = (await call(server, '/friend/practice', {headers:bearer})).json();
  const info = (await call(server, session, {headers:bearer})).json();
  const published = await call(server, '/friend/practice/reveal', {
    method:'POST', headers:{...bearer, 'X-CSRF-Token':info.csrfToken}, body:{round_id:current.round_id},
  });
  assert.equal(published.status, 200);
  const attempts = [];
  const capture = req => attempts.push([req.method(), new URL(req.url()).pathname]);
  page.on('request', capture);
  await node('practice-reveal').click();
  await text('message', '公開済みの結果を表示しました。');
  page.off('request', capture);
  assert.deepEqual(attempts.filter(([, path]) => path.startsWith('/friend/practice')), [['GET', '/friend/practice']]);
  await reaction('pleased', 'cheerful');
  await assertStatic();
  await motionEvents(['practice-cheer', 'practice-dip']);

  server.revokeAccount(ids[0]);
  await node('practice-refresh').click();
  await text('message', 'セッションが終了しました。');
  await clearReaction();
  assert.equal(await node('avatar').locator('.face.selected').count(), 0);
  await openAccount(ids[1]);
  await text('practice-status', '架空練習は未接続です。');
  await clearReaction();
  await face('cheerful');
  assert.deepEqual(errors, []);
});
