import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runSyntheticGame} from '../../game_runtime/practice.mjs';
import {settleLeveragedPractice} from '../../game_runtime/leverage-practice.mjs';
import {parseArgs, makeScenarios, makePlan, runChain, runLab, summarize, formatReport,
  LEVERAGES, RATIOS} from '../../scripts/sprint45_highrisk_lab.mjs';

const config = {leverage: 25, ratio: 1, refill: false};
function fixture(price = 90, signal = 'LONG') {
  return {initial_price: 100, future_prices: Array(12).fill(price),
    signals: Array.from({length: 12}, () => ({mine: signal, owl: signal, turtle: signal}))};
}
const ten = scenario => Array.from({length: 10}, () => structuredClone(scenario));
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test('seed reproduces the entire lab; changed seed changes paths', () => {
  assert.deepEqual(runLab({seed: 45, samples: 2}), runLab({seed: 45, samples: 2}));
  assert.notDeepEqual(makeScenarios(45, 2), makeScenarios(46, 2));
  assert.equal(makeScenarios(0xffffffff)[0][0].future_prices.length, 12);
  assert.equal(makeScenarios(0)[0].length, 10);
});

test('all 24 comparison rows use the identical scenarios and signals', () => {
  const seed = 981, scenarios = makeScenarios(seed, 2), lab = runLab({seed, samples: 2});
  assert.equal(lab.rows.length, 24);
  for (const row of lab.rows) {
    const chains = scenarios.map(s => runChain(s, row));
    assert.deepEqual(row.example, chains[0]);
    assert.deepEqual(row.summary, summarize(chains));
    const b = row.example.battles[0];
    const base = runSyntheticGame(makePlan(scenarios[0][0], b.amount));
    assert.deepEqual(base.decisions.map(d => d.signals), scenarios[0][0].signals);
    const expected = settleLeveragedPractice({equityPath: base.equity_path,
      amount: b.amount, leverage: row.leverage, available: 3000});
    assert.deepEqual(b.wallet_path, expected.allocated_equity_path.map(n => Math.round((n + expected.cash_held) * 100) / 100));
  }
});

test('inputs remain unchanged, including nested plans and scenarios', () => {
  const scenarios = freeze(makeScenarios(45)[0]), before = structuredClone(scenarios);
  const options = freeze({...config});
  runChain(scenarios, options);
  const plan = freeze(makePlan(scenarios[0], 3000)), planBefore = structuredClone(plan);
  runSyntheticGame(plan);
  assert.deepEqual(scenarios, before);
  assert.deepEqual(plan, planBefore);
  assert.deepEqual(options, config);
});

test('1x daily and final values match existing pure functions including fractional cash', () => {
  const scenarios = makeScenarios(59)[0];
  for (const ratio of RATIOS) {
    const chain = runChain(scenarios, {...config, leverage: 1, ratio});
    for (const b of chain.battles.filter(b => !b.skipped)) {
      const base = runSyntheticGame(makePlan(scenarios[b.battle - 1], b.amount));
      const cash = b.before - b.amount;
      const round = n => Math.round((n + Number.EPSILON) * 100) / 100;
      assert.equal(b.profit, base.profit_coins);
      assert.equal(b.after, round(base.final_coins + cash));
      assert.deepEqual(b.wallet_path, base.equity_path.map(n => round(n + cash)));
    }
  }
});

test('wipeout without refill executes once then skips zero stakes for all remaining battles', () => {
  const result = runChain(ten(fixture()), config);
  assert.equal(result.final, 0);
  assert.equal(result.issued, 0);
  assert.equal(result.battles.length, 10);
  assert.equal(result.battles[0].profit, -3000);
  assert.equal(result.battles[0].liquidated_at_step, 1);
  assert.equal(result.battles.filter(b => b.skipped).length, 9);
  const s = summarize([result]);
  assert.equal(s.stake_loss_pct, 100);
  assert.equal(s.wallet_empty_pct, 100);
  assert.equal(s.play_pct, 10);
  assert.equal(s.retry_pct, 0);
  assert.equal(s.max_drawdown_pct, 100);
});

test('refill is next-battle only, counts retries and subtracts issuance from profit', () => {
  const result = runChain(ten(fixture()), {...config, refill: true});
  assert.equal(result.grants, 9);
  assert.equal(result.issued, 27000);
  assert.equal(result.net_profit, -30000);
  assert.equal(result.final, 0);
  assert.equal(result.battles[0].grant, 0);
  assert.ok(result.battles.slice(1).every(b => b.grant === 3000 && b.before_grant === 0));
  const s = summarize([result]);
  assert.equal(s.retry_pct, 100);
  assert.equal(s.play_pct, 100);
  assert.equal(s.mean_issued, 27000);
});

