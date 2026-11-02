/** Fair, synthetic, read-only comparison of three full-capital model portfolios. */
import {runSyntheticGame} from './practice.mjs';
export const SLOTS = Object.freeze(['mine','owl','turtle']);
const TRAINED = /^tv_[0-9a-f]{32}$/;
const TRAITS = Object.freeze({
  trend:{name:'流れ読み',nature:'長い流れを見守る分析家',hair:'#9c86e8',clothing:'#6b9adb',hair_style:'long',accessory:'star'},
  momentum:{name:'勢い派',nature:'新しい動きに素早く反応',hair:'#f4a76a',clothing:'#dd729b',hair_style:'twintails',accessory:'ribbon'},
  reversion:{name:'逆張り派',nature:'行き過ぎを冷静に見つめる',hair:'#abb0eb',clothing:'#6dbaa9',hair_style:'bob',accessory:'glasses'},
  volatility:{name:'変動警戒派',nature:'大きな揺れを慎重に観察',hair:'#83d5c8',clothing:'#728ed7',hair_style:'long',accessory:'glasses'},
});
const KEYS = Object.keys(TRAITS);
export function personaFromModel(model, appearance = null) {
  const weights = model?.plugin_weights;
  if (!weights || Object.keys(weights).sort().join('|') !== [...KEYS].sort().join('|') ||
    !KEYS.every(key=>Number.isInteger(weights[key]) && weights[key]>=0 && weights[key]<=100) ||
    KEYS.reduce((s,key)=>s+weights[key],0)!==100) {
    throw Error('擬人化するモデルの予測配分が不正です');
  }
  const sorted = [...KEYS].sort((a,b)=>weights[b]-weights[a] || KEYS.indexOf(a)-KEYS.indexOf(b));
  const top=sorted[0];
  const mixed = weights[top]<50 || weights[top]-weights[sorted[1]]<15;
  const base=TRAITS[top];
  const given=appearance?.look;
  const validLook=given && ['bob','long','twintails'].includes(given.hair_style) &&
    ['cheerful','calm','determined'].includes(given.expression) &&
    ['ribbon','glasses','star','none'].includes(given.accessory);
  const appearanceVariants=[
    {hair_style:base.hair_style,accessory:base.accessory,
      hair_color:base.hair,clothing_color:base.clothing},
    {hair_style:'bob',accessory:'glasses',
      hair_color:'#94a5dd',clothing_color:'#7ba7b9'},
    {hair_style:'twintails',accessory:'ribbon',
      hair_color:'#e4a2cb',clothing_color:'#7d93d0'},
    {hair_style:'long',accessory:'star',
      hair_color:'#8ccac5',clothing_color:'#a17fc5'},
  ];
  // This changes only the 2D portrait. The SHA identifies the actual forecast
  // model, never the rank, daily return or a cosmetic random seed.
  const variant=/^[0-9a-f]{64}$/.test(model.effective_sha256||'') ?
    parseInt(model.effective_sha256.slice(0,2),16)%appearanceVariants.length : 0;
  const costume=appearanceVariants[variant];
  const color=appearance?.companion;
  const colorValid=color && /^#[0-9a-f]{6}$/i.test(color.hair_color) &&
    /^#[0-9a-f]{6}$/i.test(color.clothing_color);
  return {
    type:mixed?'mixed':top, label:mixed?'複合タイプ':base.name,
    nature:mixed?'複数の分析を組み合わせて考える':base.nature,
    weights:{...weights}, risk_fraction:model.risk_fraction,
    look:{
      hair_style:validLook?given.hair_style:costume.hair_style,
      expression:validLook?given.expression:'cheerful',
      accessory:validLook?given.accessory:costume.accessory,
      hair_color:colorValid?color.hair_color:costume.hair_color,
      clothing_color:colorValid?color.clothing_color:costume.clothing_color,
    },
    look_source: validLook || colorValid ? 'player_saved' : 'model_default',
  };
}

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
      persona:personaFromModel(plan.models[slot],metadata[slot].appearance),
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
