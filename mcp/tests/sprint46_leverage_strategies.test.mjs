import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {makeScenarios, makePlan, runChain} from '../../scripts/sprint45_highrisk_lab.mjs';
import {runSyntheticGame} from '../../game_runtime/practice.mjs';
import {settleLeveragedPractice} from '../../game_runtime/leverage-practice.mjs';
import {POLICIES, RATIOS, makeSnapshot, chooseLeverage, parseArgs,
  runStrategyChain, summarize, runLab, formatReport} from '../../scripts/sprint46_leverage_strategies.mjs';

const config = {policy: 'fixed25', ratio: 1, refill: false};
const fixture = (price = 90, signal = 'LONG') => ({initial_price: 100,
  future_prices: Array(12).fill(price), signals: Array.from({length: 12},
    () => ({mine: signal, owl: signal, turtle: signal}))});
const ten = scenario => Array.from({length: 10}, () => structuredClone(scenario));
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
function assertBaseline(scenarios, policy, ratio, refill) {
  const actual = runStrategyChain(scenarios, {policy, ratio, refill});
  const expected = runChain(scenarios, {leverage: policy === 'fixed5' ? 5 : 25, ratio, refill});
  const {policy: _, reference_scores: __, ...accounting} = actual;
  accounting.leverage = expected.leverage;
  accounting.battles = accounting.battles.map(({leverage, snapshot, reference_score, ...battle}) => battle);
  assert.deepEqual(accounting, expected); // every coin, dust, grant, skip and daily sample
}

test('fixed5/25 match Sprint45 across seeds, ratios, refill and all accounting fields', () => {
  for (const seed of [0, 45, 46, 2026, 0xffffffff]) for (const scenarios of makeScenarios(seed, 3)) {
    for (const policy of ['fixed5', 'fixed25']) for (const ratio of RATIOS) {
      for (const refill of [false, true]) assertBaseline(scenarios, policy, ratio, refill);
    }
  }
});

test('baseline equality includes liquidation, fractional dust, grant and skip fixtures', () => {
  const dust = ten(fixture(100, 'CASH'));
  dust[0] = fixture(2880.03 * 100 * 1.001 / 3000);
  for (const scenarios of [ten(fixture(70)), dust]) for (const policy of ['fixed5', 'fixed25']) {
    for (const ratio of RATIOS) for (const refill of [false, true]) assertBaseline(scenarios, policy, ratio, refill);
  }
  const off = runStrategyChain(dust, config), on = runStrategyChain(dust, {...config, refill: true});
  assert.equal(off.final, 0.75);
  assert.equal(off.battles.filter(b => b.skipped).length, 9);
  assert.equal(on.battles[1].before, 3000.75);
  assert.equal(on.issued, 3000);
  assert.equal(on.net_profit, off.net_profit);
});

test('chooser uses frozen historical scalars only, is pure and rejects scenario fields', () => {
  const scores = [1, 2], snapshot = makeSnapshot(2100, 3000, scores);
  scores[0] = -100;
  assert.deepEqual(snapshot.prior_scores, [1, 2]);
  assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.prior_scores));
  assert.throws(() => snapshot.prior_scores.push(3), TypeError);
  for (const policy of POLICIES) assert.equal(chooseLeverage(policy, snapshot), chooseLeverage(policy, snapshot));
  assert.throws(() => chooseLeverage('hot25', {...snapshot}));
  assert.throws(() => chooseLeverage('hot25', Object.freeze({...snapshot, scenario: fixture()})));
  assert.deepEqual(Object.keys(snapshot).sort(), ['peak_wallet', 'prior_scores', 'wallet']);
});

test('hot25 requires the immediately preceding TWO strictly positive independent scores', () => {
  for (const [scores, expected] of [[[], 5], [[1], 5], [[1, 2], 25], [[0, 2], 5],
    [[2, -1], 5], [[1, 1, -1], 5], [[-1, 1, 1], 25]]) {
    assert.equal(chooseLeverage('hot25', makeSnapshot(3000, 3000, scores)), expected);
  }
});

