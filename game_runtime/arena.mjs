/** Fair, synthetic, read-only comparison of three full-capital model portfolios. */
import {runSyntheticGame} from './practice.mjs';
export const SLOTS = Object.freeze(['mine','owl','turtle']);
const TRAINED = /^tv_[0-9a-f]{32}$/;

export function validateContenders(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join('|') !== 'mine|owl|turtle') {
    throw Object.assign(Error('3モデルの組み合わせが必要です'),{status:400});
  }
  const chosen = {};
  const seen = new Set();
  for (const slot of SLOTS) {
    const v = value[slot];
    if (typeof v !== 'string' ||
        !(TRAINED.test(v) || v === (slot === 'mine' ? 'self' : 'preset'))) {
      throw Object.assign(Error('比較モデルの指定が不正です'),{status:400});
    }
    if (TRAINED.test(v)) {
      if (seen.has(v)) throw Object.assign(Error('同じ学習版を2体には指定できません'),{status:400});
      seen.add(v);
    }
    chosen[slot] = v;
  }
  return chosen;
}

export function makeFairComparison(plan, contenders, metadata) {
  if (plan?.mode !== 'PRACTICE_SYNTHETIC_ONLY' ||
      !Array.isArray(plan.future_prices) || plan.future_prices.length !== 12 ||
      !Array.isArray(plan.signals) || plan.signals.length !== 12) {
    throw Error('12日間の固定架空シナリオ以外は比較できません');
  }
  const checked = validateContenders(contenders);
  const fighters = {};
  let benchmark = null;
  for (const slot of SLOTS) {
    const allocations = {mine:0,owl:0,turtle:0};
    allocations[slot] = 100;
    const result = runSyntheticGame({...plan,allocations});
    if (benchmark === null) benchmark = result.benchmark_buy_hold_pct;
    if (!Number.isFinite(result.return_pct) || !Number.isFinite(result.max_drawdown_pct)) {
      throw Error('比較結果が不正です');
    }
    const model = result.characters[slot];
    fighters[slot] = {
      slot, choice:checked[slot], kind:metadata[slot].kind,
      name:metadata[slot].name, version_id:metadata[slot].version_id || null,
      source_draft_id:metadata[slot].source_draft_id || null,
      parameters_sha256:metadata[slot].parameters_sha256 || null,
      effective_sha256:model.effective_sha256,
      initial_coins:result.initial_coins, final_coins:result.final_coins,
      profit_coins:result.profit_coins, return_pct:result.return_pct,
      max_drawdown_pct:result.max_drawdown_pct,
      fees:model.fees, trades:model.trades, long_steps:model.long_steps,
      equity_path:result.equity_path,
      signals:result.decisions.map(day=>day.signals[slot]),
    };
  }
  const ranking = [...SLOTS].sort((left,right)=>
    fighters[right].final_coins-fighters[left].final_coins ||
    SLOTS.indexOf(left)-SLOTS.indexOf(right));
  return {
    mode:'PRACTICE_SYNTHETIC_ONLY', comparison_only:true, xp_awarded:false,
    scenario:'FIXED_SYNTHETIC_12', period_steps:12,
    initial_coins_per_model:plan.initial_coins,
    fee_rate_pct:plan.fee_rate * 100,
    gear_applied:false, benchmark_buy_hold_pct:benchmark,
    prices:[plan.initial_price,...plan.future_prices],
    ranking, fighters,
    notice:'同じ架空12日・同額・同手数料で比較。これは予測能力や実際の利益の証明ではありません。XPと対戦ランキングには反映しません。',
  };
}
