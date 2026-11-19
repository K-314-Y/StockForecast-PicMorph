import {once} from 'node:events';
import {lstat, realpath} from 'node:fs/promises';
import {createServer} from 'node:http';
import {dirname, isAbsolute, relative, resolve, sep} from 'node:path';
import {createFriendAuth, FRIEND_LOGIN_WINDOW_SECONDS} from './friend-auth.mjs';
import {MOCK_MARKET_PAPER_MODE} from './forward-market-guard.mjs';
import {readForwardSnapshot} from './forward-store.mjs';
import {forwardWalletSummary} from './forward-wallet-view.mjs';

const BIND = '127.0.0.1';
const HOST = 'friend.localhost';
const MAX_BODY = 256;
const serverUid = process.geteuid?.();
const ROUTES = new Set([
  'POST /friend/invite/redeem', 'GET /friend/session', 'POST /friend/logout', 'GET /friend/forward/summary',
]);

function respond(res, status, data, headers = {}) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, {
    'Content-Type':'application/json; charset=utf-8',
    'Content-Length':body.length,
    'Cache-Control':'no-store',
    'Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'Referrer-Policy':'no-referrer',
    'X-Content-Type-Options':'nosniff',
    'Cross-Origin-Resource-Policy':'same-origin',
    ...headers,
  });
  res.end(body);
}

const error = (res, status, code, headers) => respond(res, status, {error:code}, headers);

function trustedRequest(req, authority) {
  const headers = req.headersDistinct;
  const origin = headers.origin;
  const site = headers['sec-fetch-site'];
  return req.socket.remoteAddress === BIND &&
    headers.host?.length === 1 && headers.host[0] === authority &&
    (origin ? origin.length === 1 && origin[0] === 'http://' + authority : req.method !== 'POST') &&
    (!site || (site.length === 1 && (site[0] === 'same-origin' || (req.method === 'GET' && site[0] === 'none')))) &&
    !Object.keys(headers).some(key => key === 'forwarded' || key.startsWith('x-forwarded-') ||
      key === 'via' || key === 'x-real-ip');
}

function sessionToken(req) {
  const headers = req.headersDistinct.authorization;
  if (headers?.length !== 1) return undefined;
  return /^Bearer ([A-Za-z0-9_-]{43})$/.exec(headers[0])?.[1];
}

function bodyError(status) {
  return Object.assign(new Error('Invalid friend request body'), {status});
}

async function readInvite(req) {
  if (req.headersDistinct['content-type']?.length !== 1 || req.headers['content-type'] !== 'application/json') {
    throw bodyError(415);
  }
  const length = req.headers['content-length'];
  if (req.headers['transfer-encoding'] || !/^[1-9]\d*$/.test(length ?? '')) throw bodyError(400);
  if (Number(length) > MAX_BODY) throw bodyError(413);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw bodyError(413);
    chunks.push(chunk);
  }
  if (size !== Number(length)) throw bodyError(400);
  let body;
  try {
    body = JSON.parse(new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(Buffer.concat(chunks)));
  } catch {
    throw bodyError(400);
  }
  if (!body || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'invite') ||
      typeof body.invite !== 'string') throw bodyError(400);
  return body.invite;
}

function inside(parent, path) {
  const child = relative(parent, path);
  return child !== '' && !isAbsolute(child) && child !== '..' && !child.startsWith('..' + sep);
}

function absolutePath(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || value !== resolve(value) ||
      value.split(sep).includes('local_state')) {
    throw new RangeError('Friend wallets require explicit canonical paths outside local_state');
  }
  return value;
}

async function directoryIdentity(path) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.uid !== serverUid || (stat.mode & 0o7777) !== 0o700 ||
      await realpath(path) !== path) {
    throw new Error('Friend wallet directories must be real, server-owned and mode 0700');
  }
  return stat.dev + ':' + stat.ino;
}

function fileIdentity(stat) {
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== serverUid || (stat.mode & 0o7777) !== 0o600) {
    throw new Error('Invalid friend wallet file: expected a server-owned 0600 regular file with one link');
  }
  return stat.dev + ':' + stat.ino;
}

