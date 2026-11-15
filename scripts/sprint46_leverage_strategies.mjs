import {pathToFileURL} from 'node:url';
import {makeScenarios, makePlan, summarize as summarizeBaseline} from './sprint45_highrisk_lab.mjs';
import {runSyntheticGame} from '../game_runtime/practice.mjs';
import {settleLeveragedPractice} from '../game_runtime/leverage-practice.mjs';

export const POLICIES = Object.freeze(['fixed5', 'fixed25', 'hot25', 'protect']);
export const RATIOS = Object.freeze([0.1, 0.5, 1]);
const START = 3000, BATTLES = 10, STEPS = 12;
const cents = n => Math.round((n + Number.EPSILON) * 100) / 100;
const validSeed = n => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;

// Sprint45-compatible accounting below deliberately preserves its rounding order.
// Only historical scalar values cross this boundary; clone before freezing.
export function makeSnapshot(wallet, peak_wallet, prior_scores) {
  if (![wallet, peak_wallet].every(n => Number.isFinite(n) && n >= 0 &&
      Number.isSafeInteger(Math.round(n * 100))) || peak_wallet < wallet ||
      !Array.isArray(prior_scores) || prior_scores.length > 9 ||
      !prior_scores.every(n => Number.isFinite(n) && Number.isSafeInteger(Math.round(n * 100)))) {
    throw new RangeError('政策履歴が不正');
  }
  return Object.freeze({wallet, peak_wallet, prior_scores: Object.freeze([...prior_scores])});
}

export function chooseLeverage(policy, snapshot) {
  if (!POLICIES.includes(policy) || !snapshot || !Object.isFrozen(snapshot) ||
      Object.keys(snapshot).sort().join('|') !== 'peak_wallet|prior_scores|wallet' ||
      !Object.isFrozen(snapshot.prior_scores)) throw new RangeError('凍結政策入力が不正');
  const {wallet, peak_wallet, prior_scores} = snapshot;
  makeSnapshot(wallet, peak_wallet, prior_scores); // same validation for direct callers
  if (policy === 'fixed5') return 5;
  if (policy === 'fixed25') return 25;
  if (policy === 'protect') return wallet < peak_wallet * 0.7 ? 1 : 10;
  return prior_scores.length >= 2 && prior_scores.slice(-2).every(n => n > 0) ? 25 : 5;
}

