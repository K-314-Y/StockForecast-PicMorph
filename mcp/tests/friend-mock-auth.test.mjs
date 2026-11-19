import assert from 'node:assert/strict';
import {chmod, link, mkdir, mkdtemp, open, readFile, rename, rm, symlink, unlink} from 'node:fs/promises';
import {request} from 'node:http';
import {join} from 'node:path';
import test from 'node:test';
import {createFriendAuth} from '../../game_runtime/friend-auth.mjs';
import {startFriendMockServer} from '../../game_runtime/friend-mock-server.mjs';
import {createForwardMarketAdapter} from '../../game_runtime/forward-market-adapter.mjs';
import {MOCK_MARKET_PAPER_MODE, MOCK_MARKET_SOURCE} from '../../game_runtime/forward-market-guard.mjs';
import {openForwardStore} from '../../game_runtime/forward-store.mjs';

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