async function walletIdentity(path) {
  try { return fileIdentity(await lstat(path)); }
  catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function configureWallets(walletRoot, accounts) {
  const root = absolutePath(walletRoot);
  if (dirname(root) === root) throw new RangeError('Use a dedicated friend wallet root');
  const rootIdentity = await directoryIdentity(root);
  const scopes = new Map();
  for (const [id, value] of accounts) {
    const file = absolutePath(value);
    const folder = dirname(file);
    if (!inside(root, folder)) throw new RangeError('Each friend wallet requires a separate directory under the root');
    const lineage = new Map();
    for (let path = folder; path !== root; path = dirname(path)) {
      lineage.set(path, await directoryIdentity(path));
    }
    const folderIdentity = lineage.get(folder);
    for (const other of scopes.values()) {
      if ([...lineage.values()].includes(other.folderIdentity) ||
          [...other.lineage.values()].includes(folderIdentity)) {
        throw new RangeError('Friend wallet directories cannot be shared, nested or aliased');
      }
    }
    await walletIdentity(file);
    scopes.set(id, {file, folderIdentity, lineage});
  }

  return async id => {
    const scope = scopes.get(id);
    async function verify() {
      if (!scope || await directoryIdentity(root) !== rootIdentity) throw new Error('Friend wallet scope changed');
      for (const [folder, identity] of scope.lineage) {
        if (await directoryIdentity(folder) !== identity) throw new Error('Friend wallet scope changed');
      }
    }
    await verify();
    const before = await walletIdentity(scope.file);
    function verifyOpened(stat) {
      if (fileIdentity(stat) !== before) throw new Error('Friend wallet file changed during read');
    }
    const snapshot = await readForwardSnapshot(scope.file, {verifyOpened}).catch(err => {
      if (err.code !== 'FORWARD_STORE_UNINITIALIZED') throw err;
      return null;
    });
    await verify();
    if (await walletIdentity(scope.file) !== before || (snapshot === null) !== (before === null)) {
      throw new Error('Friend wallet file changed during read');
    }
    if (snapshot === null) return {status:'uninitialized', summary:null};
    if (snapshot.ledger.mode !== MOCK_MARKET_PAPER_MODE) throw new Error('Friend summary requires MOCK_NONLIVE');
    return {status:'MOCK_NONLIVE', summary:forwardWalletSummary(snapshot)};
  };
}

/** Explicit loopback-only local prototype. All account configuration is server-owned. */
export async function startFriendMockServer({accounts, walletRoot, port = 0, clock, randomBytes} = {}) {
  if (!(accounts instanceof Map) || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new TypeError('Explicit friend account map and a valid local port are required');
  }
  accounts = new Map(accounts);
  const auth = createFriendAuth({accountIds:[...accounts.keys()], clock, randomBytes});
  const readSummary = await configureWallets(walletRoot, accounts);
  let authority;
  const limit = res => error(res, 429, 'login_limited', {'Retry-After':String(FRIEND_LOGIN_WINDOW_SECONDS)});

  const server = createServer({maxHeaderSize:4096, headersTimeout:5000, requestTimeout:10000, connectionsCheckingInterval:1000},
    (req, res) => {
      async function handle() {
        if (!trustedRequest(req, authority)) return error(res, 403, 'local_origin_required', {Connection:'close'});
        const [path] = req.url.split('?');
        const route = req.method + ' ' + path;
        if (!ROUTES.has(route)) return error(res, 404, 'not_found', {Connection:'close'});
        if (req.url !== path) return error(res, 400, 'query_not_allowed', {Connection:'close'});

        if (route === 'POST /friend/invite/redeem') {
          let invite;
          try { invite = await readInvite(req); }
          catch (err) {
            if (auth.redeem(null).status === 'limited') return limit(res);
            return error(res, err.status ?? 400, 'invalid_request', {Connection:'close'});
          }
          const result = auth.redeem(invite);
          if (result.status === 'limited') return limit(res);
          if (result.status !== 'authenticated') return error(res, 401, 'invalid_invite');
          return respond(res, 200, {authenticated:true, sessionToken:result.sessionToken});
        }

        if (req.headers['transfer-encoding'] ||
            (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')) {
          return error(res, 400, 'body_not_allowed', {Connection:'close'});
        }
        const token = sessionToken(req);
        const session = auth.readSession(token);
        if (!session) return error(res, 401, 'authentication_required');
        if (route === 'POST /friend/logout') {
          const csrf = req.headersDistinct['x-csrf-token'];
          const result = auth.logout(token, csrf?.length === 1 ? csrf[0] : undefined);
          if (result === 'missing') return error(res, 401, 'authentication_required');
          if (result !== 'revoked') return error(res, 403, 'csrf_required');
          return respond(res, 200, {authenticated:false});
        }
        if (route === 'GET /friend/session') {
          return respond(res, 200, {authenticated:true, ...session});
        }

        const summary = await readSummary(session.accountId);
        // Do not return wallet data after a concurrent logout, rotation or expiry.
        if (auth.readSession(token)?.accountId !== session.accountId) return error(res, 401, 'authentication_required');
        return respond(res, 200, summary);
      }
      handle().catch(() => {
        if (!res.headersSent && !res.destroyed) error(res, 503, 'unavailable', {Connection:'close'});
      });
    });

  const rejectExpectation = (_req, res) => error(res, 417, 'expectation_not_supported', {Connection:'close'});
  server.on('checkContinue', rejectExpectation);
  server.on('checkExpectation', rejectExpectation);
  server.on('clientError', (_err, connection) => connection.destroy());
  server.maxConnections = 32;
  server.setTimeout(5000, connection => connection.destroy());
  server.listen(port, BIND);
  await once(server, 'listening');
  authority = HOST + ':' + server.address().port;
  return Object.freeze({
    origin:'http://' + authority,
    port:server.address().port,
    issueInvite:auth.issueInvite,
    revokeAccount:auth.revokeAccount,
    close:() => new Promise((done, fail) => server.close(err => err ? fail(err) : done())),
  });
}