test('liquidation cannot recover later within the same battle', () => {
  const scenario = fixture();
  scenario.future_prices.fill(150, 1);
  const b = runChain(ten(scenario), config).battles[0];
  assert.equal(b.liquidated_at_step, 1);
  assert.deepEqual(b.wallet_path, [3000, ...Array(12).fill(0)]);
});

test('loss is bounded by stake; idle cash survives with no grant at partial stake', () => {
  for (const ratio of [0.1, 0.5]) {
    const chain = runChain(ten(fixture()), {...config, ratio, refill: true});
    assert.equal(chain.grants, 0);
    for (const b of chain.battles) {
      assert.ok(b.profit >= -b.amount);
      assert.ok(b.after >= b.before - b.amount - 1e-8);
      assert.ok(b.wallet_path.every(n => n >= b.before - b.amount - 1e-8));
    }
  }
});

test('integer residual receives no refill; CASH signals incur no fee', () => {
  const chain = runChain(ten(fixture()), {...config, ratio: 0.5, refill: true});
  assert.equal(chain.final, 3);
  // Reuse a flat plan to check that no-action signals produce no fee or grants.
  const cash = runChain(ten(fixture(90, 'CASH')), config);
  assert.equal(cash.final, 3000);
  assert.equal(cash.net_profit, 0);
});

test('sub-coin dust survives refill: 0.63 at 1x and 0.75 at 25x both retry', () => {
  for (const [leverage, price, dust] of [[1, 0.021021, 0.63], [25, 2880.03 * 100 * 1.001 / 3000, 0.75]]) {
    const scenarios = ten(fixture(100, 'CASH'));
    scenarios[0] = fixture(price);
    const off = runChain(scenarios, {...config, leverage});
    const on = runChain(scenarios, {...config, leverage, refill: true});
    assert.equal(off.battles[0].after, dust);
    assert.equal(off.battles[0].wallet_empty, false);
    assert.equal(off.battles[0].wallet_unplayable, true);
    assert.equal(off.final, dust);
    assert.equal(off.battles.filter(b => b.skipped).length, 9);
    assert.equal(on.battles[1].before_grant, dust);
    assert.equal(on.battles[1].before, 3000 + dust);
    assert.equal(on.battles[1].amount, 3000);
    assert.equal(on.battles[1].skipped, false);
    assert.equal(on.battles.filter(b => b.skipped).length, 0);
    assert.equal(on.issued, 3000);
    assert.equal(on.grants, 1);
    assert.equal(on.final, 3000 + dust);
    assert.equal(on.net_profit, off.net_profit);
    assert.equal(on.net_profit, Math.round((dust - 3000) * 100) / 100);
    for (const chain of [off, on]) {
      const s = summarize([chain]);
      assert.equal(s.wallet_empty_chains, 0);
      assert.equal(s.wallet_empty_pct, 0);
      assert.equal(s.wallet_unplayable_chains, 1);
      assert.equal(s.wallet_unplayable_pct, 100);
    }
    assert.equal(summarize([on]).retry_pct, 11.11);
    assert.equal(summarize([on]).play_pct, 100);
  }
});

test('strict zero is counted separately but also belongs to below-one unplayable count', () => {
  const s = summarize([runChain(ten(fixture()), config)]);
  assert.equal(s.wallet_empty_chains, 1);
  assert.equal(s.wallet_unplayable_chains, 1);
});

test('no grant at exactly one coin or at partial stakes with remaining cash', () => {
  const scenarios = ten(fixture(100, 'CASH'));
  scenarios[0] = fixture(100 * 1.001 / 3000);
  const chain = runChain(scenarios, {...config, leverage: 1, refill: true});
  assert.equal(chain.battles[0].after, 1);
  assert.equal(chain.grants, 0);
  assert.equal(chain.battles[1].amount, 1);
  assert.equal(chain.battles[0].wallet_unplayable, false);
  const partial = runChain(ten(fixture()), {...config, ratio: 0.1, refill: true});
  assert.equal(partial.grants, 0);
});

test('profits remain uncapped above the stake at 25x', () => {
  const scenarios = ten(fixture(100, 'CASH'));
  scenarios[0] = fixture(110);
  const chain = runChain(scenarios, config);
  assert.ok(chain.battles[0].profit > 3000);
  assert.equal(chain.final, chain.battles[0].after);
});

