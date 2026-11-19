import {isEvidenceText, isMarketPrice, MOCK_MARKET_SOURCE, utcTime} from './forward-market-guard.mjs';

const DIRECTIONS = ['UP', 'FLAT', 'DOWN'];

export function hasFields(value, required, optional = []) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return required.every(key => Object.hasOwn(descriptors, key)) &&
    Reflect.ownKeys(descriptors).every(key =>
      (required.includes(key) || optional.includes(key)) &&
      Object.hasOwn(descriptors[key], 'value') && descriptors[key].enumerable);
}

function directionOf(change) {
  return change > 0 ? 'UP' : change < 0 ? 'DOWN' : 'FLAT';
}

/** Return the declared class, the class implied by predictedChangePct, or the unique mode.
 * Equal maxima without a declaration or point estimate leave direction uncalled.
 */
export function forecastDirection({probabilities, direction, predictedChangePct}) {
  if (!hasFields(probabilities, DIRECTIONS) ||
      !DIRECTIONS.every(key => Number.isFinite(probabilities[key]) &&
        probabilities[key] >= 0 && probabilities[key] <= 1) ||
      Math.abs(probabilities.UP + probabilities.FLAT + probabilities.DOWN - 1) > 1e-12) {
    throw new RangeError('UP/FLAT/DOWN probabilities must be in [0, 1] and sum to 1');
  }
  if (direction !== undefined && !DIRECTIONS.includes(direction)) {
    throw new RangeError('Invalid forecast direction');
  }
  if (predictedChangePct !== undefined &&
      !(Number.isFinite(predictedChangePct) && predictedChangePct > -100 && predictedChangePct <= 10_000)) {
    throw new RangeError('Predicted change must be in (-100, 10000] percent');
  }
  const pointDirection = predictedChangePct === undefined ? undefined : directionOf(predictedChangePct);
  const max = Math.max(probabilities.UP, probabilities.FLAT, probabilities.DOWN);
  const leaders = DIRECTIONS.filter(key => probabilities[key] === max);
  const called = direction ?? pointDirection;
  if ((called !== undefined && !leaders.includes(called)) ||
      (pointDirection !== undefined && called !== pointDirection)) {
    throw new RangeError('Probabilities, direction and predicted change disagree');
  }
  return called ?? (leaders.length === 1 ? leaders[0] : null);
}

/** Pure calculation for a verified frozen forecast and a server-owned synthetic observation. */
export function scoreMockForecast(forecast, observation, scoredAt) {
  if (forecast.sourceMode !== 'TEST_ONLY') throw new RangeError('Market scoring is closed');
  if (!hasFields(observation, ['status', 'sourceMode', 'evidence', 'forecastId', 'symbol',
    'targetAt', 'referenceTradeAt', 'referencePrice', 'targetTradeAt', 'targetPrice']) ||
    observation.sourceMode !== MOCK_MARKET_SOURCE || observation.status !== 'OBSERVED' ||
    !isEvidenceText(observation.evidence, 256) || !observation.evidence.trim()) {
    throw new RangeError('An observed MOCK_NONLIVE fixture with evidence is required');
  }
  const issued = utcTime(forecast.issuedAt);
  const target = utcTime(forecast.targetAt);
  if (observation.forecastId !== forecast.forecastId || observation.symbol !== forecast.symbol ||
    utcTime(observation.targetAt) !== target) {
    throw new RangeError('Observation does not match forecast ID, symbol and target');
  }
  if (!(utcTime(observation.referenceTradeAt) <= issued && issued < target &&
    utcTime(observation.targetTradeAt) === target && target <= utcTime(scoredAt))) {
    throw new RangeError('Observation times do not match the forecast window');
  }
  const {referencePrice, targetPrice} = observation;
  if (!isMarketPrice(referencePrice) || !isMarketPrice(targetPrice)) {
    throw new RangeError('Invalid mock trade price');
  }

  const actualChangePct = (targetPrice - referencePrice) / referencePrice * 100;
  const actualDirection = directionOf(actualChangePct);
  const predictedDirection = forecastDirection(forecast);
  const brier = DIRECTIONS.reduce((sum, key) =>
    sum + (forecast.probabilities[key] - Number(key === actualDirection)) ** 2, 0);
  return {
    actualDirection, actualChangePct, brier, predictedDirection,
    directionCorrect: predictedDirection === null ? null : predictedDirection === actualDirection,
    absoluteChangeErrorPctPoints: forecast.predictedChangePct === undefined ? null :
      Math.abs(forecast.predictedChangePct - actualChangePct),
  };
}
