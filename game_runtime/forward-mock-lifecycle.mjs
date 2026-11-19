import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {openForwardForecastStore} from './forward-forecast-store.mjs';
import {getForwardMarketAdapter, mockReferenceSha256} from './forward-market-adapter.mjs';
import {MOCK_MARKET_PAPER_MODE, MOCK_MARKET_SOURCE, utcTime} from './forward-market-guard.mjs';
import {MAX_FORWARD_MEDALS} from './forward-paper.mjs';
import {forecastDirection} from './forward-score.mjs';
import {openForwardStore} from './forward-store.mjs';

// A full 256-bit ID fits the paper ledger's 60-character order ID limit.
export const mockForecastOrderId = (forecastId, action) => `p4_${action}_${Buffer.from(forecastId, 'hex').toString('base64url')}`;
const orderRoute = {UP:'OPEN_LONG', DOWN:'OPEN_SHORT'};
const recordContexts = new WeakMap();

// Authenticate the read-only source and keep its server configuration tied to it.
export const getForwardMockRecordContext = source => recordContexts.get(source);

function requireModel(ledger, forecast) {
  const generation = ledger.appearanceGenerations?.find(item => item.aiId === forecast.aiId);
  if (forecast.sourceMode !== 'TEST_ONLY' || ledger.mode !== MOCK_MARKET_PAPER_MODE ||
      generation?.model_version !== forecast.model_version ||
      ledger.wallets[forecast.aiId]?.modelHash !== forecast.modelHash) {
    throw new RangeError('TEST_ONLY forecast must match the MOCK_NONLIVE wallet model generation');
  }
}

function requireReference(reference, forecast, envelope) {
  if (!(utcTime(reference.tradeAt) <= utcTime(reference.publishedAt) &&
        utcTime(reference.publishedAt) <= utcTime(forecast.issuedAt))) {
    throw new RangeError('Signed MOCK_NONLIVE reference must have been published by forecast issuance');
  }
  const boundReference = forecast.provenance.mockReferenceSha256;
  if (boundReference !== undefined && mockReferenceSha256(envelope) !== boundReference) {
    throw new RangeError('Signed MOCK_NONLIVE reference differs from the frozen prediction reference');
  }
}

/**
 * Internal test seam for a dedicated mock ledger. The fixture verifier derives
 * referenceProof from signed execution rows. Reserve the close after entry,
 * while a batch at or before targetAt is still eligible to accept the order.
 */
