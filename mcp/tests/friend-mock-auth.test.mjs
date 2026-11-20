import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, unlink, writeFile} from 'node:fs/promises';
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
import {openForwardStore} from '../../game_runtime/forward-store.mjs';
import {provisionFriendMockRound} from './friend-mock-record-fixture.mjs';

const redeemPath = '/friend/invite/redeem';
const sessionPath = '/friend/session';
const logoutPath = '/friend/logout';
const summaryPath = '/friend/forward/summary';

function call(server, path, {method = 'GET', headers = {}, body, rawBody} = {}) {
  const bytes = rawBody ?? (body === undefined ? undefined : Buffer.from(JSON.stringify(body)));
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

function provisionMockRound(walletFile, targetPrice) {
  return provisionFriendMockRound(walletFile, {companion:exampleCompanion, targetPrice});
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

const companionEdit = '/friend/character/companion';
const lookEdit = '/friend/character/look';
const firstCompanion = {expected_revision:0, companion:exampleCompanion};
const firstLook = {expected_revision:0, look:exampleLook};

async function editor(server, id) {
  const {sessionToken} = await login(server, id);
  const {body:{csrfToken}} = await authenticated(server, sessionPath, sessionToken);
  return {sessionToken, csrfToken, save:(path, body, headers) => authenticated(server, path, sessionToken,
    {method:'POST', body, headers:{'X-CSRF-Token':csrfToken, ...headers}})};
}

test('P9g saves only the authenticated companion and strategy with optimistic revisions', async t => {
  const {server, accounts} = await setup(t);
  const a = await editor(server, 'Alice');
  const result = await a.save(companionEdit, firstCompanion);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.companion, {created:true, revision:1, ...exampleCompanion});
  assert.equal(result.body.model_version, deriveForwardCompanionModel(exampleCompanion).model_version);
  assert.equal(result.body.looks.created, false);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.doesNotMatch(result.text, /sessionToken|csrfToken|modelHash|proof/);
  const target = join(dirname(accounts.get('Alice')), 'companion.json');
  const saved = await readFile(target);
  assert.equal((await a.save(companionEdit, firstCompanion)).status, 409);
  assert.deepEqual(await readFile(target), saved);
  await assert.rejects(readFile(join(dirname(accounts.get('Bob')), 'companion.json')), {code:'ENOENT'});
});

test('P9g look and companion revisions are independent and persist through server restarts', async t => {
  const {server, start} = await setup(t);
  const a = await editor(server, 'Alice');
  await a.save(companionEdit, firstCompanion);
  const saved = await a.save(lookEdit, firstLook);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.companion.revision, 1);
  assert.deepEqual(saved.body.looks, {created:true, revision:1, ...exampleLook});
  const second = await start();
  const next = await editor(second, 'Alice');
  assert.deepEqual((await authenticated(second, characterPath, next.sessionToken)).body, saved.body);
  const updated = await next.save(lookEdit, {expected_revision:1, look:{...exampleLook, accessory:'star'}});
  assert.equal(updated.status, 200);
  assert.equal(updated.body.looks.revision, 2);
  assert.deepEqual(updated.body.companion, saved.body.companion);
});

test('P9g isolates A/B writes and keeps both fixed private files inside their own folder', async t => {
  const {server, accounts} = await setup(t);
  const users = await Promise.all(['Alice','Bob'].map(id => editor(server, id)));
  for (const [i, id] of ['Alice','Bob'].entries()) {
    const user = users[i];
    const companion = {...exampleCompanion, name:id, risk_percent:25 + 25*i};
    const look = {...exampleLook, accessory:i ? 'glasses' : 'none'};
    assert.equal((await user.save(companionEdit, {expected_revision:0, companion})).status, 200);
    const res = await user.save(lookEdit, {expected_revision:0, look});
    assert.equal(res.status, 200);
    assert.equal(res.body.model_version, deriveForwardCompanionModel(companion).model_version);
    const folder = dirname(accounts.get(id));
    assert.deepEqual((await readdir(folder)).sort(), ['companion.json','looks.json']);
    for (const file of ['companion.json','looks.json']) {
      const stat = await lstat(join(folder, file));
      assert.equal(stat.mode & 0o7777, 0o600);
      assert.equal(stat.uid, process.geteuid());
      assert.equal(stat.nlink, 1);
    }
  }
  assert.equal((await authenticated(server, characterPath, users[0].sessionToken)).body.companion.name, 'Alice');
});