test('protect threshold is strictly below 70%, equality stays 10x', () => {
  for (const [wallet, expected] of [[2100, 10], [2099.99, 1], [3000, 10], [0.63, 1]]) {
    assert.equal(chooseLeverage('protect', makeSnapshot(wallet, 3000, [])), expected);
  }
});

test('changing current and future prices/signals cannot change current choice for ANY battle', () => {
  for (const policy of POLICIES) {
    const scenarios = makeScenarios(460)[0];
    const original = runStrategyChain(scenarios, {...config, policy, ratio: 0.5});
    for (let index = 0; index < 10; index++) {
      const altered = structuredClone(scenarios);
      for (let j = index; j < 10; j++) altered[j] = fixture(j % 2 ? 101 : 99, j % 2 ? 'CASH' : 'LONG');
      const changed = runStrategyChain(altered, {...config, policy, ratio: 0.5});
      assert.deepEqual(changed.battles[index].snapshot, original.battles[index].snapshot);
      assert.equal(changed.battles[index].leverage, original.battles[index].leverage);
    }
  }
});

test('current score is published only after choice; winning battle two enables battle three', () => {
  const chain = runStrategyChain(ten(fixture(110)), {...config, policy: 'hot25', ratio: 0.1});
  assert.deepEqual(chain.battles.slice(0, 3).map(b => b.leverage), [5, 5, 25]);
  for (const [i, b] of chain.battles.entries()) assert.deepEqual(b.snapshot.prior_scores, chain.reference_scores.slice(0, i));
});

test('reference returns are common at fixed 1000C/1x, even for skipped battles', () => {
  const scenarios = ten(fixture(100, 'CASH'));
  scenarios[0] = fixture(70);
  scenarios[1] = fixture(110);
  scenarios[2] = fixture(110);
  const expected = scenarios.map(s => settleLeveragedPractice({
    equityPath: runSyntheticGame(makePlan(s, 1000)).equity_path,
    amount: 1000, available: 1000, leverage: 1}).profit_coins);
  for (const policy of POLICIES) for (const ratio of RATIOS) for (const refill of [false, true]) {
    const chain = runStrategyChain(scenarios, {policy, ratio, refill});
    assert.deepEqual(chain.reference_scores, expected);
  }
  const skipped = runStrategyChain(scenarios, {...config, policy: 'hot25'});
  assert.ok(skipped.battles[1].skipped && skipped.battles[2].skipped);
  assert.equal(skipped.battles[3].leverage, 25);
});

test('full stake wipes out mid-chain, then skips; no resurrection within or after battle', () => {
  for (const policy of POLICIES) {
    const scenarios = ten(fixture(100, 'CASH'));
    scenarios[3] = fixture(70);
    scenarios[3].future_prices.fill(150, 1);
    const chain = runStrategyChain(scenarios, {...config, policy});
    assert.equal(chain.battles[3].liquidated_at_step, 1);
    assert.deepEqual(chain.battles[3].wallet_path, [3000, ...Array(12).fill(0)]);
    assert.equal(chain.final, 0);
    assert.equal(chain.battles.filter(b => b.skipped).length, 6);
    assert.equal(chain.issued, 0);
    assert.equal(summarize([chain]).play_pct, 40);
  }
});

