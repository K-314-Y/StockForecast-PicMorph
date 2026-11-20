import {execFile} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openForwardForecastStore} from './forward-forecast-store.mjs';
import {getForwardMarketAdapter} from './forward-market-adapter.mjs';
import {MARKET_SYMBOL, MOCK_MARKET_PAPER_MODE, utcTime} from './forward-market-guard.mjs';
import {identifyForwardModel} from './forward-model.mjs';
import {FORWARD_AI_ID} from './forward-paper.mjs';
import {forecastDirection, hasFields} from './forward-score.mjs';
import {readForwardSnapshot} from './forward-store.mjs';

const python = '/usr/bin/python3';
const bridge = fileURLToPath(new URL('./forward_predict_bridge.py', import.meta.url));
const cwd = fileURLToPath(new URL('../', import.meta.url));

/** Run the isolated model bridge using only the supplied historical prices. */
export function calculateForwardProbabilities(model, prices) {
  const input = JSON.stringify({model, prices});
  if (Buffer.byteLength(input) > 16 * 1024) throw new RangeError('Prediction input too large');
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error('Forward Python prediction failed'));
    const child = execFile(python, ['-I', '-B', '-S', bridge], {
      cwd, env:{}, encoding:'utf8', timeout:3000, killSignal:'SIGKILL', maxBuffer:1024,
    }, (error, stdout) => {
      if (error) return fail();
      try {
        const result = JSON.parse(stdout);
        if (!hasFields(result, ['probabilities'])) return fail();
        forecastDirection(result);
        resolve(result.probabilities);
      } catch {
        fail();
      }
    });
    child.stdin.once('error', fail);
    child.stdin.end(input);
  });
}

/**
 * Server-only, signed mock history. readHistory receives the server symbol
 * and as-of time and supplies only {raw, proof} envelopes, oldest first.
 * predict is read-only. freeze computes afresh and publishes through P3.
 */
export async function openForwardPredictor({
  walletFile, directory, marketAdapter, readHistory, clock, targetAt, symbol,
}) {
  const adapter = getForwardMarketAdapter(marketAdapter);
  const target = utcTime(targetAt);
  if (adapter?.mode !== MOCK_MARKET_PAPER_MODE ||
      typeof walletFile !== 'string' || !walletFile.trim() ||
      typeof directory !== 'string' || !directory.trim() ||
      typeof readHistory !== 'function' || typeof clock !== 'function' ||
      typeof symbol !== 'string' || !MARKET_SYMBOL.test(symbol) || !Number.isFinite(target)) {
    throw new RangeError('Explicit signed MOCK_NONLIVE prediction configuration is required');
  }
  walletFile = resolve(walletFile);
  const forecasts = await openForwardForecastStore({directory, walletFile, clock});

  function requireWindow(now, earliest = now) {
    if (!Number.isSafeInteger(now) || !(earliest <= now && now < target) ||
        Math.abs(now) > 8.64e15 || utcTime(new Date(now).toISOString()) !== now) {
      throw new RangeError('Invalid server clock or closed prediction window');
    }
    return now;
  }

  async function prepare(input, extra) {
    if (extra.length || !hasFields(input, ['aiId']) ||
        typeof input.aiId !== 'string' || !FORWARD_AI_ID.test(input.aiId)) {
      throw new RangeError('Prediction selection must specify only a saved AI ID');
    }
    const {aiId} = input;
    const {ledger} = await readForwardSnapshot(walletFile);
    const generation = ledger.appearanceGenerations?.find(item => item.aiId === aiId);
    if (ledger.mode !== MOCK_MARKET_PAPER_MODE || ledger.observationIntervalMs !== adapter.observationIntervalMs ||
        !generation || !Object.hasOwn(ledger.wallets, aiId)) {
      throw new RangeError('Prediction requires a saved MOCK_NONLIVE wallet generation');
    }
    const {model, model_version, modelHash} = identifyForwardModel(generation);
    if (modelHash !== ledger.wallets[aiId].modelHash) throw new RangeError('Saved model hash mismatch');
    const startedAt = requireWindow(clock());
    adapter.authorize();
    const rows = await readHistory(Object.freeze({symbol, throughAt:new Date(startedAt).toISOString()}));
    const {prices, reference} = adapter.verifyMockHistory(rows, symbol, startedAt);
    if (prices.length < model.slow_window) throw new RangeError('Insufficient history for the saved model');
    const checkedAt = requireWindow(clock(), startedAt);
    const probabilities = await calculateForwardProbabilities(model, prices);
    const completedAt = requireWindow(clock(), checkedAt);
    function verifyMockReference(at) {
      requireWindow(at, completedAt);
      return adapter.verifyMockHistoryReference(reference, symbol, at);
    }
    verifyMockReference(completedAt);
    return {forecast:{aiId, modelHash, model_version, symbol, targetAt, sourceMode:'TEST_ONLY', probabilities},
      verifyMockReference};
  }

  return Object.freeze({
    async predict(input, ...extra) {
      const {forecast:{probabilities}} = await prepare(input, extra);
      return {probabilities};
    },
    async freeze(input, ...extra) {
      const {forecast, verifyMockReference} = await prepare(input, extra);
      return forecasts.freeze(forecast, {verifyMockReference});
    },
  });
}
