import {randomUUID} from 'node:crypto';
import {isMarketPrice, MOCK_MARKET_SOURCE, utcTime} from './forward-market-guard.mjs';
import {deriveForwardCompanionModel} from './forward-model.mjs';
import {calculateForwardProbabilities} from './forward-predict.mjs';
import {forecastDirection, hasFields, scoreMockForecast} from './forward-score.mjs';

const scenarioFields = ['accountId', 'sourceMode', 'history', 'issuedAt', 'targetAt', 'targetPrice'];

function validateScenario(scenario) {
  if (!hasFields(scenario, scenarioFields) || scenario.sourceMode !== MOCK_MARKET_SOURCE ||
      !Array.isArray(scenario.history) || scenario.history.length < 9 || scenario.history.length > 200 ||
      !isMarketPrice(scenario.targetPrice)) throw new TypeError('Invalid friend practice scenario');

  const issued = utcTime(scenario.issuedAt);
  const target = utcTime(scenario.targetAt);
  let previous = -Infinity;
  const prices = [];
  for (const point of scenario.history) {
    const time = hasFields(point, ['at', 'price']) ? utcTime(point.at) : NaN;
    if (!(previous < time && time <= issued && issued < target) ||
        !isMarketPrice(point.price)) throw new RangeError('Invalid friend practice chronology');
    previous = time;
    prices.push(point.price);
  }
  return {
    prices, referenceAt:new Date(previous).toISOString(), issuedAt:new Date(issued).toISOString(),
    targetAt:new Date(target).toISOString(), targetPrice:scenario.targetPrice,
  };
}

function conflict(code) {
  throw Object.assign(new Error('Friend practice cannot advance'), {code});
}

/** One fixed, isolated round per opted-in account, for this process only. */
export function configureFriendPractice(scenarios, accounts, accessAccount) {
  if (!Array.isArray(scenarios) || scenarios.length > accounts.size) {
    throw new TypeError('Expected one optional friend practice scenario per account');
  }
  const entries = new Map();
  for (const scenario of scenarios) {
    const config = validateScenario(scenario);
    const {accountId} = scenario;
    if (!accounts.has(accountId) || entries.has(accountId)) {
      throw new TypeError('Unknown or duplicate friend practice account');
    }
    entries.set(accountId, {config, starting:false});
  }

  return {
    read(accountId) {
      const entry = entries.get(accountId);
      if (!entry) return {status:'unconfigured'};
      return entry.result ?? entry.round ?? {status:entry.starting ? 'starting' : 'ready'};
    },

    async start(accountId, expected, authorize) {
      authorize();
      const entry = entries.get(accountId);
      if (!entry) conflict('PRACTICE_UNCONFIGURED');
      if (entry.starting || entry.round) conflict('PRACTICE_STATE');
      entry.starting = true;
      try {
        const {companion} = await accessAccount(accountId, '/friend/character');
        authorize();
        if (!companion.created || companion.revision !== expected) conflict('PRACTICE_REVISION');
        const {model, model_version} = deriveForwardCompanionModel(companion);
        const {issuedAt, targetAt, prices} = entry.config;
        const probabilities = await calculateForwardProbabilities(model, prices);
        authorize();
        const {companion:current} = await accessAccount(accountId, '/friend/character');
        authorize();
        if (current.revision !== expected || !current.created ||
            current.approach !== companion.approach || current.risk_percent !== companion.risk_percent) {
          conflict('PRACTICE_REVISION');
        }
        entry.round = {
          status:'frozen', round_id:randomUUID(), companion_revision:expected, model_version,
          risk_percent:companion.risk_percent, issuedAt, targetAt, probabilities,
          direction:forecastDirection({probabilities}),
        };
        return entry.round;
      } finally {
        entry.starting = false;
      }
    },

    reveal(accountId, roundId, authorize) {
      authorize();
      const entry = entries.get(accountId);
      if (!entry) conflict('PRACTICE_UNCONFIGURED');
      if (!entry.round || entry.round.round_id !== roundId) conflict('PRACTICE_STATE');
      if (entry.result) return entry.result;
      const {round, config} = entry;
      const {issuedAt, targetAt, probabilities, round_id} = round;
      const referencePrice = config.prices.at(-1);
      const scored = scoreMockForecast({
        sourceMode:'TEST_ONLY', forecastId:round_id, symbol:'PRACT', issuedAt, targetAt, probabilities,
      }, {
        status:'OBSERVED', sourceMode:MOCK_MARKET_SOURCE, evidence:'Local fictional practice only',
        forecastId:round_id, symbol:'PRACT', targetAt, targetTradeAt:targetAt,
        referenceTradeAt:config.referenceAt, referencePrice, targetPrice:config.targetPrice,
      }, targetAt);

      entry.result = {...round, status:'exhausted', result:{
        referencePrice, targetPrice:config.targetPrice, scoredAt:targetAt,
        actualChangePct:scored.actualChangePct, actualDirection:scored.actualDirection,
        brier:scored.brier, directionCorrect:scored.directionCorrect,
      }};
      return entry.result;
    },
  };
}