test('0.63 dust is retained, next-battle refill only, full issuance deducted', () => {
  const scenarios = ten(fixture(100, 'CASH'));
  scenarios[0] = fixture(96); // protect 10x loses enough to switch to 1x
  const first = runStrategyChain(scenarios, {...config, policy: 'protect'}).battles[0].after;
  const amount = Math.floor(first), dust = Math.round((first - amount) * 100) / 100;
  scenarios[1] = fixture((0.63 - dust) * 100 * 1.001 / amount);
  const off = runStrategyChain(scenarios, {...config, policy: 'protect'});
  const on = runStrategyChain(scenarios, {...config, policy: 'protect', refill: true});
  assert.equal(off.battles[1].leverage, 1);
  assert.equal(off.final, 0.63);
  assert.equal(off.battles.filter(b => b.skipped).length, 8);
  assert.equal(on.battles[1].grant, 0);
  assert.equal(on.battles[2].before_grant, 0.63);
  assert.equal(on.battles[2].before, 3000.63);
  assert.equal(on.battles[2].amount, 3000);
  assert.equal(on.net_profit, off.net_profit);
  assert.equal(on.issued, 3000);
  assert.equal(summarize([off]).wallet_unplayable_chains, 1);
  assert.equal(summarize([off]).wallet_empty_chains, 0);
});

test('no grant at one coin; partial stake preserves cash and never borrows', () => {
  const scenarios = ten(fixture(100, 'CASH'));
  scenarios[0] = fixture(96.096);
  const first = runStrategyChain(scenarios, {...config, policy: 'protect'}).battles[0].after;
  scenarios[1] = fixture(100 * 1.001 / first);
  const chain = runStrategyChain(scenarios, {...config, policy: 'protect', refill: true});
  assert.equal(chain.final, 1);
  assert.equal(chain.issued, 0);
  assert.equal(chain.battles[2].amount, 1);
  const partial = runStrategyChain(ten(fixture(70)), {...config, ratio: 0.5, refill: true});
  assert.equal(partial.grants, 0);
  assert.ok(partial.battles.every(b => b.profit >= -b.amount && b.after >= b.before - b.amount - 1e-8));
});

test('all matrix rows share scenarios, inputs remain frozen and numeric invariants hold', () => {
  const scenarios = freeze(makeScenarios(46)[0]);
  const before = structuredClone(scenarios);
  for (const policy of POLICIES) for (const ratio of RATIOS) {
    const chain = runStrategyChain(scenarios, freeze({policy, ratio, refill: false}));
    for (const b of chain.battles) {
      assert.ok(b.leverage >= 1 && b.leverage <= 25);
      assert.equal(b.amount, Math.floor(Math.floor(b.before) * ratio));
      assert.ok(b.profit >= -b.amount);
      assert.ok(b.wallet_path.every(n => Number.isFinite(n) && n >= b.before - b.amount - 1e-8));
      assert.equal(b.wallet_path.length, 13);
      assert.equal(b.wallet_path.at(-1), b.after);
    }
    for (const b of chain.battles) assert.equal(b.snapshot.peak_wallet,
      Math.max(...chain.wallet_path.slice(0, 1 + (b.battle - 1) * 12)));
  }
  assert.deepEqual(scenarios, before);
  const lab = runLab({seed: 46, samples: 1, refill: 'compare'});
  assert.equal(lab.rows.length, 24);
  for (const r of lab.rows) assert.deepEqual(r.example, runStrategyChain(scenarios, r));
});

test('profit is uncapped and gigantic values safely abort including terminal battle', () => {
  const scenarios = ten(fixture(100, 'CASH'));
  scenarios[0] = fixture(110);
  assert.ok(runStrategyChain(scenarios, config).battles[0].profit > 3000);
  assert.throws(() => runStrategyChain(ten(fixture(200)), config), /数値範囲/);
  scenarios[9] = {...fixture(1e12), initial_price: 0.000001};
  assert.throws(() => runStrategyChain(scenarios, config), /数値範囲/);
});

