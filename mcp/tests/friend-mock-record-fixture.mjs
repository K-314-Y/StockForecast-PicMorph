import {createHmac} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {createForwardMarketAdapter} from '../../game_runtime/forward-market-adapter.mjs';
import {MOCK_MARKET_PAPER_MODE, MOCK_MARKET_SOURCE} from '../../game_runtime/forward-market-guard.mjs';
import {openForwardMockLifecycle} from '../../game_runtime/forward-mock-lifecycle.mjs';
import {deriveForwardCompanionModel} from '../../game_runtime/forward-model.mjs';
import {openForwardStore, saveForwardGeneration} from '../../game_runtime/forward-store.mjs';

// Drive a complete P4 round with local signed synthetic trades. The friend GET
// must reverify stored evidence without asking this adapter for another batch.
export async function provisionFriendMockRound(walletFile, {
  companion, targetPrice = 108, pending = false, predictedChangePct,
}) {
  const directory = join(dirname(walletFile), 'forecasts');
  await mkdir(directory, {mode:0o700});
  const issue = Date.parse('2030-01-07T01:00:00Z');
  const target = issue + 10 * 60_000;
  const state = {now:issue, rows:[], reads:0, allowed:true};
  const sign = raw => createHmac('sha256', 'P9f public test fixture').update(raw).digest('hex');
  function trade(time, price, extra) {
    const at = new Date(time).toISOString();
    const raw = JSON.stringify({sourceId:MOCK_MARKET_SOURCE, market:'XTKS', symbol:'FAKE', valueKind:'TRADE',
      price, tradeAt:at, publishedAt:at, ...extra});
    return {raw, proof:sign(raw)};
  }
  const reference = trade(issue - 60_000, 100);
  const marketAdapter = createForwardMarketAdapter({sourceId:MOCK_MARKET_SOURCE, licenseRef:'Local P9f fixture',
    observationIntervalMs:5 * 60_000, maxAgeMs:10 * 60_000, maxPublicationDelayMs:60_000,
    clock:() => state.now, verifyUsage:() => state.allowed, marketStatusAt:() => 'OPEN',
    verifyRecord:({raw, proof}) => sign(raw) === proof ? JSON.parse(raw) : null,
    readBatch:() => { state.reads++; return state.rows; },
  });
  const generation = deriveForwardCompanionModel(companion);
  await openForwardStore({filePath:walletFile, marketAdapter, initial:{mode:MOCK_MARKET_PAPER_MODE,
    initialMedals:1000, allocations:[{id:'control', modelHash:'a'.repeat(64), medals:100}]}});
  await saveForwardGeneration({filePath:walletFile, aiId:'shared_ai', medals:300, generation, expectedRevision:0});
  const options = {walletFile, directory, marketAdapter, reference, margin:100, leverage:1};
  const lifecycle = await openForwardMockLifecycle(options);
  const direction = predictedChangePct < 0 ? 'DOWN' : predictedChangePct === 0 ? 'FLAT' : 'UP';
  const probabilities = {UP:.1, FLAT:.1, DOWN:.1, [direction]:.8};
  const {receipt:{forecastId}} = await lifecycle.freeze({aiId:'shared_ai', modelHash:generation.modelHash,
    model_version:generation.model_version, sourceMode:'TEST_ONLY', symbol:'FAKE',
    targetAt:new Date(target).toISOString(), probabilities,
    ...(predictedChangePct === undefined ? {} : {predictedChangePct}),
  });
  async function fill(time, price) {
    state.now = time;
    state.rows = [trade(time, price, {referenceProof:reference.proof})];
    await lifecycle.applyBatch();
  }
  await lifecycle.reserveOpen(forecastId);
  async function finish(afterOpen) {
    await fill(issue + 5 * 60_000, 100);
    await afterOpen?.(forecastId);
    await lifecycle.reserveClose(forecastId);
    await fill(target, targetPrice);
    await lifecycle.score(forecastId);
  }
  if (!pending) await finish();
  return {state, options, config:{forecastId, source:lifecycle.recordSource}, finish};
}

export function friendPracticeScenario(accountId, targetPrice = 129) {
  return {
    accountId, sourceMode:MOCK_MARKET_SOURCE,
    history:[100, 103, 101, 104, 106, 108, 105, 109, 112, 116, 118, 120].map((price, i) => ({
      at:new Date(Date.UTC(2030, 0, 7, 1, i)).toISOString(), price,
    })),
    issuedAt:'2030-01-07T01:12:00.000Z', targetAt:'2030-01-07T01:18:00.000Z', targetPrice,
  };
}
