import {createHash} from 'node:crypto';
import {
  MARKET_PAPER_MODE, MARKET_SOURCE_ID, MARKET_SYMBOL, MOCK_MARKET_PAPER_MODE, MOCK_MARKET_SOURCE,
  TEST_FIXTURE_SOURCE, guardMarketQuotes, isEvidenceText, isMarketPrice, isObservationInterval, utcTime,
} from './forward-market-guard.mjs';
import {hasFields} from './forward-score.mjs';

const adapters = new WeakMap();
const MAX_QUOTES = 200;

// Bind the exact source text and proof, without copying them into the forecast.
export const mockReferenceSha256 = ({raw, proof}) =>
  createHash('sha256').update(JSON.stringify([raw, proof])).digest('hex');

function synchronous(result) {
  if (typeof result?.then === 'function') {
    Promise.resolve(result).catch(() => {});
    throw new TypeError('市場の検証コールバックは同期処理が必要です');
  }
  return result;
}

/**
 * Server-only seam. readBatch returns up to 200 {raw, proof} envelopes containing
 * exact UTF-8 source text and independently verifiable provider evidence.
 * verifyRecord must authenticate the source AND derive the canonical fields from
 * that evidence, returning null if it cannot confirm them. verifyUsage must
 * confirm permission to use and retain the record for this purpose. The
 * calendar must know both the trading session and individual symbol halts.
 * Only readBatch may be asynchronous. No provider, calendar or licence is
 * supplied by default. External data integration and actual market operation
 * remain unimplemented, and server startup never creates this adapter.
 */
