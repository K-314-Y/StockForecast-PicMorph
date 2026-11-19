import {
  MARKET_PAPER_MODE, MARKET_SOURCE_ID, MARKET_SYMBOL, MOCK_MARKET_PAPER_MODE, MOCK_MARKET_SOURCE,
  TEST_FIXTURE_SOURCE, isEvidenceText, isMarketPrice, isObservationInterval, utcTime,
} from './forward-market-guard.mjs';

const adapters = new WeakMap();
const MAX_QUOTES = 200;

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
      if (!isEvidenceText(raw, 16_384) || !isEvidenceText(proof, 4096) || proof === TEST_FIXTURE_SOURCE) continue;
      const verified = synchronous(verifyRecord(Object.freeze({sourceId, raw, proof})));
      if (!verified || verified.sourceId !== sourceId || typeof verified.symbol !== 'string' ||
          !MARKET_SYMBOL.test(verified.symbol)) continue;
      const {symbol, price, market, valueKind, tradeAt, publishedAt} = verified;
      if (symbols.has(symbol)) throw new RangeError('観測バッチに重複銘柄があります');
      symbols.add(symbol);
      const delay = utcTime(publishedAt) - utcTime(tradeAt);
      if (market !== 'XTKS' || valueKind !== 'TRADE' || !isMarketPrice(price) ||
          !(delay >= 0 && delay <= maxPublicationDelayMs)) continue;
      const evidence = Object.freeze({market, valueKind, raw, proof, licenseRef});
      quotes[symbol] = Object.freeze({symbol, price, tradeAt, publishedAt, ingestedAt: observedAt, proof, evidence});
    }
    const providerPolicy = {
      sourceId, enabled: true, usageAuthorized: true, maxAgeMs,
      verifyQuote: quote => quote.sourceId === sourceId && Object.hasOwn(quotes, quote.symbol) &&
        Object.entries(quotes[quote.symbol]).every(([field, value]) => quote[field] === value),
      marketStatusAt: input => synchronous(marketStatusAt(input)),
    };
    return {observation: {sourceId, observedAt, quotes}, options: {providerPolicy, now: utcTime(stamp())}};
  }
  authorize();
  const handle = Object.freeze({});
  adapters.set(handle, Object.freeze({mode, authorize, stamp, observationIntervalMs, observe}));
  return handle;
}

export function getForwardMarketAdapter(handle) {
  return adapters.get(handle);
}
