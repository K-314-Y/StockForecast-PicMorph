import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {chmod, link, mkdir, mkdtemp, open, readFile, rename, rm, symlink, unlink, writeFile} from 'node:fs/promises';
import {request} from 'node:http';
import {dirname, join} from 'node:path';
import test from 'node:test';
import {createFriendAuth} from '../../game_runtime/friend-auth.mjs';
import {startFriendMockServer} from '../../game_runtime/friend-mock-server.mjs';
import {createForwardMarketAdapter} from '../../game_runtime/forward-market-adapter.mjs';
import {MOCK_MARKET_PAPER_MODE, MOCK_MARKET_SOURCE} from '../../game_runtime/forward-market-guard.mjs';
import {createGameServer} from '../../game_runtime/server.mjs';
import {deriveForwardCompanionModel} from '../../game_runtime/forward-model.mjs';
import {openForwardMockLifecycle} from '../../game_runtime/forward-mock-lifecycle.mjs';
import {openForwardStore, saveForwardGeneration} from '../../game_runtime/forward-store.mjs';

const redeemPath = '/friend/invite/redeem';
const sessionPath = '/friend/session';
const logoutPath = '/friend/logout';
const summaryPath = '/friend/forward/summary';

function call(server, path, {method = 'GET', headers = {}, body} = {}) {
  const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const requestHeaders = {Host:new URL(server.origin).host, Connection:'close',
    ...(method === 'POST' ? {Origin:server.origin} : {}),
    ...(bytes ? {'Content-Type':'application/json', 'Content-Length':bytes.length} : {}),
    ...headers};
  if (requestHeaders.Origin === null) delete requestHeaders.Origin;
  return new Promise((resolve, reject) => {
    const req = request({hostname:'127.0.0.1', port:server.port, path, method, headers:requestHeaders}, res => {
      res.setEncoding('utf8');
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        try { resolve({status:res.statusCode, headers:res.headers, body:JSON.parse(text), text}); }
        catch (error) { reject(error); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(bytes);
  });
}

async function setup(t) {
  const walletRoot = await mkdtemp('/tmp/p9e-friends-');
  t.after(() => rm(walletRoot, {recursive:true, force:true}));
  const accounts = new Map(['Alice', 'Bob'].map(id => [id, join(walletRoot, id, 'wallet.json')]));
  for (const id of accounts.keys()) await mkdir(join(walletRoot, id), {mode:0o700});
  const state = {now:Date.parse('2030-01-01T00:00:00Z')};
  const config = {walletRoot, accounts, clock:() => state.now};
  async function start(options = {}) {
    const server = await startFriendMockServer({...config, ...options});
    t.after(() => server.close());
    return server;
  }
  const server = await start();
  return {walletRoot, accounts, state, config, server, start};
}

function redeem(server, invite, options = {}) {
  return call(server, redeemPath, {method:'POST', body:{invite}, ...options});
}

async function login(server, accountId) {
  const {token} = server.issueInvite(accountId);
  const res = await redeem(server, token);
  assert.equal(res.status, 200);
  return {sessionToken:res.body.sessionToken, token, res};
}

function authenticated(server, path, sessionToken, options = {}) {
  return call(server, path, {...options, headers:{Authorization:'Bearer ' + sessionToken, ...options.headers}});
}

async function seed(filePath, medals, {mock = true} = {}) {
  const initial = {initialMedals:1000, allocations:[{id:'shared_ai', modelHash:'a'.repeat(64), medals}]};
  if (!mock) return openForwardStore({filePath, initial});
  const marketAdapter = createForwardMarketAdapter({
    sourceId:MOCK_MARKET_SOURCE, licenseRef:'P9e fixture only', observationIntervalMs:60_000,
    maxAgeMs:60_000, maxPublicationDelayMs:1000, verifyUsage:() => true,
    verifyRecord:() => null, marketStatusAt:() => 'HALTED',
    readBatch:() => assert.fail('Summary must not request market data'),
  });
  return openForwardStore({filePath, marketAdapter, initial:{...initial, mode:MOCK_MARKET_PAPER_MODE}});
}

test('P9e unauthenticated session and summary return 401', async t => {
  const {server} = await setup(t);
  for (const path of [sessionPath, summaryPath]) {
    const res = await call(server, path);
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, {error:'authentication_required'});
    assert.equal(res.headers['set-cookie'], undefined);
  }
});

test('P9e redeems one invite once and returns a separate bearer and session CSRF', async t => {
  const {server} = await setup(t);
  const {sessionToken, token, res} = await login(server, 'Alice');
  assert.deepEqual(res.body, {authenticated:true, sessionToken});
  assert.match(sessionToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(res.headers['set-cookie'], undefined);
  const session = await authenticated(server, sessionPath, sessionToken);
  assert.equal(session.status, 200);
  assert.equal(session.body.accountId, 'Alice');
  assert.match(session.body.csrfToken, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!res.text.includes(token) && sessionToken !== token && !session.text.includes(sessionToken));
  assert.equal((await redeem(server, token)).status, 401);
});

test('P9e logout requires matching CSRF and revokes the bearer', async t => {
  const {server} = await setup(t);
  const alice = await login(server, 'Alice');
  const bob = await login(server, 'Bob');
  const {body:{csrfToken:a}} = await authenticated(server, sessionPath, alice.sessionToken);
  const {body:{csrfToken:b}} = await authenticated(server, sessionPath, bob.sessionToken);
  const logout = headers => authenticated(server, logoutPath, alice.sessionToken, {method:'POST', headers});
  assert.equal((await logout({})).status, 403);
  assert.equal((await logout({'X-CSRF-Token':b})).status, 403);
  const res = await logout({'X-CSRF-Token':a});
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {authenticated:false});
  assert.equal(res.headers['set-cookie'], undefined);
  assert.ok(!res.text.includes(alice.sessionToken));
  assert.equal((await logout({'X-CSRF-Token':a})).status, 401);
  assert.equal((await authenticated(server, summaryPath, alice.sessionToken)).status, 401);
  assert.equal((await authenticated(server, sessionPath, bob.sessionToken)).status, 200);
});

test('P9e reads only the authenticated A/B wallets even when their AI IDs match', async t => {
  const {server, accounts} = await setup(t);
  await seed(accounts.get('Alice'), 123);
  await seed(accounts.get('Bob'), 456);
  const alice = await login(server, 'Alice');
  const bob = await login(server, 'Bob');
  const before = await Promise.all([...accounts.values()].map(file => readFile(file)));
  for (const [sessionToken, cash] of [[alice.sessionToken, 123], [bob.sessionToken, 456]]) {
    const res = await authenticated(server, summaryPath, sessionToken);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'MOCK_NONLIVE');
    assert.equal(res.body.summary.mock, true);
    assert.deepEqual(res.body.summary.wallets, {shared_ai:{cash, equity:cash, status:'ACTIVE', position:null}});
    assert.doesNotMatch(res.text, /modelHash|walletFile|local_state|\/tmp\//);
  }
  assert.deepEqual(await Promise.all([...accounts.values()].map(file => readFile(file))), before);
});

test('P9e expires invites after 24h and sessions after 8h, even after a clock rollback', async t => {
  const {server, state} = await setup(t);
  const invite = server.issueInvite('Alice');
  state.now = invite.expiresAt;
  assert.equal((await redeem(server, invite.token)).status, 401);
  const {sessionToken} = await login(server, 'Alice');
  const {body:{expiresAt}} = await authenticated(server, sessionPath, sessionToken);
  assert.equal(expiresAt - state.now, 8 * 60 * 60_000);
  state.now = expiresAt - 1;
  assert.equal((await authenticated(server, sessionPath, sessionToken)).status, 200);
  state.now = expiresAt;
  assert.equal((await authenticated(server, sessionPath, sessionToken)).status, 401);
  state.now -= 1000;
  assert.equal((await authenticated(server, sessionPath, sessionToken)).status, 401);
});

test('P9e denies wrong Host, Origin, site and proxy headers and requires Origin on POST', async t => {
  const {server} = await setup(t);
  const invite = server.issueInvite('Alice');
  for (const headers of [
    {Host:'127.0.0.1:' + server.port}, {Origin:'http://untrusted.localhost:' + server.port},
    {Origin:'null'}, {Origin:null}, {'Sec-Fetch-Site':'cross-site'}, {'Sec-Fetch-Site':'same-site'},
    {'Sec-Fetch-Site':'none'}, {Forwarded:'for=127.0.0.1'}, {'X-Forwarded-Port':server.port}, {Via:'1.1 proxy'},
  ]) {
    assert.equal((await redeem(server, invite.token, {headers})).status, 403, JSON.stringify(headers));
  }
  const ok = await redeem(server, invite.token, {headers:{'Sec-Fetch-Site':'same-origin'}});
  assert.equal(ok.status, 200);
  assert.equal((await call(server, sessionPath, {headers:{Origin:'http://localhost:' + server.port}})).status, 403);
});

test('P9e serves only allowlisted method and path pairs, never the normal game', async t => {
  const {server} = await setup(t);
  const {sessionToken} = await login(server, 'Alice');
  for (const path of ['/', '/game', '/api/growth', '/api/companion', '/api/companion/forward-ai',
    '/api/artwork', '/friend/unknown', '/friend/%73ession', '/friend/session/']) {
    assert.equal((await authenticated(server, path, sessionToken)).status, 404, path);
  }
  assert.equal((await authenticated(server, sessionPath, sessionToken, {method:'POST'})).status, 404);
  assert.equal((await authenticated(server, summaryPath, sessionToken, {method:'OPTIONS'})).status, 404);
  assert.equal((await authenticated(server, logoutPath, sessionToken)).status, 404);
});

test('P9e rejects client-supplied account selectors, forged authorization, cookies, and logout bodies', async t => {
  const {server} = await setup(t);
  const {sessionToken} = await login(server, 'Alice');
  assert.equal((await authenticated(server, summaryPath + '?accountId=Bob&wallet=/tmp/wallet', sessionToken)).status, 400);
  assert.equal((await call(server, redeemPath, {method:'POST', body:{invite:'bogus', accountId:'Bob'}})).status, 400);
  for (const authorization of [
    'Bearer Bob', 'Bearer ' + 'x'.repeat(43), 'Basic ' + sessionToken, 'bearer ' + sessionToken,
    'Bearer  ' + sessionToken, 'Bearer ' + sessionToken + ', Bearer ' + sessionToken,
    ['Bearer ' + sessionToken, 'Bearer ' + sessionToken],
  ]) {
    assert.equal((await call(server, summaryPath, {headers:{Authorization:authorization}})).status, 401);
  }
  assert.equal((await call(server, summaryPath, {headers:{Cookie:'p9e_friend_session=' + sessionToken}})).status, 401);
  const csrf = (await authenticated(server, sessionPath, sessionToken)).body.csrfToken;
  assert.equal((await authenticated(server, logoutPath, sessionToken, {
    method:'POST', headers:{'X-CSRF-Token':csrf}, body:{accountId:'Bob'},
  })).status, 400);
  assert.equal((await authenticated(server, sessionPath, sessionToken)).status, 200);
});

test('P9e disallows caching and CORS and returns the bearer only in the redemption body without cookies', async t => {
  const {server} = await setup(t);
  const {sessionToken, res} = await login(server, 'Alice');
  assert.match(server.origin, /^http:\/\/friend\.localhost:\d+$/);
  for (const result of [res, await authenticated(server, sessionPath, sessionToken),
    await authenticated(server, summaryPath, sessionToken), await call(server, summaryPath)]) {
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal(result.headers['set-cookie'], undefined);
    assert.equal(result.headers.authorization, undefined);
    if (result !== res) assert.ok(!result.text.includes(sessionToken));
    assert.equal(result.headers['access-control-allow-origin'], undefined);
    assert.equal(result.headers['cross-origin-resource-policy'], 'same-origin');
    assert.match(result.headers['content-security-policy'], /default-src 'none'/);
    assert.equal(Number(result.headers['content-length']), Buffer.byteLength(result.text));
  }
});

test('P9e limits invalid attempts while still accepting a valid invitation', async t => {
  const {server, state} = await setup(t);
  const statuses = await Promise.all(Array.from({length:12}, () => redeem(server, 'x'.repeat(43))));
  assert.equal(statuses.filter(item => item.status === 401).length, 8);
  assert.equal(statuses.filter(item => item.status === 429).length, 4);
  const invite = server.issueInvite('Alice');
  const limited = await redeem(server, 'x'.repeat(43));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['retry-after'], '60');
  assert.equal((await call(server, redeemPath, {method:'POST', body:[]})).status, 429);
  assert.equal((await redeem(server, invite.token)).status, 200);
  assert.equal((await redeem(server, invite.token)).status, 429);
  state.now += 60_000;
  assert.equal((await redeem(server, invite.token)).status, 401);
});

test('P9e bounds the redeem body and checks its type before reading credentials', async t => {
  const {server} = await setup(t);
  const {token} = server.issueInvite('Alice');
  assert.equal((await redeem(server, token, {headers:{'Content-Type':'text/plain'}})).status, 415);
  assert.equal((await redeem(server, 'z'.repeat(256))).status, 413);
  assert.equal((await call(server, redeemPath, {method:'POST', body:[]})).status, 400);
  assert.equal((await redeem(server, token)).status, 200);
});

test('P9e re-inviting rotates the old session and restarting invalidates both credentials', async t => {
  const {server, start} = await setup(t);
  const old = await login(server, 'Alice');
  const current = await login(server, 'Alice');
  assert.equal((await authenticated(server, sessionPath, old.sessionToken)).status, 401);
  assert.equal((await authenticated(server, sessionPath, current.sessionToken)).status, 200);
  const pending = server.issueInvite('Bob');
  const restarted = await start();
  assert.equal((await authenticated(restarted, sessionPath, current.sessionToken)).status, 401);
  assert.equal((await redeem(restarted, pending.token)).status, 401);
  server.revokeAccount('Alice');
  assert.equal((await authenticated(server, sessionPath, current.sessionToken)).status, 401);
});

test('P9e missing and non-mock wallets return no other account data', async t => {
  const {server, accounts} = await setup(t);
  await seed(accounts.get('Bob'), 456);
  const {sessionToken} = await login(server, 'Alice');
  const absent = await authenticated(server, summaryPath, sessionToken);
  assert.equal(absent.status, 200);
  assert.deepEqual(absent.body, {status:'uninitialized', summary:null});
  await seed(accounts.get('Alice'), 987, {mock:false});
  const denied = await authenticated(server, summaryPath, sessionToken);
  assert.equal(denied.status, 503);
  assert.deepEqual(denied.body, {error:'unavailable'});
});

test('P9e refuses shared, nested, outside, symlink and hardlinked wallet scopes', async t => {
  const {config, walletRoot, accounts, server} = await setup(t);
  const alice = accounts.get('Alice');
  const bob = accounts.get('Bob');
  const configure = path => startFriendMockServer({...config, accounts:new Map([['Alice', alice], ['Bob', path]])});
  assert.throws(() => createFriendAuth({accountIds:['Alice', 'bad-name']}), /distinct friend account IDs/);
  await assert.rejects(configure(alice), /cannot be shared/);
  await assert.rejects(configure('relative/wallet.json'), /explicit canonical paths/);
  await assert.rejects(configure('/tmp/outside-wallet.json'), /directory under the root/);
  await mkdir(join(walletRoot, 'Alice', 'nested'), {mode:0o700});
  await assert.rejects(configure(join(walletRoot, 'Alice', 'nested', 'wallet.json')), /cannot be shared, nested/);
  await symlink(join(walletRoot, 'Alice'), join(walletRoot, 'alias'));
  await assert.rejects(configure(join(walletRoot, 'alias', 'wallet.json')), /real, server-owned/);
  await seed(alice, 101);
  await link(alice, bob);
  await assert.rejects(configure(bob), /Invalid friend wallet file/);
  const {sessionToken} = await login(server, 'Bob');
  assert.equal((await authenticated(server, summaryPath, sessionToken)).status, 503);
});

test('P9e fails closed when a configured account directory is replaced after startup', async t => {
  const {server, walletRoot, accounts} = await setup(t);
  await seed(accounts.get('Bob'), 456);
  await rename(join(walletRoot, 'Alice'), join(walletRoot, 'originalAlice'));
  await symlink(join(walletRoot, 'Bob'), join(walletRoot, 'Alice'));
  const alice = await login(server, 'Alice');
  const bob = await login(server, 'Bob');
  assert.equal((await authenticated(server, summaryPath, alice.sessionToken)).status, 503);
  const b = await authenticated(server, summaryPath, bob.sessionToken);
  assert.equal(b.body.summary.wallets.shared_ai.cash, 456);
});

test('P9e internal auth bounds active invites, rotates on refresh and allows only one concurrent redemption', async t => {
  let next = 0;
  const auth = createFriendAuth({accountIds:['Alice', 'Bob'], clock:() => 2000,
    randomBytes:size => Buffer.alloc(size, ++next)});
  assert.throws(() => auth.issueInvite('Unknown'), /not provisioned/);
  const invite = auth.issueInvite('Alice');
  assert.throws(() => auth.issueInvite('Alice'), /already pending/);
  assert.equal(auth.readSession(invite.token), null);
  const {sessionToken} = auth.redeem(invite.token);
  const {csrfToken} = auth.readSession(sessionToken);
  assert.equal(auth.refresh(sessionToken, invite.token), null);
  const refreshed = auth.refresh(sessionToken, csrfToken);
  assert.notEqual(refreshed, sessionToken);
  assert.equal(auth.readSession(sessionToken), null);
  assert.notEqual(auth.readSession(refreshed).csrfToken, csrfToken);
  auth.revokeAccount('Alice');
  assert.equal(auth.readSession(refreshed), null);

  const {server} = await setup(t);
  const pending = server.issueInvite('Alice');
  const result = await Promise.all([redeem(server, pending.token), redeem(server, pending.token)]);
  assert.deepEqual(result.map(response => response.status).sort(), [200, 401]);
});

test('P9e rejects bearer access on a different host or port without echoing authorization', async t => {
  const {server, start} = await setup(t);
  const other = await start();
  const {sessionToken} = await login(server, 'Alice');
  for (const res of [
    await authenticated(server, sessionPath, sessionToken, {headers:{Host:'127.0.0.1:' + server.port}}),
    await authenticated(server, sessionPath, sessionToken, {headers:{Origin:other.origin}}),
    await authenticated(other, sessionPath, sessionToken),
  ]) {
    assert.ok([401, 403].includes(res.status));
    assert.equal(res.headers['set-cookie'], undefined);
    assert.equal(res.headers.authorization, undefined);
    assert.equal(res.headers.location, undefined);
    assert.ok(!res.text.includes(sessionToken));
  }
  assert.equal((await authenticated(server, sessionPath, sessionToken)).status, 200);
});

test('P9e requires 0700 root and account directories and 0600 wallets at startup and after chmod', async t => {
  const {server, config, accounts, walletRoot} = await setup(t);
  const wallet = accounts.get('Alice');
  await seed(wallet, 123);
  const {sessionToken} = await login(server, 'Alice');
  for (const [path, invalidMode, privateMode, message] of [
    [walletRoot, 0o755, 0o700, /mode 0700/],
    [join(walletRoot, 'Alice'), 0o750, 0o700, /mode 0700/],
    [join(walletRoot, 'Alice'), 0o755, 0o700, /mode 0700/],
    [wallet, 0o644, 0o600, /0600 regular file/],
    [wallet, 0o666, 0o600, /0600 regular file/],
  ]) {
    await chmod(path, invalidMode);
    await assert.rejects(startFriendMockServer(config), message);
    const denied = await authenticated(server, summaryPath, sessionToken);
    assert.equal(denied.status, 503);
    assert.deepEqual(denied.body, {error:'unavailable'});
    await chmod(path, privateMode);
  }
  assert.equal((await authenticated(server, summaryPath, sessionToken)).body.summary.wallets.shared_ai.cash, 123);
});

test('P9e rejects a wallet symlink installed after startup', async t => {
  const {server, accounts} = await setup(t);
  const alice = accounts.get('Alice');
  const bob = accounts.get('Bob');
  await seed(alice, 123);
  await seed(bob, 456);
  const {sessionToken} = await login(server, 'Alice');
  await unlink(alice);
  await symlink(bob, alice);
  const denied = await authenticated(server, summaryPath, sessionToken);
  assert.equal(denied.status, 503);
  assert.deepEqual(denied.body, {error:'unavailable'});
});

test('P9e rechecks the opened wallet permissions and path identity after reading', async t => {
  const {server, accounts} = await setup(t);
  const wallet = accounts.get('Alice');
  await seed(wallet, 123);
  const replacement = join(wallet, '..', 'replacement.json');
  await seed(replacement, 456);
  const {sessionToken} = await login(server, 'Alice');
  const handle = await open(wallet);
  const {dev, ino} = await handle.stat();
  const prototype = Object.getPrototypeOf(handle);
  const originalRead = prototype.read;
  await handle.close();

  let onRead = () => chmod(wallet, 0o644);
  t.mock.method(prototype, 'read', async function(...args) {
    const read = await originalRead.apply(this, args);
    const stat = await this.stat();
    if (onRead && stat.dev === dev && stat.ino === ino) {
      const change = onRead;
      onRead = null;
      await change();
    }
    return read;
  });

  const modeChanged = await authenticated(server, summaryPath, sessionToken);
  assert.equal(onRead, null);
  assert.equal(modeChanged.status, 503);
  await chmod(wallet, 0o600);

  onRead = async () => {
    // Preserve the open file with one link and valid permissions, but swap its path.
    await rename(wallet, join(wallet, '..', 'old.json'));
    await rename(replacement, wallet);
  };
  const fileChanged = await authenticated(server, summaryPath, sessionToken);
  assert.equal(onRead, null);
  assert.equal(fileChanged.status, 503);
  assert.deepEqual(fileChanged.body, {error:'unavailable'});
});

const characterPath = '/friend/character';
const recordsPath = '/friend/forward/records';
const exampleCompanion = {name:'藍', approach:'trend', risk_percent:30, hair_color:'#123456', clothing_color:'#abcdef'};
const exampleLook = {hair_style:'bob', accessory:'glasses', expression:'calm'};

async function writeProfile(wallet, companion, look) {
  const folder = dirname(wallet);
  await writeFile(join(folder, 'companion.json'), JSON.stringify({schema:1, revision:2, companion}), {mode:0o600});
  await writeFile(join(folder, 'looks.json'), JSON.stringify({schema:1, revision:1, look}), {mode:0o600});
}

test('P9f both GETs require bearer, reject selectors and writes, and are absent on the legacy listener', async t => {
  const {server} = await setup(t);
  const {sessionToken} = await login(server, 'Alice');
  const legacy = createGameServer();
  await new Promise(resolve => legacy.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(done => legacy.close(done)));
  for (const path of [characterPath, recordsPath]) {
    assert.equal((await call(server, path)).status, 401);
    assert.equal((await authenticated(server, path + '?accountId=Bob', sessionToken)).status, 400);
    assert.equal((await authenticated(server, path, sessionToken, {method:'POST'})).status, 404);
    const legacyUrl = 'http://127.0.0.1:' + legacy.address().port + path;
    assert.equal((await fetch(legacyUrl)).status, 404);
  }
});

test('P9f each bearer selects its own companion, look and strategy even with identical wallet AI IDs', async t => {
  const {server, accounts} = await setup(t);
  const other = {...exampleCompanion, name:'茜', approach:'momentum', risk_percent:60};
  const otherLook = {...exampleLook, accessory:'star', hair_style:'long'};
  for (const [id, companion, look] of [['Alice', exampleCompanion, exampleLook], ['Bob', other, otherLook]]) {
    await seed(accounts.get(id), 100);
    await writeProfile(accounts.get(id), companion, look);
  }
  const [alice, bob] = await Promise.all(['Alice', 'Bob'].map(id => login(server, id)));
  for (const [user, companion, look] of [[bob, other, otherLook], [alice, exampleCompanion, exampleLook]]) {
    const res = await authenticated(server, characterPath, user.sessionToken);
    assert.equal(res.status, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual(res.body, {companion:{created:true, revision:2, ...companion},
      looks:{created:true, revision:1, ...look}, model_version:deriveForwardCompanionModel(companion).model_version});
  }
});

test('P9f absent files independently return unsaved defaults and do not adopt another profile', async t => {
  const {server, accounts} = await setup(t);
  await writeProfile(accounts.get('Bob'), exampleCompanion, exampleLook);
  const {sessionToken} = await login(server, 'Alice');
  const initial = await authenticated(server, characterPath, sessionToken);
  assert.equal(initial.status, 200);
  assert.equal(initial.body.model_version, null);
  assert.equal(initial.body.companion.created, false);
  assert.equal(initial.body.looks.created, false);
  assert.notEqual(initial.body.companion.name, exampleCompanion.name);
  await writeProfile(accounts.get('Alice'), exampleCompanion, exampleLook);
  await unlink(join(dirname(accounts.get('Alice')), 'looks.json'));
  const partial = await authenticated(server, characterPath, sessionToken);
  assert.equal(partial.status, 200);
  assert.deepEqual(partial.body.looks, initial.body.looks);
  assert.equal(partial.body.companion.created, true);
});

test('P9f rejects malformed, oversized, non-private, and linked profile files', async t => {
  const {server, accounts} = await setup(t);
  const alice = accounts.get('Alice');
  const bob = accounts.get('Bob');
  await writeProfile(bob, exampleCompanion, exampleLook);
  const {sessionToken} = await login(server, 'Alice');
  const denied = async () => {
    const res = await authenticated(server, characterPath, sessionToken);
    assert.equal(res.status, 503);
    assert.deepEqual(res.body, {error:'unavailable'});
  };
  for (const [file, field, value, limit] of [['companion.json','companion',exampleCompanion,4096],
    ['looks.json','look',exampleLook,2048]]) {
    const path = join(dirname(alice), file);
    const record = {schema:1, revision:1, [field]:value};
    for (const content of ['{', JSON.stringify({...record, schema:2}), JSON.stringify({...record, revision:0}),
      JSON.stringify({...record, extra:true}), JSON.stringify({...record, [field]:{...value, extra:true}}),
      JSON.stringify(record).padEnd(limit + 1)]) {
      await writeFile(path, content, {mode:0o600});
      await denied();
    }
    await writeFile(path, JSON.stringify(record));
    await chmod(path, 0o644);
    await denied();
    await unlink(path);
    for (const install of [symlink, link]) {
      await install(join(dirname(bob), file), path);
      await denied();
      await unlink(path);
    }
  }
});

test('P9f rejects a profile whose pathname changes while its verified descriptor is open', async t => {
  const {server, accounts} = await setup(t);
  const wallet = accounts.get('Alice');
  const path = join(dirname(wallet), 'companion.json');
  await writeProfile(wallet, exampleCompanion, exampleLook);
  const {sessionToken} = await login(server, 'Alice');
  const handle = await open(path);
  const {dev, ino} = await handle.stat();
  const prototype = Object.getPrototypeOf(handle);
  const read = prototype.read;
  await handle.close();
  let replaced = false;
  t.mock.method(prototype, 'read', async function(...args) {
    const result = await read.apply(this, args);
    const stat = await this.stat();
    if (!replaced && stat.dev === dev && stat.ino === ino) {
      replaced = true;
      await rename(path, path + '.old');
      await writeFile(path, '{}', {mode:0o600});
    }
    return result;
  });
  const res = await authenticated(server, characterPath, sessionToken);
  assert.equal(replaced, true);
  assert.equal(res.status, 503);
  assert.deepEqual(res.body, {error:'unavailable'});
});

test('P9f record configuration rejects unbranded and unknown account sources', async t => {
  const {config} = await setup(t);
  for (const id of ['Alice', 'Unknown']) {
    const entry = {source:{read:assert.fail, snapshot:assert.fail}, forecastId:'a'.repeat(64)};
    await assert.rejects(startFriendMockServer({...config, accountRecordSources:new Map([[id,entry]])}),
      /Invalid account mock record source/);
  }
});

// Drive a complete P4 round with local signed synthetic trades. The friend GET
// must reverify stored evidence without asking this adapter for another batch.
async function provisionMockRound(walletFile, targetPrice = 108) {
  const directory = join(dirname(walletFile), 'forecasts');
  await mkdir(directory, {mode:0o700});
  const issue = Date.parse('2030-01-07T01:00:00Z');
  const target = issue + 10 * 60_000;
  const state = {now:issue, rows:[], reads:0, allowed:true};
  const sign = raw => createHmac('sha256', 'P9f public test fixture').update(raw).digest('hex');
  function trade(time, price, extra) {
    const at = new Date(time).toISOString();
    const raw = JSON.stringify({sourceId:MOCK_MARKET_SOURCE, market:'XTKS', symbol:'FAKE', valueKind:'TRADE',
      price, tradeAt:at, publishedAt:at, ...extra});
    return {raw, proof:sign(raw)};
  }
  const reference = trade(issue - 60_000, 100);
  const marketAdapter = createForwardMarketAdapter({sourceId:MOCK_MARKET_SOURCE, licenseRef:'Local P9f fixture',
    observationIntervalMs:5 * 60_000, maxAgeMs:10 * 60_000, maxPublicationDelayMs:60_000,
    clock:() => state.now, verifyUsage:() => state.allowed, marketStatusAt:() => 'OPEN',
    verifyRecord:({raw, proof}) => sign(raw) === proof ? JSON.parse(raw) : null,
    readBatch:() => { state.reads++; return state.rows; },
  });
  const generation = deriveForwardCompanionModel(exampleCompanion);
  await openForwardStore({filePath:walletFile, marketAdapter, initial:{mode:MOCK_MARKET_PAPER_MODE,
    initialMedals:1000, allocations:[{id:'control', modelHash:'a'.repeat(64), medals:100}]}});
  await saveForwardGeneration({filePath:walletFile, aiId:'shared_ai', medals:300, generation, expectedRevision:0});
  const options = {walletFile, directory, marketAdapter, reference, margin:100, leverage:1};
  const lifecycle = await openForwardMockLifecycle(options);
  const {receipt:{forecastId}} = await lifecycle.freeze({aiId:'shared_ai', modelHash:generation.modelHash,
    model_version:generation.model_version, sourceMode:'TEST_ONLY', symbol:'FAKE',
    targetAt:new Date(target).toISOString(), probabilities:{UP:.8, FLAT:.1, DOWN:.1}});
  async function fill(time, price) {
    state.now = time;
    state.rows = [trade(time, price, {referenceProof:reference.proof})];
    await lifecycle.applyBatch();
  }
  await lifecycle.reserveOpen(forecastId);
  await fill(issue + 5 * 60_000, 100);
  await lifecycle.reserveClose(forecastId);
  await fill(target, targetPrice);
  await lifecycle.score(forecastId);
  return {state, options, config:{forecastId, source:lifecycle.recordSource}};
}

test('P9f an authorized scored P4 record is private even when another wallet has the identical forecast ID', async t => {
  const {start, accounts} = await setup(t);
  const a = await provisionMockRound(accounts.get('Alice'), 108);
  const b = await provisionMockRound(accounts.get('Bob'), 93);
  assert.equal(a.config.forecastId, b.config.forecastId);
  const sources = new Map([['Alice', a.config]]);
  const first = await start({accountRecordSources:sources});
  const {sessionToken} = await login(first, 'Bob');
  assert.deepEqual((await authenticated(first, recordsPath, sessionToken)).body, {status:'unconnected', records:[]});
  sources.set('Bob', b.config);
  const second = await start({accountRecordSources:sources});
  for (const [account, pnl] of [['Alice',8], ['Bob',-7]]) {
    const auth = await login(second, account);
    const res = await authenticated(second, recordsPath, auth.sessionToken);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'MOCK_NONLIVE');
    assert.equal(res.body.records.length, 1);
    const [record] = res.body.records;
    assert.equal(record.aiId, 'shared_ai');
    assert.equal(record.realizedPnl, pnl);
    assert.equal(record.status, 'SCORED_MOCK_NONLIVE');
    assert.doesNotMatch(res.text, /accountId|proof|nonce|evidence|modelHash|forecastSha256|\/tmp\//);
  }
  assert.deepEqual([a.state.reads, b.state.reads], [2, 2]);
});

test('P9f refuses another wallet, shared forecast directory, false FX capability and revoked usage', async t => {
  const {config, accounts} = await setup(t);
  const a = await provisionMockRound(accounts.get('Alice'));
  const b = await provisionMockRound(accounts.get('Bob'));
  const wrongDir = await openForwardMockLifecycle({...b.options, directory:a.options.directory});
  for (const entries of [
    [['Bob', a.config]], [['Alice', a.config], ['Bob', {...b.config, source:wrongDir.recordSource}]],
    [['Alice', {...a.config, fxSource:{}}]],
  ]) {
    await assert.rejects(startFriendMockServer({...config, accountRecordSources:new Map(entries)}),
      /Invalid account mock record source|trusted FX source/);
  }
  a.state.allowed = false;
  await assert.rejects(startFriendMockServer({...config, accountRecordSources:new Map([['Alice', a.config]])}),
    /利用許可/);
});

test('P9f stops serving records on revocation, missing evidence, mode changes, or forecast directory replacement', async t => {
  const {accounts, start} = await setup(t);
  const a = await provisionMockRound(accounts.get('Alice'));
  const server = await start({accountRecordSources:new Map([['Alice', a.config]])});
  const {sessionToken} = await login(server, 'Alice');
  const denied = async () => {
    const res = await authenticated(server, recordsPath, sessionToken);
    assert.equal(res.status, 503);
    assert.deepEqual(res.body, {error:'unavailable'});
  };
  a.state.allowed = false;
  await denied();
  a.state.allowed = true;
  await chmod(a.options.walletFile, 0o644);
  await denied();
  await chmod(a.options.walletFile, 0o600);
  const receipt = join(a.options.directory, a.config.forecastId + '.receipt.json');
  await rename(receipt, receipt + '.old');
  await denied();
  await rename(receipt + '.old', receipt);
  assert.equal((await authenticated(server, recordsPath, sessionToken)).status, 200);
  await rename(a.options.directory, a.options.directory + '.old');
  await mkdir(a.options.directory, {mode:0o700});
  await denied();
});
