import {createHash, randomBytes as systemRandomBytes, timingSafeEqual} from 'node:crypto';

const ACCOUNT = /^[A-Za-z0-9]{1,32}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const INVITE_MS = 24 * 60 * 60_000;
const SESSION_MS = 8 * 60 * 60_000;
export const FRIEND_LOGIN_WINDOW_SECONDS = 60;
const MAX_FAILURES = 8;
const digest = value => createHash('sha256').update(value).digest();

function validToken(value) {
  return typeof value === 'string' && TOKEN.test(value);
}

function findCredential(records, token) {
  if (!validToken(token)) return null;
  const hashed = digest(token);
  let found = null;
  for (const record of records.values()) {
    if (timingSafeEqual(record.digest, hashed)) found = record;
  }
  return found;
}

/** Single-process capability store. A new instance carries no invites or sessions. */
export function createFriendAuth({accountIds, clock = Date.now, randomBytes = systemRandomBytes} = {}) {
  if (!Array.isArray(accountIds) || accountIds.length < 2 || accountIds.length > 10 ||
      accountIds.some(id => typeof id !== 'string' || !ACCOUNT.test(id)) ||
      new Set(accountIds).size !== accountIds.length ||
      typeof clock !== 'function' || typeof randomBytes !== 'function') {
    throw new TypeError('Configure two to ten distinct friend account IDs');
  }

  const accounts = new Set(accountIds);
  const invites = new Map();
  const sessions = new Map();
  const failures = [];
  let lastTime = 0;

  function now() {
    const time = clock();
    if (!Number.isSafeInteger(time) || time < 0 || time > 8.64e15 - INVITE_MS) {
      throw new RangeError('Invalid server clock');
    }
    // Moving a wall clock backwards cannot extend a credential's lifetime.
    lastTime = Math.max(time, lastTime);
    for (const records of [invites, sessions]) {
      for (const [id, record] of records) if (record.expiresAt <= lastTime) records.delete(id);
    }
    while (failures.length && failures[0] + FRIEND_LOGIN_WINDOW_SECONDS * 1000 <= lastTime) failures.shift();
    return lastTime;
  }

  function account(id) {
    if (!accounts.has(id)) throw new RangeError('Friend account is not provisioned');
  }

  function newToken() {
    const bytes = randomBytes(32);
    if (!Buffer.isBuffer(bytes) || bytes.length !== 32) throw new Error('Invalid friend credential entropy');
    const token = bytes.toString('base64url');
    if (findCredential(invites, token) || findCredential(sessions, token)) {
      throw new Error('Repeated friend credential entropy');
    }
    return token;
  }

  function newSession(accountId, time) {
    const token = newToken();
    const csrfToken = newToken();
    if (csrfToken === token) throw new Error('Repeated friend credential entropy');
    sessions.set(accountId, {accountId, digest:digest(token), csrfToken, expiresAt:time + SESSION_MS});
    return token;
  }

  function validCsrf(session, token) {
    return validToken(token) && timingSafeEqual(digest(session.csrfToken), digest(token));
  }

  return Object.freeze({
    issueInvite(accountId) {
      account(accountId);
      const time = now();
      if (invites.has(accountId)) throw new Error('A friend invite is already pending for this account');
      const token = newToken();
      const expiresAt = time + INVITE_MS;
      invites.set(accountId, {accountId, digest:digest(token), expiresAt});
      return {token, expiresAt};
    },
    redeem(token) {
      const time = now();
      const invite = findCredential(invites, token);
      if (!invite) {
        if (failures.length >= MAX_FAILURES) return {status:'limited'};
        failures.push(time);
        return {status:'denied'};
      }
      const sessionToken = newSession(invite.accountId, time);
      invites.delete(invite.accountId);
      return {status:'authenticated', sessionToken};
    },
    readSession(token) {
      now();
      const session = findCredential(sessions, token);
      if (!session) return null;
      const {accountId, csrfToken, expiresAt} = session;
      return {accountId, csrfToken, expiresAt};
    },
    refresh(token, csrf) {
      const time = now();
      const session = findCredential(sessions, token);
      return session && validCsrf(session, csrf) ? newSession(session.accountId, time) : null;
    },
    logout(token, csrf) {
      now();
      const session = findCredential(sessions, token);
      if (!session) return 'missing';
      if (!validCsrf(session, csrf)) return 'forbidden';
      sessions.delete(session.accountId);
      return 'revoked';
    },
    revokeAccount(accountId) {
      account(accountId);
      invites.delete(accountId);
      sessions.delete(accountId);
    },
  });
}
