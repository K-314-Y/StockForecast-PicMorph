import {APPEARANCE_MODEL_VERSION} from './appearance-model.mjs';
import {MARKET_SYMBOL, MOCK_MARKET_PAPER_MODE, MOCK_MARKET_SOURCE, utcTime} from './forward-market-guard.mjs';
import {mockForecastOrderId} from './forward-mock-lifecycle.mjs';
import {FORWARD_AI_ID} from './forward-paper.mjs';
import {forecastDirection} from './forward-score.mjs';

const hash = /^[a-f0-9]{64}$/;
const unconnected = () => ({status:'unconnected', records:[]});
const directions = ['UP', 'FLAT', 'DOWN'];

function readOrder(ledger, forecast, receipt, action) {
  const orderId = mockForecastOrderId(forecast.forecastId, action);
  const event = ledger.journal.find(item => item.orderId === orderId);
  const queued = ledger.pending.find(item => item.id === orderId);
  const item = event ?? queued;
  if (!item) return {status:'NONE', at:null};
  if (item.aiId !== forecast.aiId) throw Error('Order belongs to a different AI');
  if (event?.kind === 'CANCELLED') {
    return {status:'CANCELLED', at:new Date(utcTime(event.observedAt)).toISOString()};
  }
  // Pending orders bind to the already checked wallet model; only fills store their own hash.
  if (item.symbol !== forecast.symbol ||
      item.mockForecast?.forecastSha256 !== receipt.forecastSha256 ||
      item.mockForecast.targetAt !== forecast.targetAt ||
      (event && (event.modelHash !== forecast.modelHash ||
        event.kind !== (action === 'open' ? 'OPENED' : 'CLOSED') ||
        event.sourceId !== MOCK_MARKET_SOURCE))) {
    throw Error('Order does not match the confirmed forecast');
  }
  return {status:event?.kind ?? 'QUEUED',
    at:new Date(utcTime(event?.tradeAt ?? queued.receivedAt)).toISOString()};
}

function readScore(outcome, receipt, open, close) {
  if (outcome === null) return null;
  if (outcome?.status !== 'SCORED_MOCK_NONLIVE' || outcome.sourceMode !== MOCK_MARKET_SOURCE ||
      outcome.forecastId !== receipt.forecastId || outcome.forecastSha256 !== receipt.forecastSha256 ||
      open.status !== 'OPENED' || close.status !== 'CLOSED' ||
      utcTime(close.at) !== utcTime(outcome.observation?.targetTradeAt)) {
    throw Error('Mock score does not match the orders');
  }
  const {brier, directionCorrect, actualDirection, absoluteChangeErrorPctPoints} = outcome.score;
  if (!Number.isFinite(brier) || brier < 0 || brier > 2 ||
      !(directionCorrect === null || typeof directionCorrect === 'boolean') ||
      !directions.includes(actualDirection) ||
      !(absoluteChangeErrorPctPoints === null ||
        (Number.isFinite(absoluteChangeErrorPctPoints) && absoluteChangeErrorPctPoints >= 0))) {
    throw Error('Invalid mock score');
  }
  return {brier, directionCorrect, actualDirection, absoluteChangeErrorPctPoints,
    scoredAt:new Date(utcTime(outcome.scoredAt)).toISOString()};
}

/** Test-only dependency. The source verifies saved evidence and exposes a read-only wallet snapshot. */
export function createForwardRecordReader(config) {
  if (config === undefined) return unconnected;
  const {forecastId, source} = config;
  if (typeof forecastId !== 'string' || !hash.test(forecastId) ||
      typeof source?.read !== 'function' || typeof source.snapshot !== 'function') {
    throw new TypeError('Expected a fixed forecast ID and a read-only P4 source');
  }
  return async () => {
    const saved = await source.read(forecastId);
    if (saved === null) return unconnected();
    const {forecast, receipt, outcome} = saved;
    if (forecast.forecastId !== forecastId || receipt.forecastId !== forecastId ||
        typeof receipt.forecastSha256 !== 'string' || !hash.test(receipt.forecastSha256)) {
      throw Error('Invalid saved forecast identity');
    }
    if (forecast.sourceMode !== 'TEST_ONLY') return unconnected();
    const {ledger} = await source.snapshot(saved);
    const {aiId, model_version, symbol, targetAt} = forecast;
    if (ledger.mode !== MOCK_MARKET_PAPER_MODE || typeof aiId !== 'string' || !FORWARD_AI_ID.test(aiId) ||
        typeof model_version !== 'string' || !APPEARANCE_MODEL_VERSION.test(model_version) ||
        typeof symbol !== 'string' || !MARKET_SYMBOL.test(symbol) ||
        !ledger.appearanceGenerations.some(item => item.aiId === aiId && item.model_version === model_version) ||
        !Object.hasOwn(ledger.wallets, aiId) || ledger.wallets[aiId].modelHash !== forecast.modelHash) {
      throw Error('Forecast does not match the mock wallet');
    }
    const open = readOrder(ledger, forecast, receipt, 'open');
    const close = readOrder(ledger, forecast, receipt, 'close');
    if (close.status !== 'NONE' && open.status !== 'OPENED') throw Error('Missing mock entry');
    const score = readScore(outcome, receipt, open, close);
    const realizedPnl = close.status === 'CLOSED' ?
      ledger.journal.find(item => item.orderId === mockForecastOrderId(forecastId, 'close')).realizedPnl : null;
    if (close.status === 'CLOSED' && !Number.isFinite(realizedPnl)) throw Error('Invalid realized medal result');
    return {status:'MOCK_NONLIVE', records:[{
      aiId, model_version, symbol, sourceMode:'MOCK_NONLIVE',
      confirmedAt:new Date(utcTime(receipt.confirmedAt)).toISOString(),
      targetAt:new Date(utcTime(targetAt)).toISOString(),
      direction:forecastDirection(forecast),
      predictedChangePct:forecast.predictedChangePct ?? null,
      open, close, realizedPnl, score,
      status:score ? 'SCORED_MOCK_NONLIVE' : 'PENDING',
    }]};
  };
}
