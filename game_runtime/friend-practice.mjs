import {randomUUID} from 'node:crypto';
import {isMarketPrice, MOCK_MARKET_SOURCE, utcTime} from './forward-market-guard.mjs';
import {deriveForwardCompanionModel} from './forward-model.mjs';
import {calculateForwardProbabilities} from './forward-predict.mjs';
import {forecastDirection, hasFields, scoreMockForecast} from './forward-score.mjs';

const scenarioFields = ['sourceMode', 'history', 'issuedAt', 'targetAt', 'targetPrice'];
const MAX_ROUNDS = 12;

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

function campaignView(entry, view) {
  const total = entry.scenarios.length;
  if (total === 1) return view;
  const history = entry.history.map(({model_version, companion_revision, direction, result}, index) => ({
    round:index + 1, model_version, companion_revision, direction,
    actualDirection:result.actualDirection, directionCorrect:result.directionCorrect, brier:result.brier,
  }));
  const completed = history.length;
  const current = view.status === 'scored' || view.status === 'exhausted' ? completed : completed + 1;
  const judged = history.filter(round => round.directionCorrect !== null).length;
  const correct = history.filter(round => round.directionCorrect === true).length;
  const average_brier = completed ? history.reduce((sum, round) => sum + round.brier, 0) / completed : null;
  return {...view, progress:{current, total, completed, judged, correct, average_brier, hasNext:current < total}, history};
}

/** Fixed, isolated campaigns per opted-in account, for this process only. */
export function configureFriendPractice(scenarios, accounts, accessAccount) {
  if (!Array.isArray(scenarios) || scenarios.length > accounts.size) {
    throw new TypeError('Expected one optional friend practice configuration per account');
  }
  const entries = new Map();
  for (const input of scenarios) {
    const campaign = hasFields(input, ['accountId', 'rounds']);
    if (!campaign && !hasFields(input, ['accountId', ...scenarioFields])) {
      throw new TypeError('Invalid friend practice configuration');
    }
    const {accountId, ...config} = input;
    if (!accounts.has(accountId) || entries.has(accountId)) {
      throw new TypeError('Unknown or duplicate friend practice account');
    }
    const rounds = campaign ? config.rounds : [config];
    if (!Array.isArray(rounds) || rounds.length < 1 || rounds.length > MAX_ROUNDS) {
      throw new RangeError('Expected one to twelve friend practice rounds per account');
    }
    const queue = [];
    for (const scenario of rounds) {
      const next = validateScenario(scenario);
      const previous = queue.at(-1);
      if (previous && next.issuedAt <= previous.targetAt) {
        throw new RangeError('Duplicate or out-of-order friend practice scenario');
      }
      queue.push(next);
    }
    entries.set(accountId, {scenarios:queue, activeRound:null, history:[], starting:false});
  }

  return {
    read(accountId) {
      const entry = entries.get(accountId);
      if (!entry) return {status:'unconfigured'};
      const view = entry.starting ? {status:'starting'} :
        entry.activeRound ?? entry.history.at(-1) ?? {status:'ready'};
      return campaignView(entry, view);
    },

    async start(accountId, expected, authorize) {
      authorize();
      const entry = entries.get(accountId);
      if (!entry) conflict('PRACTICE_UNCONFIGURED');
      // The number of completed rounds is the cursor. Only reveal advances it.
      const config = entry.scenarios[entry.history.length];
      if (entry.starting || entry.activeRound || !config) conflict('PRACTICE_STATE');
      entry.starting = true;
      try {
        const {companion} = await accessAccount(accountId, '/friend/character');
        authorize();
        if (!companion.created || companion.revision !== expected) conflict('PRACTICE_REVISION');
        const {model, model_version} = deriveForwardCompanionModel(companion);
        const {issuedAt, targetAt, prices} = config;
        const probabilities = await calculateForwardProbabilities(model, prices);
        authorize();
        const {companion:current} = await accessAccount(accountId, '/friend/character');
        authorize();
        if (current.revision !== expected || !current.created ||
            current.approach !== companion.approach || current.risk_percent !== companion.risk_percent) {
          conflict('PRACTICE_REVISION');
        }
        entry.activeRound = Object.freeze({
          status:'frozen', round_id:randomUUID(), companion_revision:expected, model_version,
          risk_percent:companion.risk_percent, issuedAt, targetAt, probabilities:Object.freeze(probabilities),
          direction:forecastDirection({probabilities}),
        });
        return campaignView(entry, entry.activeRound);
      } finally {
        entry.starting = false;
      }
    },

    reveal(accountId, roundId, authorize) {
      authorize();
      const entry = entries.get(accountId);
      if (!entry) conflict('PRACTICE_UNCONFIGURED');
      if (entry.starting) conflict('PRACTICE_STATE');
      const round = entry.activeRound ?? entry.history.at(-1);
      if (!round || round.round_id !== roundId) conflict('PRACTICE_STATE');
      if (!entry.activeRound) return campaignView(entry, round);
      const config = entry.scenarios[entry.history.length];
      const {issuedAt, targetAt, probabilities, round_id} = round;
      const referencePrice = config.prices.at(-1);
      const scored = scoreMockForecast({
        sourceMode:'TEST_ONLY', forecastId:round_id, symbol:'PRACT', issuedAt, targetAt, probabilities,
      }, {
        status:'OBSERVED', sourceMode:MOCK_MARKET_SOURCE, evidence:'Local fictional practice only',
        forecastId:round_id, symbol:'PRACT', targetAt, targetTradeAt:targetAt,
        referenceTradeAt:config.referenceAt, referencePrice, targetPrice:config.targetPrice,
      }, targetAt);

      const result = Object.freeze({
        referencePrice, targetPrice:config.targetPrice, scoredAt:targetAt,
        actualChangePct:scored.actualChangePct, actualDirection:scored.actualDirection,
        brier:scored.brier, directionCorrect:scored.directionCorrect,
      });
      const index = entry.history.length + 1;
      const published = Object.freeze({...round, status:index === entry.scenarios.length ? 'exhausted' : 'scored', result});
      entry.history.push(published);
      entry.activeRound = null;
      return campaignView(entry, published);
    },
  };
}
