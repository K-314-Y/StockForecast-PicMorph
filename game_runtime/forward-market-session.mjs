// P9a: deterministic session and pre-freeze observation validation.
// This module has NO external feed or HTTP access and grants NO market-data rights.
// The server must supply an independently verified calendar and evidence verifier.
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SYMBOL = /^[A-Z][A-Z0-9.]{0,14}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;
const trustedSessions = new WeakSet();
const nyClock = new Intl.DateTimeFormat('en-CA', {
  timeZone:'America/New_York', year:'numeric', month:'2-digit', day:'2-digit',
  hour:'2-digit', minute:'2-digit', hourCycle:'h23',
});

function fail(reason) { throw new RangeError(reason); }

function utcMillis(value) {
  if (typeof value !== 'string' || !UTC_ISO.test(value)) fail('UTC ISO timestamp required');
  const ms = Date.parse(value);
  if (!Number.isSafeInteger(ms) || new Date(ms).toISOString() !== value) {
    fail('Invalid UTC timestamp');
  }
  return ms;
}

function localNy(ms) {
  const parts = Object.fromEntries(nyClock.formatToParts(new Date(ms))
    .filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return {date:`${parts.year}-${parts.month}-${parts.day}`,
    time:`${parts.hour}:${parts.minute}`};
}

/**
 * Explicit trusted calendar only; unknown dates, holidays and weekend guesses
 * never count as an open trading session. No exchange calendar is bundled.
 */
export function resolveForwardMarketSession({market = 'XNYS', date, sessions} = {}) {
  if (market !== 'XNYS' || typeof date !== 'string' || !DATE.test(date) ||
      !Array.isArray(sessions) || sessions.length > 400) {
    fail('Unsupported market or missing explicit trading calendar');
  }
  const matches = sessions.filter(s => s?.market === market && s?.date === date);
  if (matches.length !== 1) fail('Session missing or duplicated in supplied calendar');
  const s = matches[0];
  if (s.status !== 'OPEN' || s.timeZone !== 'America/New_York' ||
      typeof s.earlyClose !== 'boolean') fail('Session not explicitly authorized as open');
  const startMs = utcMillis(s.opensAt);
  const endMs = utcMillis(s.closesAt);
  if (endMs <= startMs) fail('Invalid session interval');
  const startLocal = localNy(startMs);
  const endLocal = localNy(endMs);
  const closeClock = s.earlyClose ? '13:00' : '16:00';
  const expectedDuration = (s.earlyClose ? 3.5 : 6.5) * 60 * 60 * 1000;
  if (startLocal.date !== date || endLocal.date !== date ||
      startLocal.time !== '09:30' || endLocal.time !== closeClock ||
      endMs - startMs !== expectedDuration) fail('Session clock or DST mismatch');
  const result = Object.freeze({
    market, date, timeZone:s.timeZone, earlyClose:s.earlyClose,
    opensAt:s.opensAt, closesAt:s.closesAt, startMs, endMs,
  });
  trustedSessions.add(result);
  return result;
}

function currentMillis(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 8.64e15) {
    fail('Invalid server timestamp');
  }
  return value;
}

/**
 * Historical bar/trade validation for model inputs BEFORE a forecast freezes.
 * NOT a signature verifier, stock API, settlement feed, or license check.
 * verifyEvidence must be a trusted server-side synchronous authenticator.
 */
export function validateForwardPreFreezeObservation({
  observation, session, now, cutoff, maxAgeMs = 60_000, verifyEvidence,
} = {}) {
  if (!trustedSessions.has(session) || typeof verifyEvidence !== 'function') {
    fail('Verified calendar and authenticated evidence are required');
  }
  const at = currentMillis(now);
  const deadline = currentMillis(cutoff);
  if (deadline > at || !Number.isSafeInteger(maxAgeMs) ||
      maxAgeMs <= 0 || maxAgeMs > 86_400_000) fail('Invalid freeze or freshness policy');
  const o = observation;
  if (!o || typeof o !== 'object' || Array.isArray(o) ||
      o.sourceMode !== 'MOCK_NONLIVE' || o.market !== session.market ||
      typeof o.symbol !== 'string' || !SYMBOL.test(o.symbol) ||
      typeof o.providerId !== 'string' || !LABEL.test(o.providerId) ||
      typeof o.venue !== 'string' || !LABEL.test(o.venue) ||
      o.valueKind !== 'TRADE' || !Number.isFinite(o.price) || o.price <= 0 ||
      !Number.isSafeInteger(o.volume) || o.volume <= 0) {
    fail('Invalid test-only market observation');
  }
  const trade = utcMillis(o.tradeAt);
  const published = utcMillis(o.publishedAt);
  const received = utcMillis(o.receivedAt);
  if (trade < session.startMs || trade >= session.endMs ||
      published < trade || received < published || received > deadline ||
      received > at || published > deadline || trade >= deadline ||
      at - received > maxAgeMs) {
    fail('Observation outside session, stale, late, or not known before freeze');
  }
  const authenticated = verifyEvidence(Object.freeze({
    providerId:o.providerId, symbol:o.symbol, raw:o.raw, proof:o.proof,
    tradeAt:o.tradeAt, publishedAt:o.publishedAt, receivedAt:o.receivedAt,
    price:o.price, volume:o.volume,
  }));
  if (authenticated && typeof authenticated.then === 'function') {
    Promise.resolve(authenticated).catch(() => {});
    fail('Evidence verifier must be synchronous');
  }
  if (authenticated !== true) fail('Source evidence could not be verified');
  return Object.freeze({
    sourceMode:'MOCK_NONLIVE', market:o.market, providerId:o.providerId,
    venue:o.venue, symbol:o.symbol, valueKind:'TRADE', price:o.price,
    volume:o.volume, tradeAt:o.tradeAt, publishedAt:o.publishedAt,
    receivedAt:o.receivedAt,
  });
}

/** Reject duplicate or out-of-order signed observations before model input. */
export function validateForwardPreFreezeSeries({
  observations, session, now, cutoff, maxAgeMs = 86_400_000, verifyEvidence,
} = {}) {
  if (!Array.isArray(observations) || observations.length < 1 ||
      observations.length > 200) fail('Invalid observation series size');
  const out = [];
  let previousTrade = -Infinity;
  let previousPublication = -Infinity;
  const seen = new Set();
  let identity = null;
  for (const row of observations) {
    const verified = validateForwardPreFreezeObservation({
      observation:row, session, now, cutoff, maxAgeMs, verifyEvidence,
    });
    const trade = utcMillis(verified.tradeAt);
    const publication = utcMillis(verified.publishedAt);
    const key = `${verified.providerId}:${verified.venue}:${verified.tradeAt}`;
    const sourceIdentity = `${verified.providerId}:${verified.venue}:${verified.symbol}`;
    if (trade <= previousTrade || publication < previousPublication ||
        seen.has(key) || (identity !== null && sourceIdentity !== identity)) {
      fail('Duplicate, mixed-feed, or out-of-order observation series');
    }
    seen.add(key);
    identity = sourceIdentity;
    previousTrade = trade;
    previousPublication = publication;
    out.push(verified);
  }
  return Object.freeze(out);
}