export async function openForwardMockLifecycle({
  walletFile, directory, marketAdapter, reference, margin, leverage,
}) {
  const adapter = getForwardMarketAdapter(marketAdapter);
  if (adapter?.mode !== MOCK_MARKET_PAPER_MODE || typeof walletFile !== 'string' || !walletFile.trim() ||
      !Number.isSafeInteger(margin) || margin < 1 || margin > MAX_FORWARD_MEDALS ||
      !Number.isSafeInteger(leverage) || leverage < 1 || leverage > 25) {
    throw new RangeError('Explicit MOCK_NONLIVE adapter, wallet and virtual order settings are required');
  }
  reference = structuredClone(reference);
  const paper = await openForwardStore({filePath:walletFile, marketAdapter});

  function forecastFill(ledger, forecast, receipt, action, notBefore) {
    const event = ledger.journal.find(item => item.orderId === mockForecastOrderId(forecast.forecastId, action));
    if (!event || event.kind === 'CANCELLED') return null;
    const opening = action === 'open';
    const target = utcTime(forecast.targetAt);
    if (event.kind !== (opening ? 'OPENED' : 'CLOSED') ||
        event.aiId !== forecast.aiId || event.symbol !== forecast.symbol ||
        event.modelHash !== forecast.modelHash ||
        event.mockForecast?.forecastSha256 !== receipt.forecastSha256 ||
        event.mockForecast.targetAt !== forecast.targetAt ||
        (opening ? !(utcTime(event.observedAt) < target) : utcTime(event.tradeAt) !== target) ||
        !(utcTime(notBefore) <= utcTime(event.receivedAt) && utcTime(event.receivedAt) < target)) {
      throw new RangeError('MOCK_NONLIVE fill does not match the confirmed forecast');
    }
    return event;
  }

  async function readMockEvidence(forecast, receipt, {readOnly = false} = {}) {
    const {ledger} = await paper.snapshot({readOnly});
    requireModel(ledger, forecast);
    const opened = forecastFill(ledger, forecast, receipt, 'open', receipt.confirmedAt);
    if (!opened) return null;
    const closed = forecastFill(ledger, forecast, receipt, 'close', opened.observedAt);
    if (!closed) return null;
    const {reference} = adapter.mockForecastTrades(opened);
    const {trade} = adapter.mockForecastTrades(closed);
    if (closed.mockForecast.reference.raw !== opened.mockForecast.reference.raw ||
        closed.mockForecast.reference.proof !== opened.mockForecast.reference.proof) {
      throw new RangeError('MOCK_NONLIVE opening and settlement refer to different signed scenarios');
    }
    requireReference(reference, forecast, opened.mockForecast.reference);
    const evidence = createHash('sha256').update(JSON.stringify([opened, closed])).digest('hex');
    return {observedAt:closed.observedAt, observation:{
      evidence:`MOCK_NONLIVE:sha256:${evidence}`, status:'OBSERVED', sourceMode:MOCK_MARKET_SOURCE,
      forecastId:forecast.forecastId, symbol:forecast.symbol, targetAt:forecast.targetAt,
      referenceTradeAt:reference.tradeAt, referencePrice:reference.price,
      targetTradeAt:trade.tradeAt, targetPrice:trade.price,
    }};
  }

  const forecasts = await openForwardForecastStore({directory, walletFile,
    clock:() => utcTime(adapter.stamp()), readMockEvidence});

  async function load(forecastId) {
    const saved = await forecasts.read(forecastId);
    if (!saved) throw new RangeError('No confirmed forecast for MOCK_NONLIVE');
    return saved;
  }

  const lifecycle = {
    freeze: forecasts.freeze,
    read: forecasts.read,
    snapshot: paper.snapshot,
    recordSource: Object.freeze({
      read: forecastId => forecasts.read(forecastId, {readOnly:true}),
      async snapshot({forecast, receipt}) {
        const saved = await paper.snapshot({readOnly:true});
        const {ledger} = saved;
        requireModel(ledger, forecast);
        const opened = forecastFill(ledger, forecast, receipt, 'open', receipt.confirmedAt);
        const closed = forecastFill(ledger, forecast, receipt, 'close', opened?.observedAt);
        if (closed && (closed.mockForecast.reference.raw !== opened?.mockForecast.reference.raw ||
          closed.mockForecast.reference.proof !== opened?.mockForecast.reference.proof)) {
          throw new RangeError('MOCK_NONLIVE opening and settlement refer to different signed scenarios');
        }
        for (const event of [opened, closed]) {
          if (event) requireReference(adapter.mockForecastTrades(event).reference, forecast, event.mockForecast.reference);
        }
        const pending = ledger.pending.find(order => ['open', 'close'].some(action =>
          order.id === mockForecastOrderId(forecast.forecastId, action)));
        if (pending) {
          const envelope = pending.mockForecast.reference;
          requireReference(adapter.mockReference(envelope, forecast.symbol), forecast, envelope);
        }
        return saved;
      },
    }),
    async reserveOpen(forecastId) {
      const {forecast, receipt} = await load(forecastId);
      const {ledger, revision} = await paper.snapshot();
      requireModel(ledger, forecast);
      const action = orderRoute[forecastDirection(forecast)];
      if (!action) return {action:'NO_TRADE'};
      requireReference(adapter.mockReference(reference, forecast.symbol), forecast, reference);
      const {aiId, symbol, targetAt} = forecast;
      const id = mockForecastOrderId(forecastId, 'open');
      const binding = {forecastSha256:receipt.forecastSha256, targetAt, reference};
      const next = await paper.reserveMockForecastOrder({id, aiId, symbol, action, margin, leverage},
        binding, {notBefore:receipt.confirmedAt, expectedRevision:revision});
      return {action, orderId:id, ...next};
    },
    async applyBatch() {
      const {revision} = await paper.snapshot();
      return paper.applyForwardBatch(revision);
    },
    score: forecasts.scoreMock,
    async reserveClose(forecastId) {
      const {forecast, receipt} = await load(forecastId);
      const {ledger, revision} = await paper.snapshot();
      requireModel(ledger, forecast);
      const opened = forecastFill(ledger, forecast, receipt, 'open', receipt.confirmedAt);
      const {aiId, symbol} = forecast;
      if (!opened || ledger.wallets[aiId].position?.openedAt !== opened.observedAt) {
        throw new RangeError('No open position for this MOCK_NONLIVE forecast');
      }
      const {reference} = adapter.mockForecastTrades(opened);
      requireReference(reference, forecast, opened.mockForecast.reference);
      const id = mockForecastOrderId(forecastId, 'close');
      const next = await paper.reserveMockForecastOrder({id, aiId, symbol, action:'CLOSE'}, opened.mockForecast,
        {notBefore:opened.observedAt, expectedRevision:revision});
      return {action:'CLOSE', orderId:id, ...next};
    },
  };
  recordContexts.set(lifecycle.recordSource, Object.freeze({walletFile:resolve(walletFile), directory:resolve(directory),
    adapter, reference:Object.freeze(reference)}));
  return lifecycle;
}