export function parseArgs(args) {
  const options = {seed: 46, samples: 20, refill: 'off', help: false};
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

function maxDrawdown(path) {
  let peak = path[0], maximum = 0;
  for (const value of path) {
    peak = Math.max(peak, value);
    if (peak > 0) maximum = Math.max(maximum, 1 - value / peak);
  }
  return cents(maximum * 100);
}

export function runStrategyChain(scenarios, {policy, ratio, refill}) {
  if (!POLICIES.includes(policy) || !RATIOS.includes(ratio) || typeof refill !== 'boolean' ||
      !Array.isArray(scenarios) || scenarios.length !== BATTLES ||
      !scenarios.every(s => s && s.future_prices?.length === STEPS && s.signals?.length === STEPS)) {
    throw new RangeError('10戦×12ステップ・倍率・投入比率・給付設定が不正');
  }
  let wallet = START, issued = 0, grants = 0;
  const battles = [], walletPath = [wallet], referenceScores = [];
  for (let index = 0; index < BATTLES; index++) {
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
    // No scenario reference exists in the chooser input. Lock before reading this battle.
    const snapshot = makeSnapshot(wallet, Math.max(...walletPath), referenceScores);
    const leverage = chooseLeverage(policy, snapshot);
    const scenario = scenarios[index];
    const observeCompletedBattle = () => {
      const base = runSyntheticGame(makePlan(scenario, 1000));
      const score = settleLeveragedPractice({equityPath: base.equity_path,
        amount: 1000, leverage: 1, available: 1000}).profit_coins;
      if (![score, ...base.equity_path].every(n => Number.isFinite(n) && Number.isSafeInteger(Math.round(n * 100)))) {
        throw new RangeError('1倍基準スコアが安全に表現できる数値範囲を超過');
      }
      referenceScores.push(score);
      Object.assign(battles.at(-1), {leverage, snapshot, reference_score: score});
    };
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
      observeCompletedBattle();
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
    observeCompletedBattle();
  }
  return {policy, ratio, refill, reference_scores: referenceScores, final: wallet, issued, grants,
    net_profit: cents(wallet - START - issued), battles, wallet_path: walletPath,
    max_drawdown_pct: maxDrawdown(walletPath)};
}

export function summarize(chains) {
  const base = summarizeBaseline(chains);
  const battles = chains.flatMap(c => c.battles);
  return {...base,
    leverage25_pct: cents(100 * battles.filter(b => b.leverage === 25).length / battles.length),
    total_issued: chains.reduce((n, c) => n + c.issued, 0),
    total_grants: chains.reduce((n, c) => n + c.grants, 0)};
}

export function runLab({seed = 46, samples = 20, refill = 'off'} = {}) {
  if (!['off', 'on', 'compare'].includes(refill)) throw new RangeError('給付設定が不正');
  const scenarios = makeScenarios(seed, samples), rows = [];
  for (const enabled of refill === 'compare' ? [false, true] : [refill === 'on']) {
    for (const policy of POLICIES) for (const ratio of RATIOS) {
      const chains = scenarios.map(s => runStrategyChain(s, {policy, ratio, refill: enabled}));
      rows.push({policy, ratio, refill: enabled, summary: summarize(chains), example: chains[0]});
    }
  }
  return {seed, samples, rows};
}

export function formatReport(lab) {
  const lines = [
    'Sprint46 架空相場・10連戦政策比較 — 本物のAIではない・実資産非連動・期待値の証明ではない',
    `seed=${lab.seed} サンプル=${lab.samples} 初期3000 C・10戦×12ステップ・手数料0.1%`,
    '全政策で同じ架空価格・未来に基づかない事前固定AIシグナルを共用。未来株価予測の実装ではない。',
    '倍率なし基準収益（AI予測精度とは別）は毎戦1倍固定・1000 C基準の純利益。モデル賢さランキングではない。各戦終了後に記録し、スキップ戦も公開経路から観測する。',
    'fixed5=5倍、fixed25=25倍、hot25=直前2戦の独立1倍利益が両方正なら25倍/他5倍（過去好調であり未来の予測力ではない）。',
    'protect=開始時財布が過去の日次財布最高額の70%未満なら1倍/他10倍。給付後に選択、給付も最高額に含む。',
    '倍率は開始時に確定。投入=floor(floor(財布)×比率)、端数保持。全損後は戦内復活なし、投入以外の現金保持、借金なし、利益上限なし。',
    '給付onのみ財布1未満なら次戦開始時3000 C加算。純損益=最終財布−3000−給付発行額（全額控除）。無限発行はバランスを崩し得る。',
    '全損%=投入全損/実行戦、実行%=実行戦/全10戦、25倍%=選択戦/全10戦（スキップも選択）。',
    '不能群/ゼロ群=一度でも財布1未満/厳密ゼロになった連鎖数。最大下落%=給付前を含む日次財布の過去最高からの最悪下落。',
    '給付 | 政策 | 投入% | 平均財布 | 中央財布 | 平均純損益 | 中央純損益 | 最大下落% | 実行% | 全損% | 不能群 | 不能% | ゼロ群 | 25倍% | 平均給付 | 総給付(控除額)',
  ];
  for (const r of lab.rows) {
    const s = r.summary;
    lines.push([r.refill ? 'on' : 'off', r.policy, r.ratio * 100, s.mean_final, s.median_final,
      s.mean_net_profit, s.median_net_profit, s.max_drawdown_pct, s.play_pct, s.stake_loss_pct,
      s.wallet_unplayable_chains, s.wallet_unplayable_pct, s.wallet_empty_chains,
      s.leverage25_pct, s.mean_issued, s.total_issued].join(' | '));
  }
  lines.push('各条件の先頭連鎖（基準1倍スコアは全政策共通、当該戦の選択後に公開）:');
  for (const r of lab.rows) {
    lines.push(`${r.refill ? 'on' : 'off'} ${r.policy} 投入${r.ratio * 100}% 最終${r.example.final} 純損益${r.example.net_profit} 給付控除${r.example.issued}`);
    for (const b of r.example.battles) lines.push(
      `戦${b.battle} ${b.leverage}倍 財布${b.before_grant} 給付${b.grant} 投入${b.amount} 損益${b.profit} →${b.after} skip=${b.skipped} 基準1倍=${b.reference_score} 日次財布=[${b.wallet_path.join(',')}]`);
  }
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    console.log(options.help
      ? '架空相場・本物のAIではない・実資産非連動・期待値の証明ではない\nnode scripts/sprint46_leverage_strategies.mjs [--seed 0..4294967295] [--samples 1..1000] [--refill off|on|compare]\n既定seed=46 samples=20 refill=off。標準出力のみ、保存なし。'
      : formatReport(runLab(options)));
  } catch (error) {
    console.log(`架空実験エラー: ${error.message}`);
    process.exitCode = 1;
  }
}