test('P9g rejects unauthenticated writes, wrong or missing CSRF, foreign origin and account queries', async t => {
  const {server, accounts} = await setup(t);
  const [a,b] = await Promise.all(['Alice','Bob'].map(id => editor(server, id)));
  for (const [path, body] of [[companionEdit,firstCompanion],[lookEdit,firstLook]]) {
    assert.equal((await call(server, path, {method:'POST', body})).status, 401);
    assert.equal((await authenticated(server,path,a.sessionToken,{method:'POST',body})).status, 403);
    for (const headers of [{'X-CSRF-Token':b.csrfToken}, {'X-CSRF-Token':[a.csrfToken,a.csrfToken]},
      {Origin:'http://other.localhost'}, {'Sec-Fetch-Site':'same-site'}, {Forwarded:'for=127.0.0.1'}]) {
      assert.equal((await a.save(path, body, headers)).status, 403);
    }
    assert.equal((await a.save(path + '?accountId=Bob', body)).status, 400);
    assert.equal((await a.save(path, {...body, accountId:'Bob'})).status, 400);
    assert.equal((await a.save(path, {...body, path:'../Bob/looks.json'})).status, 400);
  }
  for (const file of accounts.values()) assert.deepEqual(await readdir(dirname(file)), []);
});

test('P9g rejects invalid strategy, look, revision, extra fields and control characters', async t => {
  const {server,accounts} = await setup(t);
  const a = await editor(server, 'Alice');
  for (const payload of [null, {}, [], {expected_revision:0}, {...firstCompanion, expected_revision:-1},
    {...firstCompanion, expected_revision:1.5}, {...firstCompanion, expected_revision:'0'},
    ...[{name:'a\u0001b'},{approach:'external'},{risk_percent:77},{hair_color:'invalid'},{account:'Bob'}]
      .map(change => ({...firstCompanion, companion:{...exampleCompanion, ...change}}))]) {
    assert.equal((await a.save(companionEdit, payload)).status, 400);
  }
  for (const change of [{expression:'bad'},{hair_style:'bad'},{asset:'image.png'}]) {
    assert.equal((await a.save(lookEdit, {...firstLook, look:{...exampleLook, ...change}})).status, 400);
  }
  assert.deepEqual(await readdir(dirname(accounts.get('Alice'))), []);
});

test('P9g rejects duplicate JSON keys including escaped names, malformed bytes, wrong content type and oversized body', async t => {
  const {server, accounts} = await setup(t);
  const a = await editor(server, 'Alice');
  const raw = JSON.stringify(firstLook);
  const send = (bytes, headers) => authenticated(server, lookEdit, a.sessionToken, {method:'POST',
    rawBody:Buffer.from(bytes), headers:{'X-CSRF-Token':a.csrfToken, ...headers}});
  for (const bytes of ['{', raw.replace('{','{"expected_revision":3,'),
    raw.replace('"hair_style":', '"hair_\\u0073tyle":"long","hair_style":'), Buffer.from([0xff])]) {
    assert.equal((await send(bytes)).status, 400);
  }
  assert.equal((await send(raw.padEnd(4097))).status, 413);
  assert.equal((await send(raw, {'Content-Type':'text/plain'})).status, 415);
  const chunked = await authenticated(server, lookEdit, a.sessionToken, {method:'POST',
    headers:{'X-CSRF-Token':a.csrfToken, 'Content-Type':'application/json','Transfer-Encoding':'chunked'}});
  assert.equal(chunked.status, 400);
  assert.deepEqual(await readdir(dirname(accounts.get('Alice'))), []);
});

test('P9g refuses existing symlinks, hardlinks, unsafe modes and malformed records without replacement', async t => {
  const {server, accounts} = await setup(t);
  await writeProfile(accounts.get('Bob'), exampleCompanion, exampleLook);
  const a = await editor(server, 'Alice');
  const folder = dirname(accounts.get('Alice'));
  for (const [name, path, payload] of [['looks.json',lookEdit,firstLook], ['companion.json',companionEdit,firstCompanion]]) {
    const other = join(dirname(accounts.get('Bob')),name);
    const before = await readFile(other);
    const target = join(folder,name);
    for (const install of [link, symlink]) {
      await install(other, target);
      const ino = (await lstat(target)).ino;
      assert.equal((await a.save(path, payload)).status, 503);
      assert.equal((await lstat(target)).ino, ino);
      await unlink(target);
      assert.deepEqual(await readFile(other), before);
    }
    await writeFile(target, '{}', {mode:0o644});
    for (const mode of [0o644,0o600]) {
      await chmod(target, mode);
      assert.equal((await a.save(path, payload)).status, 503);
      assert.equal(await readFile(target, 'utf8'), '{}');
    }
    await unlink(target);
    assert.deepEqual(await readdir(folder), []);
  }
});