test('mean and median use independent chains, correct odd/even medians', () => {
  const win = ten(fixture(100, 'CASH')), loss = ten(fixture());
  const a = runChain(win, config), b = runChain(loss, config);
  const s = summarize([a, b]);
  assert.equal(s.mean_final, 1500);
  assert.equal(s.median_final, 1500);
  assert.equal(s.mean_net_profit, -1500);
  assert.equal(s.median_net_profit, -1500);
  assert.equal(s.wallet_empty_pct, 50);
  assert.equal(summarize([a, b, a]).median_final, 3000);
  assert.throws(() => summarize([]));
});

test('invalid CLI options are rejected strictly', () => {
  for (const args of [['--seed'], ['--seed', '-1'], ['--seed', '4294967296'],
    ['--seed', 'NaN'], ['--seed', '1.2'], ['--samples', '0'], ['--samples', '1001'],
    ['--samples', 'Infinity'], ['--refill', 'yes'], ['--wat'], ['--help', '--help'],
    ['--seed', '1', '--seed', '2']]) assert.throws(() => parseArgs(args), args.join(' '));
  assert.deepEqual(parseArgs([]), {seed: 45, samples: 20, refill: 'compare', help: false});
  assert.equal(parseArgs(['--seed', '0', '--samples', '1', '--refill', 'off']).seed, 0);
});

test('invalid programmatic inputs and malformed paths are rejected', () => {
  for (const seed of [-1, NaN, Infinity, '45', 2 ** 32]) assert.throws(() => makeScenarios(seed));
  for (const samples of [0, 1001, 1.1, NaN]) assert.throws(() => makeScenarios(45, samples));
  for (const patch of [{leverage: 2}, {ratio: 0}, {ratio: NaN}, {refill: 'on'}]) {
    assert.throws(() => runChain(ten(fixture()), {...config, ...patch}));
  }
  assert.throws(() => runChain([], config));
  assert.throws(() => runChain(ten({...fixture(), future_prices: [90]}), config));
  assert.throws(() => runChain(ten(fixture(NaN)), config));
  assert.throws(() => runChain(ten(fixture(90, 'SELL')), config));
  assert.throws(() => runLab({refill: 'bad'}));
  assert.throws(() => runChain(ten(fixture(200)), config), /数値範囲/);
});

test('runLab propagates makeScenarios validation before producing comparison results', () => {
  for (const seed of [-1, 2 ** 32, Number.MAX_VALUE, NaN, Infinity, '45', null]) {
    assert.throws(() => runLab({seed}), /seed または samples/);
  }
  for (const samples of [0, 1001, Number.MAX_VALUE, NaN, Infinity, '20', null]) {
    assert.throws(() => runLab({samples}), /seed または samples/);
  }
});

test('unsafe huge terminal equity is rejected even on the last battle', () => {
  const scenarios = ten(fixture(100, 'CASH'));
  scenarios[9] = {...fixture(1e12), initial_price: 0.000001};
  assert.throws(() => runChain(scenarios, config), /安全に表現できる数値範囲/);
  for (const args of [['--seed', '9'.repeat(400)], ['--samples', '9'.repeat(400)]]) {
    assert.throws(() => parseArgs(args), /範囲外/);
  }
});

test('numeric invariants across seeds and comparison matrix', () => {
  for (const seed of [0, 45, 103, 0xffffffff]) {
    for (const row of runLab({seed, samples: 2}).rows) {
      assert.ok(LEVERAGES.includes(row.leverage));
      for (const b of row.example.battles) {
        assert.ok(Number.isFinite(b.after) && b.after >= 0);
        assert.ok(b.profit >= -b.amount);
        assert.ok(b.after >= b.before - b.amount - 1e-8);
        assert.equal(b.wallet_path.length, 13);
        assert.equal(b.wallet_path.at(-1), b.after);
      }
      assert.ok(row.summary.retry_pct >= 0 && row.summary.retry_pct <= 100);
    }
  }
});

test('CLI emits Japanese disclaimers and stdout only results; failure exits nonzero', () => {
  const script = fileURLToPath(new URL('../../scripts/sprint45_highrisk_lab.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--samples', '1', '--refill', 'off'], {encoding: 'utf8'});
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trimEnd(), formatReport(runLab({samples: 1, refill: 'off'})));
  for (const word of ['架空', '実資産非連動', '期待値の証明ではない', '無限発行', '再試行', '日次財布']) {
    assert.ok(result.stdout.includes(word));
  }
  const bad = spawnSync(process.execPath, [script, '--seed', '-1'], {encoding: 'utf8'});
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, '');
  assert.match(bad.stderr, /架空実験エラー/);
});
