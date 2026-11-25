import test from 'node:test';
import assert from 'node:assert/strict';
import {buyAndHold, familyInterval, interval, missedRebound} from '../../scripts/benchmark-accessory-crash.mjs';

test('one initial purchase, one fee, unchanged units through a peak and drawdown', () => {
  const sha = 'a'.repeat(64);
  const model = {effective_sha256: sha, risk_fraction: .35, plugin_weights: {}, plugin_strengths: {}};
  const plan = {mode: 'PRACTICE_SYNTHETIC_ONLY', model_sha256: sha,
    models: {mine: model, owl: model, turtle: model}, initial_coins: 1000, fee_rate: .001,
    initial_price: 100, allocations: {mine: 100, owl: 0, turtle: 0}, future_prices: [120, 90, 110],
    signals: [{mine: 'CASH', owl: 'CASH', turtle: 'CASH'}]};
  const result = buyAndHold(plan);
  assert.equal(result.profit, 34.65);
  assert.equal(result.trades, 1);
  assert.equal(result.fees, .35);
  assert.ok(Math.abs(result.dd - 100 * (1 - 964.65 / 1069.65)) < 1e-10);
});

test('count only positive closes after shock, use position chosen before each move', () => {
  const steps = names => names.map(mine => ({mine}));
  const prices = [110, 90, 95, 95, 92, 96];
  const allMissed = steps(['LONG', 'LONG', 'CASH', 'LONG', 'LONG', 'CASH']);
  assert.deepEqual(missedRebound(prices, allMissed, 1), {up: 2, missed: 2, recovered: true, missedAll: true});
  const partial = steps(['LONG', 'LONG', 'LONG', 'CASH', 'CASH', 'CASH']);
  assert.deepEqual(missedRebound(prices, partial, 1), {up: 2, missed: 1, recovered: true, missedAll: false});
  assert.deepEqual(missedRebound([110, 90, 85], allMissed, 1),
    {up: 0, missed: 0, recovered: false, missedAll: false});
});

test('uncertainty uses parent means and sample variance', () => {
  const row = profit => ({glasses: {profit}, cash: {profit: 0}});
  const families = [{a: row(-10), b: row(12)}, {a: row(2), b: row(4)}];
  const actual = familyInterval(families, 'cash');
  assert.deepEqual(actual, interval([1, 3]));
  assert.equal(actual.mean, 2);
  assert.ok(Math.abs(actual.lower - .04) < 1e-12);
  assert.ok(Math.abs(actual.upper - 3.96) < 1e-12);
});
