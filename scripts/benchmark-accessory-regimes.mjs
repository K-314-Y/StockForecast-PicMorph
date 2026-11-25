// Emit the P9ag report tables to stdout. All accounting belongs to the game.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runSyntheticGame} from '../game_runtime/practice.mjs';

const source = fileURLToPath(new URL('./accessory_regime_plans.py', import.meta.url));
const regimes = {up:'上昇', down:'下落', flat:'横ばい', recovery:'急落回復', cluster:'変動性持続', reversal:'途中反転'};
const names = {standard:'標準', star:'星', glasses:'眼鏡', ribbon:'リボン', none:'移動平均', triple:'3装備均等', cash:'現金'};
const mean = xs => xs.reduce((a,b) => a+b, 0) / xs.length;
const fmt = n => n.toFixed(3);

function measure(plans) {
  const base = plans.standard;
  assert.equal(base.initial_price, 109);
  assert.equal(base.future_prices.length, 12);
  assert.equal(base.initial_coins, 1000);
  assert.equal(base.fee_rate, .001);
  assert.deepEqual(base.allocations, {mine:100, owl:0, turtle:0});
  plans.cash = {...base, signals:base.signals.map(step => ({...step, mine:'CASH'}))};
  const row = {};
  for (const key of Object.keys(names)) {
    const plan = plans[key];
    for (const field of ['initial_price','future_prices','initial_coins','allocations','fee_rate','model_sha256']) {
      assert.deepEqual(plan[field], base[field]);
    }
    assert.equal(plan.models.mine.risk_fraction, .35);
    const game = runSyntheticGame(plan);
    const {trades, fees} = game.characters.mine;
    row[key] = {profitCents:Math.round(game.profit_coins * 100), dd:game.max_drawdown_pct, trades, fees};
  }
  assert.deepEqual(row.cash, {profitCents:0, dd:0, trades:0, fees:0});
  return row;
}

function paired(rows, key, control) {
  const diff = rows.map(row => row[key].profitCents - row[control].profitCents);
  const avg = mean(diff); // cents
  const se = Math.sqrt(mean(diff.map(d => (d-avg)**2)) / (diff.length-1));
  return {lower:(avg-1.96*se)/100, upper:(avg+1.96*se)/100, avg:avg/100, wins:diff.filter(d => d>0).length};
}

function cell({lower, upper, avg, wins}) {
  return `${wins} / ${fmt(avg)} [${fmt(lower)}, ${fmt(upper)}]`;
}

const passed = [];
for (const [split, label] of [['development','開発'], ['validation','検証']]) {
  console.log(`\n## ${label}用（各タイプ60例）\n`);
  console.log('|タイプ|方式|平均損益 C|中央値 C|平均最大下落率 %|最悪最大下落率 %|平均取引日数|平均手数料 C|対標準 件 / 差 [95%区間] C|対現金 件 / 差 [95%区間] C|');
  console.log('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const [regime, title] of Object.entries(regimes)) {
    const output = execFileSync('python3', ['-B', source, split, regime], {encoding:'utf8', maxBuffer:4*1024*1024});
    const rows = output.trimEnd().split('\n').map(line => measure(JSON.parse(line)));
    assert.equal(rows.length, 60);
    for (const [key, name] of Object.entries(names)) {
      const metrics = field => rows.map(row => row[key][field]);
      const profits = metrics('profitCents').sort((a,b) => a-b);
      const dd = metrics('dd');
      const values = [mean(profits)/100, (profits[29]+profits[30])/200, mean(dd), Math.max(...dd),
        mean(metrics('trades')), mean(metrics('fees'))];
      const standard = paired(rows, key, 'standard');
      const cash = paired(rows, key, 'cash');
      if (regime === 'recovery' && key === 'glasses') passed.push(standard.lower>0 && cash.lower>0);
      console.log('|'+[title, name, ...values.map(fmt), cell(standard), cell(cash)].join('|')+'|');
    }
  }
}
console.log('\n主仮説の判定（急落回復型の眼鏡、対標準・対現金、両組） ' +
  (passed.length === 2 && passed.every(Boolean) ? '**研究仮説を採択**' : '**不採択**'));
