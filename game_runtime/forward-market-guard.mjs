export const TEST_FIXTURE_SOURCE = 'TEST_FIXTURE_NOT_LIVE';
export const MARKET_PAPER_MODE = 'FORWARD_MARKET_PAPER';
export const MOCK_MARKET_SOURCE = 'MOCK_NONLIVE';
export const MOCK_MARKET_PAPER_MODE = 'FORWARD_MARKET_PAPER_MOCK_NONLIVE';
export const MARKET_SYMBOL = /^[0-9A-Z]{4,5}$/;
export const MARKET_SOURCE_ID = /^[A-Z0-9_]{3,40}$/;

export const isMarketMode = mode => mode === MARKET_PAPER_MODE || mode === MOCK_MARKET_PAPER_MODE;
export const isObservationInterval = ms => Number.isSafeInteger(ms) && ms > 0 && ms <= 24 * 60 * 60_000;
export const observationSlot = (time, interval) => Math.floor(time / interval);
// A receipt exactly on a boundary belongs to the following batch.
export const nextObservation = (time, interval) => (observationSlot(time, interval) + 1) * interval;
export const isEvidenceText = (value, maxBytes) =>
  typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= maxBytes &&
  Buffer.from(value, 'utf8').toString('utf8') === value;

const JST_OFFSET = 9 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;

export function utcTime(value) {
  if (typeof value !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return NaN;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value.slice(0, 10)
    ? time : NaN;
}

export function isMarketPrice(value) {
  return Number.isFinite(value) && value >= 0.000001 && value <= 1_000_000_000;
}

function jstSession(time) {
  const local = time + JST_OFFSET;
  const day = Math.floor(local / DAY);
  const elapsed = local - day * DAY;
  if (elapsed >= 9 * 60 * MINUTE && elapsed <= (11 * 60 + 30) * MINUTE) return day * 2;
  if (elapsed >= (12 * 60 + 30) * MINUTE && elapsed <= (15 * 60 + 30) * MINUTE) return day * 2 + 1;
  return null;
}

/**
 * Callbacks and clock belong to the server. The adapter stamps observedAt and
 * each ingestedAt at receipt. verifyQuote must bind the canonical quote to
 * authenticated provider evidence and trusted ingestion metadata.
 * marketStatusAt({symbol, at}) must use a trusted calendar and per-symbol halt
 * information, returning OPEN only when both are known. Both callbacks are
 * synchronous. now is the server's current time in epoch milliseconds.
 */
export function guardMarketQuotes({sourceId, quotes}, batchTime, lastTradeAt, policy, now) {
  if (typeof sourceId !== 'string' || !MARKET_SOURCE_ID.test(sourceId) ||
      sourceId === TEST_FIXTURE_SOURCE || policy?.enabled !== true ||
      policy.usageAuthorized !== true || policy.sourceId !== sourceId ||
      !Number.isSafeInteger(policy.maxAgeMs) || policy.maxAgeMs <= 0 ||
      typeof policy.verifyQuote !== 'function' || typeof policy.marketStatusAt !== 'function') {
    throw new RangeError('市場観測元の利用許可または検証設定がありません');
  }
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(batchTime) ||
      batchTime > now || now - batchTime > policy.maxAgeMs) {
    throw new RangeError('市場観測バッチの取得時刻が不正です');
  }
  const accepted = new Map();
  const session = jstSession(now);
  if (session === null || jstSession(batchTime) !== session) return accepted;

  for (const [symbol, quote] of Object.entries(quotes)) {
    if (!quote || typeof quote !== 'object' || Array.isArray(quote)) continue;
    const {symbol: quotedSymbol, price, tradeAt, publishedAt, ingestedAt, proof} = quote;
    if (quotedSymbol !== symbol || !isMarketPrice(price) || typeof proof !== 'string' || !proof) continue;
    const trade = utcTime(tradeAt);
    const published = utcTime(publishedAt);
    const ingested = utcTime(ingestedAt);
    if (!(trade <= published && published <= ingested && ingested <= batchTime) ||
        now - trade > policy.maxAgeMs || jstSession(trade) !== session ||
        (Object.hasOwn(lastTradeAt, symbol) && trade <= utcTime(lastTradeAt[symbol]))) continue;

    const {evidence} = quote;
    if (policy.verifyQuote(Object.freeze({sourceId, symbol, price, tradeAt, publishedAt, ingestedAt, proof,
      ...(evidence ? {evidence} : {})})) !== true ||
        [...new Set([trade, published, ingested, batchTime, now])].some(time =>
          policy.marketStatusAt({symbol, at: new Date(time).toISOString()}) !== 'OPEN')) continue;

    accepted.set(symbol, {price, tradeAt, publishedAt, ingestedAt, trade, evidence});
  }
  return accepted;
}
