import {pathToFileURL} from 'node:url';
import {runSyntheticGame} from '../game_runtime/practice.mjs';
import {settleLeveragedPractice} from '../game_runtime/leverage-practice.mjs';

export const LEVERAGES = Object.freeze([1, 5, 10, 25]);
export const RATIOS = Object.freeze([0.1, 0.5, 1]);
const START = 3000, BATTLES = 10, STEPS = 12;
const cents = n => Math.round((n + Number.EPSILON) * 100) / 100;
const validSeed = n => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;

export function parseArgs(args) {
  const options = {seed: 45, samples: 20, refill: 'compare', help: false};
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--help' && !seen.has(key)) {
      options.help = true;
    } else if (['--seed', '--samples', '--refill'].includes(key) && !seen.has(key)) {
      const value = args[++i];
      if (key === '--refill') {
        if (!['off', 'on', 'compare'].includes(value)) throw new Error('--refill は off/on/compare');
        options.refill = value;
      } else {
        if (!/^\d+$/.test(value ?? '')) throw new Error(`${key} は整数`);
        const number = Number(value);
        if (key === '--seed' ? !validSeed(number) : !Number.isInteger(number) || number < 1 || number > 1000) {
          throw new Error(`${key} が範囲外`);
        }
        options[key.slice(2)] = number;
      }
    } else throw new Error(`不明または重複した引数: ${key}`);
    seen.add(key);
  }
  return options;
}

// Integer PRNG: repeatable fixture generation, never trained or live AI output.
export function makeScenarios(seed, samples = 1) {
  if (!validSeed(seed) || !Number.isInteger(samples) || samples < 1 || samples > 1000) {
    throw new RangeError('seed または samples が不正');
  }
  let state = seed;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({length: samples}, () => Array.from({length: BATTLES}, () => {
    let price = 100;
    const future_prices = [], signals = [];
    for (let step = 0; step < STEPS; step++) {
      // Decide before drawing the next return; no future-dependent prediction.
      const signal = random() < 0.75 ? 'LONG' : 'CASH';
      signals.push({mine: signal, owl: signal, turtle: signal});
      price *= 1 + (random() - 0.5) * 0.12;
      future_prices.push(price);
    }
    return {initial_price: 100, future_prices, signals};
  }));
}

export function makePlan(scenario, amount) {
  const model = () => ({risk_fraction: 1, effective_sha256: '0'.repeat(64),
    plugin_weights: {}, plugin_strengths: {}});
  return {mode: 'PRACTICE_SYNTHETIC_ONLY', initial_coins: amount,
    fee_rate: 0.001, initial_price: scenario.initial_price,
    future_prices: scenario.future_prices, signals: scenario.signals,
    allocations: {mine: 100, owl: 0, turtle: 0},
    models: {mine: model(), owl: model(), turtle: model()}, model_sha256: '0'.repeat(64)};
}

function maxDrawdown(path) {
  let peak = path[0], maximum = 0;
  for (const value of path) {
    peak = Math.max(peak, value);
    if (peak > 0) maximum = Math.max(maximum, 1 - value / peak);
  }
  return cents(maximum * 100);
}

