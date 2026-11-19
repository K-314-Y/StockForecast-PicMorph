import {once} from 'node:events';
import {createServer} from 'node:http';
import {configureFriendData, parseFriendProfileJson} from './friend-account-data.mjs';
import {createFriendAuth, FRIEND_LOGIN_WINDOW_SECONDS} from './friend-auth.mjs';

const BIND = '127.0.0.1';
const HOST = 'friend.localhost';
const MAX_BODY = 256;
const ROUTES = new Set([
  'POST /friend/character/companion', 'POST /friend/character/look',
  'GET /friend/character', 'GET /friend/forward/records',
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

async function readJsonBody(req, limit, parse = JSON.parse) {
  if (req.headersDistinct['content-type']?.length !== 1 || req.headers['content-type'] !== 'application/json') {
    throw bodyError(415);
  }
  const length = req.headers['content-length'];
  if (req.headersDistinct['content-length']?.length !== 1 || req.headers['transfer-encoding'] || !/^[1-9]\d*$/.test(length ?? '')) throw bodyError(400);
  if (Number(length) > limit) throw bodyError(413);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw bodyError(413);
    chunks.push(chunk);
  }
  if (size !== Number(length)) throw bodyError(400);
  try {
    return parse(new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(Buffer.concat(chunks)));
  } catch {
    throw bodyError(400);
  }
}

async function readInvite(req) {
  const body = await readJsonBody(req, MAX_BODY);
  if (!body || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'invite') ||
      typeof body.invite !== 'string') throw bodyError(400);
  return body.invite;
}

/** Explicit loopback-only local prototype. All account configuration is server-owned. */
export async function startFriendMockServer({accounts, walletRoot, accountRecordSources, port = 0, clock, randomBytes} = {}) {
  if (!(accounts instanceof Map) || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new TypeError('Explicit friend account map and a valid local port are required');
  }
  accounts = new Map(accounts);
  const auth = createFriendAuth({accountIds:[...accounts.keys()], clock, randomBytes});
  const accessAccount = await configureFriendData(walletRoot, accounts, accountRecordSources);
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

        const token = sessionToken(req);
        if (route === 'POST /friend/character/companion' || route === 'POST /friend/character/look') {
          const session = auth.readSession(token);
          if (!session) return error(res, 401, 'authentication_required', {Connection:'close'});
          const csrf = req.headersDistinct['x-csrf-token'];
          if (csrf?.length !== 1 || !auth.canEdit(token, csrf[0])) {
            return error(res, 403, 'csrf_required', {Connection:'close'});
          }
          function authorize() {
            if (!auth.canEdit(token, csrf[0])) {
              throw Object.assign(Error('Session expired or revoked'), {code:'FRIEND_SESSION_EXPIRED'});
            }
          }
          let payload;
          try { payload = await readJsonBody(req, 4096, parseFriendProfileJson); }
          catch (err) { return error(res, err.status ?? 400, 'invalid_request', {Connection:'close'}); }
          authorize();
          const data = await accessAccount(session.accountId, path, payload, authorize);
          authorize();
          return respond(res, 200, data);
        }

        if (req.headers['transfer-encoding'] ||
            (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')) {
          return error(res, 400, 'body_not_allowed', {Connection:'close'});
        }
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

        const data = await accessAccount(session.accountId, path);
        // Do not return account data after a concurrent logout, rotation or expiry.
        if (auth.readSession(token)?.accountId !== session.accountId) return error(res, 401, 'authentication_required');
        return respond(res, 200, data);
      }
      handle().catch(err => {
        if (res.headersSent || res.destroyed) return;
        if (err.code === 'FRIEND_INVALID_EDIT') return error(res, 400, 'invalid_request');
        if (err.code === 'FRIEND_CONFLICT') return error(res, 409, 'profile_conflict');
        if (err.code === 'FRIEND_SESSION_EXPIRED') return error(res, 401, 'authentication_required');
        error(res, 503, 'unavailable', {Connection:'close'});
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