test('P9g never clears stale or foreign locks and rejects a wallet path reserved for character storage', async t => {
  const {server,config,accounts} = await setup(t);
  const folder = dirname(accounts.get('Alice'));
  const lock = join(folder,'.friend-character.lock');
  await writeFile(lock, 'existing writer', {mode:0o600});
  const a = await editor(server,'Alice');
  assert.equal((await a.save(lookEdit, firstLook)).status, 409);
  assert.equal(await readFile(lock, 'utf8'), 'existing writer');
  for (const name of ['companion.json','looks.json','.friend-character.lock']) {
    const unsafe = new Map(accounts).set('Alice', join(folder,name));
    await assert.rejects(startFriendMockServer({...config, accounts:unsafe}), /conflicts/);
  }
});

test('P9g simultaneous servers in separate processes can commit a given revision only once', async t => {
  const {server, accounts, walletRoot} = await setup(t);
  const module = new URL('../../game_runtime/friend-mock-server.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module','-e', `
    import {startFriendMockServer} from ${JSON.stringify(module)};
    process.once('message', async ({accounts,walletRoot}) => {
      const server = await startFriendMockServer({accounts:new Map(accounts),walletRoot});
      process.send({origin:server.origin, port:server.port, invite:server.issueInvite('Alice').token});
      process.once('disconnect', () => server.close());
    });
  `], {stdio:['ignore','ignore','inherit','ipc']});
  const exited = once(child,'exit');
  t.after(async () => { if (child.connected) child.disconnect(); await exited; });
  const ready = once(child,'message');
  child.send({accounts:[...accounts], walletRoot});
  const [other] = await ready;
  const b = await redeem(other, other.invite);
  const otherToken = b.body.sessionToken;
  const csrf = (await authenticated(other, sessionPath, otherToken)).body.csrfToken;
  const a = await editor(server, 'Alice');
  const second = {...firstCompanion, companion:{...exampleCompanion, name:'second'}};
  const results = await Promise.all([a.save(companionEdit,firstCompanion),
    authenticated(other,companionEdit,otherToken,{method:'POST',body:second,headers:{'X-CSRF-Token':csrf}})]);
  assert.deepEqual(results.map(result => result.status).sort(), [200,409]);
  const stored = JSON.parse(await readFile(join(dirname(accounts.get('Alice')),'companion.json')));
  assert.equal(stored.revision, 1);
  assert.equal(stored.companion.name, results.find(result => result.status === 200).body.companion.name);
});

test('P9g editing a strategy preserves the frozen wallet and scored P4 record byte for byte', async t => {
  const {start,accounts} = await setup(t);
  const wallet = accounts.get('Alice');
  const round = await provisionMockRound(wallet);
  const server = await start({accountRecordSources:new Map([['Alice',round.config]])});
  const a = await editor(server,'Alice');
  const forecastFiles = (await readdir(round.options.directory)).sort();
  const bytes = () => Promise.all([wallet, ...forecastFiles.map(name => join(round.options.directory,name))]
    .map(file => readFile(file)));
  const before = await bytes();
  const old = await authenticated(server,recordsPath,a.sessionToken);
  assert.equal(old.body.records[0].status, 'SCORED_MOCK_NONLIVE');
  const saved = await a.save(companionEdit,{expected_revision:0, companion:{...exampleCompanion, approach:'reversion'}});
  assert.equal(saved.status, 200);
  assert.notEqual(saved.body.model_version, old.body.records[0].model_version);
  assert.deepEqual((await authenticated(server,recordsPath,a.sessionToken)).body, old.body);
  assert.deepEqual(await bytes(), before);
  assert.deepEqual((await readdir(round.options.directory)).sort(), forecastFiles);
});
