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

const character = '/friend/character';
const summary = '/friend/forward/summary';
const records = '/friend/forward/records';
const redeem = '/friend/invite/redeem';
const session = '/friend/session';
const logout = '/friend/logout';

async function setup(t) {
  const walletRoot = await mkdtemp(join(tmpdir(), 'p9h-friends-'));
  t.after(() => rm(walletRoot, {recursive:true, force:true}));
  const ids = ['AliceFixture', 'BobFixture'];
  const accounts = new Map();
  for (const id of ids) {
    const folder = join(walletRoot, id);
    await mkdir(folder, {mode:0o700});
    accounts.set(id, join(folder, 'wallet.json'));
  }
  const server = await startFriendMockServer({walletRoot, accounts});
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

test('P9h isolated Chromium browser smoke', {timeout:35_000}, async t => {
  let playwright;
  try {
    playwright = await import(process.env.FRIEND_UI_PLAYWRIGHT ?? 'playwright');
  } catch (error) {
    if (!process.env.FRIEND_UI_PLAYWRIGHT && error.code === 'ERR_MODULE_NOT_FOUND') {
      return t.skip('Playwright is optional. Set FRIEND_UI_PLAYWRIGHT to its installed module path.');
    }
    throw error;
  }
  const {server, ids, accounts} = await setup(t);
  const browser = await playwright.chromium.launch({
    executablePath:process.env.FRIEND_UI_CHROME,
    args:['--host-resolver-rules=MAP friend.localhost 127.0.0.1', '--no-proxy-server'],
  });
  t.after(() => browser.close());
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
    await page.locator('#invite').fill(code);
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
    }]},
  }), {times:1});
  await openAccount(ids[0]);
  await text('wallet', '未配分 750 枚 ／ 初期 1,000 枚');
  await text('forecast', '採点済み');
  await text('frozen-version', 'appearance-v1_0_0_0_100_35');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('#companion-name').fill(companion.name);
  await page.locator('#hair-color').fill(companion.hair_color);
  await page.locator('#clothing-color').fill(companion.clothing_color);
  await page.locator('#approach').selectOption(companion.approach);
  await page.locator('#risk').fill(String(companion.risk_percent));
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
  await text('editable-version', 'companion-v1_0_100_0_0_45');
  await text('frozen-version', 'appearance-v1_0_0_0_100_35');
  assert.equal(await page.locator('#accessory').inputValue(), look.accessory);
  await submit('#save-look', character + '/look', 200);
  await text('message', '外見パーツを保存しました');
  await text('companion-revision', '1');
  await text('look-revision', '1');

  // Revoking the current account makes the subsequent save return a real 401.
  server.revokeAccount(ids[0]);
  await submit('#save-look', character + '/look', 401);
  await text('message', 'セッションが終了しました');
  assert.equal(await page.locator('#account-id').textContent(), '');
  assert.equal(await page.locator('#frozen-version').textContent(), '');
  assert.equal(await page.locator('#companion-name').inputValue(), '');
  assert.equal(await page.locator('#workspace').isHidden(), true);

  await page.route(at(summary), route => route.fulfill({status:503, json:{error:'unavailable'}}), {times:1});
  await openAccount(ids[1]);
  await text('wallet', '財布を読み込めませんでした');
  await text('forecast', '予測記録は未接続');
  await text('preview-name', '私の相棒');
  assert.equal(await page.locator('#companion-name').inputValue(), '私の相棒');
  await submit('#logout', logout, 200);
  await text('message', 'ログアウトしました');
  assert.equal(await page.locator('#wallet').textContent(), '');

  const bearer = await openAccount(ids[0]);
  assert.equal(await page.locator('#companion-name').inputValue(), companion.name);
  assert.equal(await page.locator('#accessory').inputValue(), look.accessory);
  const {csrfToken} = (await call(server, session, {headers:bearer})).json();
  const newer = {...look, accessory:'glasses'};
  const otherSave = await call(server, character + '/look', {
    method:'POST', headers:{...bearer, 'X-CSRF-Token':csrfToken},
    body:{expected_revision:1, look:newer},
  });
  assert.equal(otherSave.status, 200);
  await page.locator('#accessory').selectOption('none');
  await submit('#save-look', character + '/look', 409);
  await text('message', '最新の設定を読み込みました');
  assert.equal(await page.locator('#accessory').inputValue(), newer.accessory);
  await text('look-revision', '2');
  await page.locator('#accessory').selectOption('none');
  await submit('#save-look', character + '/look', 200);
  await text('look-revision', '3');
  await page.route(at(logout), route => route.fulfill({status:503, json:{error:'unavailable'}}), {times:1});
  await submit('#logout', logout, 503);
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

  assert.deepEqual(await page.evaluate(() => ({
    cookies:document.cookie, session:sessionStorage.length, local:localStorage.length, url:location.href,
  })), {cookies:'', session:0, local:0, url:at('/friend/')});
  assert.deepEqual(pageErrors, []);
});