export function runChain(scenarios, {leverage, ratio, refill}) {
  if (!LEVERAGES.includes(leverage) || !RATIOS.includes(ratio) || typeof refill !== 'boolean' ||
      !Array.isArray(scenarios) || scenarios.length !== BATTLES ||
      !scenarios.every(s => s && s.future_prices?.length === STEPS && s.signals?.length === STEPS)) {
    throw new RangeError('10戦×12ステップ・倍率・投入比率・給付設定が不正');
  }
  let wallet = START, issued = 0, grants = 0;
  const battles = [], walletPath = [wallet];
  for (const [index, scenario] of scenarios.entries()) {
    const beforeGrant = wallet;
    let grant = 0;
    // Preserve sub-coin dust, but allow another test when no integer coin is spendable.
    if (Math.floor(wallet) < 1 && refill) {
      grant = START;
      wallet = cents(wallet + grant);
      issued += grant;
      grants++;
      walletPath.push(wallet);
    }
    const before = wallet;
    const available = Math.floor(wallet);
    const amount = Math.floor(available * ratio);
    if (amount === 0) {
      // Existing pure functions require positive integer stakes: never pass zero.
      battles.push({battle: index + 1, before_grant: beforeGrant, grant, before,
        amount: 0, profit: 0, after: wallet, skipped: true,
        stake_lost: false, wallet_empty: wallet === 0, wallet_unplayable: Math.floor(wallet) < 1,
        liquidated_at_step: null,
        wallet_path: Array(STEPS + 1).fill(wallet), allocated_drawdown_pct: null});
      walletPath.push(...Array(STEPS).fill(wallet));
      continue;
    }
    if (!Number.isSafeInteger(available) || amount > 1e9) {
      throw new RangeError('既存関数の数値範囲を超過（利益キャップせず実験を中止）');
    }
    const base = runSyntheticGame(makePlan(scenario, amount));
    const settled = settleLeveragedPractice({equityPath: base.equity_path, amount, leverage, available});
    const dust = cents(before - available);
    const path = settled.allocated_equity_path.map(n => cents(settled.cash_held + dust + n));
    wallet = cents(settled.final_balance + dust);
    if (![wallet, ...path].every(n => Number.isFinite(n) && n >= 0 && Number.isSafeInteger(Math.round(n * 100)))) {
      throw new RangeError('セント単位で安全に表現できる数値範囲を超過（実験を中止）');
    }
    if (settled.profit_coins < -amount || wallet < cents(before - amount)) {
      throw new RangeError('元本超過損失または不正な数値');
    }
    battles.push({battle: index + 1, before_grant: beforeGrant, grant, before, amount,
      profit: settled.profit_coins, after: wallet, skipped: false,
      stake_lost: settled.allocated_final === 0, wallet_empty: wallet === 0,
      wallet_unplayable: Math.floor(wallet) < 1,
      liquidated_at_step: settled.liquidated_at_step, wallet_path: path,
      allocated_drawdown_pct: settled.max_drawdown_pct});
    walletPath.push(...path.slice(1));
  }
  return {leverage, ratio, refill, final: wallet, issued, grants,
    net_profit: cents(wallet - START - issued), battles, wallet_path: walletPath,
    max_drawdown_pct: maxDrawdown(walletPath)};
}