export function createForwardMarketAdapter({
  sourceId, licenseRef, observationIntervalMs, maxAgeMs, maxPublicationDelayMs,
  readBatch, verifyRecord, verifyUsage, marketStatusAt, clock = Date.now,
} = {}) {
  if (typeof sourceId !== 'string' || !MARKET_SOURCE_ID.test(sourceId) || sourceId === TEST_FIXTURE_SOURCE ||
      !isEvidenceText(licenseRef, 256) || !isObservationInterval(observationIntervalMs) ||
      !Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0 ||
      !Number.isSafeInteger(maxPublicationDelayMs) || maxPublicationDelayMs < 0 ||
      maxPublicationDelayMs > maxAgeMs ||
      [readBatch, verifyRecord, verifyUsage, marketStatusAt, clock].some(fn => typeof fn !== 'function')) {
    throw new RangeError('市場観測元の利用許可または検証設定がありません');
  }
  const mode = sourceId === MOCK_MARKET_SOURCE ? MOCK_MARKET_PAPER_MODE : MARKET_PAPER_MODE;
  const usage = Object.freeze({sourceId, licenseRef, mode});
  function authorize() {
    if (synchronous(verifyUsage(usage)) !== true) throw new RangeError('市場観測元の利用許可を確認できません');
  }
  function stamp() {
    const time = clock();
    if (!Number.isSafeInteger(time) || Math.abs(time) > 8.64e15 ||
        !Number.isFinite(utcTime(new Date(time).toISOString()))) {
      throw new RangeError('サーバー時計の時刻が不正です');
    }
    return new Date(time).toISOString();
  }
  function verifyTrade({raw, proof} = {}) {
    if (!isEvidenceText(raw, 16_384) || !isEvidenceText(proof, 4096) || proof === TEST_FIXTURE_SOURCE) return null;
    const verified = synchronous(verifyRecord(Object.freeze({sourceId, raw, proof})));
    if (!verified || verified.sourceId !== sourceId || typeof verified.symbol !== 'string' ||
        !MARKET_SYMBOL.test(verified.symbol)) return null;
    return verified;
  }
  function isTrade({market, valueKind, price, tradeAt, publishedAt}) {
    const delay = utcTime(publishedAt) - utcTime(tradeAt);
    return market === 'XTKS' && valueKind === 'TRADE' && isMarketPrice(price) &&
      delay >= 0 && delay <= maxPublicationDelayMs;
  }
  function mockReference(envelope, symbol) {
    authorize();
    const reference = mode === MOCK_MARKET_PAPER_MODE && verifyTrade(envelope ?? undefined);
    if (!reference || reference.symbol !== symbol || !isTrade(reference)) {
      throw new RangeError('Invalid signed MOCK_NONLIVE reference trade');
    }
    return reference;
  }
  function policyFor(verifyQuote) {
    return {sourceId, enabled:true, usageAuthorized:true, maxAgeMs, verifyQuote,
      marketStatusAt:input => synchronous(marketStatusAt(input))};
  }
  function requireOpenTrade(trade, proof, now) {
    const {symbol, price, tradeAt, publishedAt} = trade;
    // Only trades already authenticated by mockReference reach this check.
    const quote = {symbol, price, tradeAt, publishedAt, proof, ingestedAt:new Date(now).toISOString()};
    if (!guardMarketQuotes({sourceId, quotes:{[symbol]:quote}}, now, {}, policyFor(() => true), now).has(symbol)) {
      throw new RangeError('MOCK_NONLIVE trade is stale or market status is not OPEN');
    }
  }
  function verifyMockHistoryReference(reference, symbol, now) {
    requireOpenTrade(mockReference(reference, symbol), reference.proof, now);
    return mockReferenceSha256(reference);
  }
  function verifyMockHistory(rows, symbol, now) {
    const count = Array.isArray(rows) ? rows.length : 0;
    if (count < 1 || count > MAX_QUOTES) {
      throw new RangeError('Invalid MOCK_NONLIVE history size');
    }
    let previousTrade = -Infinity;
    let previousPublication = -Infinity;
    const prices = [];
    let reference;
    let latest;
    for (let index = 0; index < count; index++) {
      const row = rows[index];
      if (!hasFields(row, ['raw', 'proof'])) throw new RangeError('Expected a signed history envelope');
      reference = Object.freeze({...row});
      const trade = mockReference(reference, symbol);
      const stamp = utcTime(trade.tradeAt);
      const publication = utcTime(trade.publishedAt);
      if (!(previousTrade < stamp && previousPublication <= publication && publication <= now)) {
        throw new RangeError('History is out of order or was not yet published');
      }
      requireOpenTrade(trade, reference.proof, publication);
      previousTrade = stamp;
      previousPublication = publication;
      prices.push(trade.price);
      latest = trade;
    }
    requireOpenTrade(latest, reference.proof, now);
    return {prices, reference};
  }
  function mockForecastTrades(event) {
    const {evidence, mockForecast, sourceId: eventSource, symbol} = event;
    const reference = mockReference(mockForecast.reference, symbol);
    const trade = evidence && verifyTrade(evidence);
    // The signed execution row names the exact signed reference of this fixture.
    if (!trade || !isTrade(trade) || eventSource !== MOCK_MARKET_SOURCE ||
        evidence.licenseRef !== licenseRef || trade.referenceProof !== mockForecast.reference.proof ||
        !['symbol', 'price', 'tradeAt', 'publishedAt'].every(key => trade[key] === event[key])) {
      throw new RangeError('Signed MOCK_NONLIVE trade does not match the ledger or reference');
    }
    return {reference, trade};
  }
  async function observe() {
    authorize();
    const rows = await readBatch();
    const observedAt = stamp();
    authorize();
    if (!Array.isArray(rows) || rows.length > MAX_QUOTES) throw new RangeError('市場観測バッチが不正です');
    const quotes = Object.create(null);
    const symbols = new Set();
    for (const row of rows) {
      const {raw, proof} = row ?? {};
      const verified = verifyTrade({raw, proof});
      if (!verified) continue;
      const {symbol, price, market, valueKind, tradeAt, publishedAt} = verified;
      if (symbols.has(symbol)) throw new RangeError('観測バッチに重複銘柄があります');
      symbols.add(symbol);
      if (!isTrade(verified)) continue;
      const evidence = Object.freeze({market, valueKind, raw, proof, licenseRef});
      quotes[symbol] = Object.freeze({symbol, price, tradeAt, publishedAt, ingestedAt: observedAt, proof, evidence});
    }
    const providerPolicy = policyFor(quote => quote.sourceId === sourceId && Object.hasOwn(quotes, quote.symbol) &&
      Object.entries(quotes[quote.symbol]).every(([field, value]) => quote[field] === value));
    return {observation: {sourceId, observedAt, quotes}, options: {providerPolicy, now: utcTime(stamp())}};
  }
  authorize();
  const handle = Object.freeze({});
  adapters.set(handle, Object.freeze({mode, authorize, stamp, observationIntervalMs, observe,
    mockReference, mockForecastTrades, verifyMockHistory, verifyMockHistoryReference}));
  return handle;
}

export function getForwardMarketAdapter(handle) {
  return adapters.get(handle);
}
