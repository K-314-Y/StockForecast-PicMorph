import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runSyntheticGame, validateAllocations} from '../../game_runtime/practice.mjs';

const cwd = fileURLToPath(new URL('../..', import.meta.url));
const oracle = JSON.parse(execFileSync('python3', ['-B', 'tests/practice_parity_fixture.py'], {
  cwd, encoding: 'utf8', timeout: 10000
}));

function assertEquivalent(actual, expected, label = '') {
  if (typeof expected === 'number') {
    assert.ok(Math.abs(actual - expected) <= 1e-7,
      `${label}: expected ${expected}, got ${actual}`);
  } else if (Array.isArray(expected)) {
    assert.equal(actual.length, expected.length, label);
    for (let n = 0; n < expected.length; n++) assertEquivalent(actual[n], expected[n], `${label}[${n}]`);
  } else if (expected && typeof expected === 'object') {
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), label);
    for (const [key, value] of Object.entries(expected)) {
      assertEquivalent(actual[key], value, label + '.' + key);
    }
  } else {
    assert.equal(actual, expected, label);
  }
}

test('JS owns practice account calculations and matches existing Python across cases', () => {
  for (const [label, fixture] of Object.entries(oracle)) {
    assertEquivalent(runSyntheticGame(fixture.plan), fixture.expected, label);
  }
});

test('JS game engine rejects broken funding inputs', () => {
  for (const bad of [
    {}, {mine:1, owl:0}, {mine:50, owl:50, turtle:1},
    {mine:true, owl:0, turtle:0}, {mine:-1, owl:0, turtle:0},
    {mine:20.2, owl:0, turtle:0},
  ]) assert.throws(() => validateAllocations(bad));
});

test('JS game engine refuses live labels and malformed predictions', () => {
  const sample = oracle.solo.plan;
  for (const invalid of [
    {...sample, mode:'LIVE_MARKET'},
    {...sample, initial_price:0},
    {...sample, future_prices:[0, ...sample.future_prices.slice(1)]},
    {...sample, signals:[{mine:'LONG', owl:'CASH'}]},
    {...sample, signals:[{mine:'BUY', owl:'CASH', turtle:'CASH'}, ...sample.signals.slice(1)]},
    {...sample, models:{...sample.models, mine:{...sample.models.mine,risk_fraction:5}}},
    {...sample, model_sha256:'not-a-hash'},
  ]) assert.throws(() => runSyntheticGame(invalid));
});

test('JS simulation never performs writes and does not import Python code', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../game_runtime/practice.mjs', import.meta.url), 'utf8');
  assert.ok(!src.includes('child_process'));
  assert.ok(!src.includes('fetch('));
  assert.ok(!src.includes('writeFile'));
  assert.ok(!src.includes('local_state'));
  assert.equal(runSyntheticGame(oracle.solo.plan).mode, 'PRACTICE_SYNTHETIC_ONLY');
});