test('summary uses chains for mean/median, battle denominators, grant subtraction', () => {
  const loss = runStrategyChain(ten(fixture(70)), config);
  const flat = runStrategyChain(ten(fixture(100, 'CASH')), config);
  const s = summarize([loss, flat]);
  assert.equal(s.mean_net_profit, -1500);
  assert.equal(s.median_net_profit, -1500);
  assert.equal(s.median_final, 1500);
  assert.equal(s.play_pct, 55);
  assert.equal(s.stake_loss_pct, 9.09);
  assert.equal(s.leverage25_pct, 100);
  assert.equal(s.wallet_unplayable_chains, 1);
  const on = runStrategyChain(ten(fixture(70)), {...config, refill: true});
  assert.equal(on.issued, 27000);
  assert.equal(on.grants, 9);
  assert.equal(on.net_profit, -30000);
  assert.equal(summarize([on]).total_issued, 27000);
  assert.equal(summarize([on]).mean_issued, 27000);
  assert.throws(() => summarize([]));
});

test('arguments validate seed/sample bounds, defaults, duplicates and refill modes', () => {
  assert.deepEqual(parseArgs([]), {seed: 46, samples: 20, refill: 'off', help: false});
  assert.equal(parseArgs(['--seed', '4294967295', '--samples', '1000']).samples, 1000);
  for (const args of [['--seed'], ['--seed', '-1'], ['--seed', '4294967296'], ['--seed', 'NaN'],
    ['--seed', '1.2'], ['--samples', '0'], ['--samples', '1001'], ['--samples', 'Infinity'],
    ['--samples', '9'.repeat(400)], ['--refill', 'bad'], ['--wat'], ['--help', '--help'],
    ['--seed', '1', '--seed', '2']]) assert.throws(() => parseArgs(args));
  for (const seed of [-1, NaN, Infinity, '46', null, 2 ** 32]) assert.throws(() => runLab({seed}));
  for (const samples of [0, 1001, 1.1, NaN, '20', null]) assert.throws(() => runLab({samples}));
  assert.throws(() => runLab({refill: 'bad'}));
});

test('malformed policy/history/scenarios are rejected', () => {
  for (const patch of [{policy: 'oracle'}, {ratio: 0}, {ratio: NaN}, {refill: 'on'}]) {
    assert.throws(() => runStrategyChain(ten(fixture()), {...config, ...patch}));
  }
  assert.throws(() => runStrategyChain([], config));
  assert.throws(() => runStrategyChain(ten(fixture(NaN)), config));
  assert.throws(() => runStrategyChain(ten(fixture(100, 'SELL')), config));
  assert.throws(() => runStrategyChain(ten({...fixture(), signals: []}), config));
  for (const args of [[NaN, 3000, []], [3001, 3000, []], [0, 3000, [Infinity]],
    [0, 3000, Array(10).fill(1)], [-1, 3000, []]]) assert.throws(() => makeSnapshot(...args));
});

test('same seed reproduces entire report and changed seed changes scenarios', () => {
  assert.equal(formatReport(runLab({samples: 2})), formatReport(runLab({samples: 2})));
  assert.notDeepEqual(makeScenarios(46), makeScenarios(47));
});

test('CLI prints readable Japanese table, precise baseline description and stdout only', () => {
  const script = fileURLToPath(new URL('../../scripts/sprint46_leverage_strategies.mjs', import.meta.url));
  const args = [script, '--seed', '46', '--samples', '2', '--refill', 'compare'];
  const first = spawnSync(process.execPath, args, {encoding: 'utf8'});
  const second = spawnSync(process.execPath, args, {encoding: 'utf8'});
  assert.equal(first.status, 0);
  assert.equal(first.stderr, '');
  assert.equal(first.stdout, second.stdout);
  assert.equal(first.stdout.trimEnd(), formatReport(runLab({seed: 46, samples: 2, refill: 'compare'})));
  for (const word of ['架空相場', '本物のAIではない', '実資産非連動', '期待値の証明ではない',
    '倍率なし基準収益（AI予測精度とは別）', 'モデル賢さランキングではない', '平均純損益', '給付控除']) assert.ok(first.stdout.includes(word));
  const bad = spawnSync(process.execPath, [script, '--samples', '1001'], {encoding: 'utf8'});
  assert.equal(bad.status, 1);
  assert.equal(bad.stderr, '');
  assert.match(bad.stdout, /架空実験エラー/);
});
