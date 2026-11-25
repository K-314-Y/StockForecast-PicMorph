// Research only. Stdout is the reproducible tables section of the report.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {runSyntheticGame} from '../game_runtime/practice.mjs';

const source = fileURLToPath(new URL('./accessory_crash_branches.py', import.meta.url));
const branches = {weak: '弱い回復', stall: '途中失速', flat: '横ばい', decline: '下落継続',
  double: '二段急落', mixed: '正負混在'};
const methods = {glasses: '眼鏡RSI', standard: '標準', triple: '3装備均等', cash: '現金', hold: '初日買い持ち'};
const average = values => values.reduce((total, value) => total + value, 0) / values.length;
const fmt = value => value.toFixed(3);
const tableRow = cells => console.log('|' + cells.join('|') + '|');

export function interval(differences) {
  const mean = average(differences);
  const variance = differences.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (differences.length - 1);
  const radius = 1.96 * Math.sqrt(variance / differences.length);
  return {mean, lower: mean - radius, upper: mean + radius};
}

function display({mean, lower, upper}) {
  return `${fmt(mean)} [${fmt(lower)}, ${fmt(upper)}]`;
}

export function missedRebound(prices, signals, shock) {
  let up = 0, missed = 0;
  for (let day = shock + 1; day < prices.length; day++) {
    if (prices[day] > prices[day - 1]) {
      up++;
      if (signals[day].mine === 'CASH') missed++;
    }
  }
  const recovered = prices.at(-1) > prices[shock];
  return {up, missed, recovered, missedAll: recovered && up === missed};
}

export function buyAndHold(base) {
  // Independent one-step games give the marked value of the *same* initial
  // purchase at each close. Each valuation charges the entry fee exactly once.
  const entry = [{...base.signals[0], mine: 'LONG'}];
  let peak = base.initial_coins, dd = 0, final;
  for (const price of base.future_prices) {
    final = runSyntheticGame({...base, signals: entry, future_prices: [price]});
    const equity = final.raw_equity_path[1];
    peak = Math.max(peak, equity);
    dd = Math.max(dd, 100 * (1 - equity / peak));
  }
  const {trades, fees} = final.characters.mine;
  return {profit: final.profit_coins, dd, trades, fees};
}

function measure(plans, shock) {
  const base = plans.standard;
  assert.equal(base.initial_coins, 1000);
  assert.equal(base.initial_price, 109);
  assert.equal(base.future_prices.length, 12);
  assert.equal(base.fee_rate, .001);
  assert.deepEqual(base.allocations, {mine: 100, owl: 0, turtle: 0});
  const cash = {...base, signals: base.signals.map(step => ({...step, mine: 'CASH'}))};
  const row = {};
  for (const [name, plan] of Object.entries({...plans, cash})) {
    for (const field of ['model_sha256', 'allocations', 'initial_price', 'initial_coins', 'fee_rate', 'future_prices']) {
      assert.deepEqual(plan[field], base[field]);
    }
    assert.equal(plan.models.mine.risk_fraction, .35);
    const game = runSyntheticGame(plan);
    const {trades, fees} = game.characters.mine;
    row[name] = {profit: game.profit_coins, dd: game.max_drawdown_pct, trades, fees};
  }
  assert.deepEqual(row.cash, {profit: 0, dd: 0, trades: 0, fees: 0});
  row.hold = buyAndHold(base);
  row.rebound = missedRebound(base.future_prices, plans.glasses.signals, shock);
  return row;
}

function loadFamilies(split) {
  const data = execFileSync('python3', ['-B', source, split], {encoding: 'utf8', maxBuffer: 12 * 1024 ** 2});
  const families = data.trimEnd().split('\n').map((line, i) => {
    const item = JSON.parse(line);
    assert.equal(item.index, i);
    assert.deepEqual(Object.keys(item.branches), Object.keys(branches));
    const family = {};
    for (const [key, plans] of Object.entries(item.branches)) family[key] = measure(plans, item.shock);
    return family;
  });
  assert.equal(families.length, 60);
  return families;
}

export function familyInterval(families, control) {
  return interval(families.map(family => average(Object.values(family).map(
    row => row.glasses.profit - row[control].profit))));
}

function report(split, label) {
  const families = loadFamilies(split);
  const cash = familyInterval(families, 'cash');
  const standard = familyInterval(families, 'standard');
  console.log(`\n## ${label}用\n\n主判定（親60例）　対現金 ${display(cash)} C、対標準 ${display(standard)} C。\n`);
  console.log('|分岐|方式|平均損益 C|平均最大下落率 %|平均取引日数|平均手数料 C|無取引 %|対現金 差 [95%区間] C|対標準 差 [95%区間] C|');
  console.log('|---|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const [key, title] of Object.entries(branches)) {
    const rows = families.map(family => family[key]);
    for (const [method, name] of Object.entries(methods)) {
      const values = rows.map(row => row[method]);
      const means = ['profit', 'dd', 'trades', 'fees'].map(field => fmt(average(values.map(v => v[field]))));
      const idle = 100 * values.filter(v => v.trades === 0).length / rows.length;
      const comparisons = ['cash', 'standard'].map(control =>
        display(interval(rows.map(row => row[method].profit - row[control].profit))));
      tableRow([title, name, ...means, idle.toFixed(1), ...comparisons]);
    }
  }
  console.log('\n|眼鏡の分岐|見送り上昇日 / 全上昇日|全上昇日を見送り / 終値回復例|');
  console.log('|---|---:|---:|');
  for (const [key, title] of Object.entries(branches)) {
    const sum = field => families.reduce((n, family) => n + Number(family[key].rebound[field]), 0);
    const ratio = (a, b) => sum(b) ? `${sum(a)}/${sum(b)}` : '該当なし（0/0）';
    tableRow([title, ratio('missed', 'up'), ratio('missedAll', 'recovered')]);
  }
  const losses = families.map(family => family.decline.glasses.profit);
  console.log(`\n下落継続での眼鏡の損失は${losses.filter(p => p < 0).length}/60例、最悪損益は ${fmt(Math.min(...losses))} C。`);
  return cash.lower > 0 && standard.lower > 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const development = report('development', '開発');
  const validation = report('validation', '検証');
  console.log('\n主仮説の判定は **' + (development && validation ? '採択' : '不採択') + '**。');
}