export function summarize(chains) {
  if (!chains.length) throw new RangeError('集計対象が空');
  const mean = values => cents(values.reduce((a, b) => a + b, 0) / values.length);
  const median = values => {
    const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
    return cents(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
  };
  const battles = chains.flatMap(c => c.battles), played = battles.filter(b => !b.skipped);
  const rate = (n, d) => d ? cents(100 * n / d) : 0;
  const empty = chains.filter(c => c.battles.some(b => b.wallet_empty)).length;
  const unplayable = chains.filter(c => c.battles.some(b => b.wallet_unplayable)).length;
  return {samples: chains.length, mean_final: mean(chains.map(c => c.final)),
    median_final: median(chains.map(c => c.final)),
    mean_net_profit: mean(chains.map(c => c.net_profit)), median_net_profit: median(chains.map(c => c.net_profit)),
    stake_loss_pct: rate(played.filter(b => b.stake_lost).length, played.length),
    wallet_empty_chains: empty, wallet_empty_pct: rate(empty, chains.length),
    wallet_unplayable_chains: unplayable, wallet_unplayable_pct: rate(unplayable, chains.length),
    play_pct: rate(played.length, battles.length),
    retry_pct: rate(chains.reduce((n, c) => n + c.grants, 0), chains.length * (BATTLES - 1)),
    mean_issued: mean(chains.map(c => c.issued)), max_drawdown_pct: Math.max(...chains.map(c => c.max_drawdown_pct))};
}

export function runLab({seed = 45, samples = 20, refill = 'compare'} = {}) {
  if (!['compare', 'on', 'off'].includes(refill)) throw new RangeError('給付設定が不正');
  const scenarios = makeScenarios(seed, samples);
  const rows = [];
  for (const enabled of refill === 'compare' ? [false, true] : [refill === 'on']) {
    for (const leverage of LEVERAGES) for (const ratio of RATIOS) {
      const chains = scenarios.map(s => runChain(s, {leverage, ratio, refill: enabled}));
      rows.push({leverage, ratio, refill: enabled, summary: summarize(chains), example: chains[0]});
    }
  }
  return {seed, samples, rows};
}

export function formatReport(lab) {
  const lines = [
    'Sprint45 架空ハイリスク実験 — 実資産非連動・期待値の証明ではない',
    `seed=${lab.seed} 架空シナリオ群=${lab.samples} 初期3000コイン × 10戦 × 12日次ステップ`,
    '同じ価格経路・架空AIシグナルを全条件で共用。各戦の倍率は各比較行で固定。手数料0.1%、mine配分100%、リスク比率1。',
    '給付は比較用のみ。財布が1コイン未満なら次戦に3000を加算し端数は保持。無限発行は均衡を破る危険がある。換金価値・実XPなし。',
    '投入は整数切捨て、端数コインは保留。ゼロ投入はスキップ（新たな投入全損とは数えない）。',
    '全損率=投入全損/実行戦。厳密ゼロ群数と投入不能群数（1コイン未満、ゼロを含む）は各連戦で一度でも発生した数・率。再試行率=給付回数/(9×連戦数)。',
    '最大下落率=給付前ゼロを含む日次財布の過去最高値からの下落率。元本超過損失なし。利益上限なし。',
    'サマリー: 給付 倍率 投入比 平均財布 中央財布 平均純損益 中央純損益 全損% 厳密ゼロ群数 厳密ゼロ% 投入不能群数 投入不能% 実行% 再試行% 平均給付 最大下落%',
  ];
  for (const row of lab.rows) {
    const s = row.summary;
    lines.push([row.refill ? 'あり' : 'なし', `${row.leverage}x`, row.ratio,
      s.mean_final, s.median_final, s.mean_net_profit, s.median_net_profit,
      s.stake_loss_pct, s.wallet_empty_chains, s.wallet_empty_pct,
      s.wallet_unplayable_chains, s.wallet_unplayable_pct,
      s.play_pct, s.retry_pct, s.mean_issued, s.max_drawdown_pct].join('\t'));
  }
  lines.push('以下は各条件の先頭シナリオ群10戦（全サマリーは全群集計）。純損益は給付を除く。');
  for (const row of lab.rows) {
    lines.push(`給付${row.refill ? 'あり' : 'なし'} ${row.leverage}x 投入比${row.ratio}`);
    for (const b of row.example.battles) {
      lines.push(`戦${b.battle} 財布${b.before_grant} 給付${b.grant} 投入${b.amount} 損益${b.profit} →${b.after}` +
        ` 全損=${b.stake_lost} 財布ゼロ=${b.wallet_empty} 投入不能=${b.wallet_unplayable} スキップ=${b.skipped}` +
        ` ロスカット日=${b.liquidated_at_step ?? 'なし'} 投入最大下落%=${b.allocated_drawdown_pct ?? '対象外'} 日次財布=[${b.wallet_path.join(',')}]`);
    }
  }
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    console.log(options.help
      ? '架空・実資産非連動・期待値の証明ではない\nnode scripts/sprint45_highrisk_lab.mjs [--seed 0..4294967295] [--samples 1..1000] [--refill compare|off|on]\n既定: seed=45 samples=20 refill=compare。保存なし、stdoutのみ。'
      : formatReport(runLab(options)));
  } catch (error) {
    console.error(`架空実験エラー: ${error.message}`);
    process.exitCode = 1;
  }
}
