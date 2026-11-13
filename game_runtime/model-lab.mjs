/**
 * Read-only model-variable laboratory.
 *
 * Validates numeric model settings strictly, runs two independent equal-capital
 * synthetic portfolios, and never writes XP, trade records, model versions, or V6.
 */
import {runSyntheticGame} from './practice.mjs';
export const INDICATORS=Object.freeze(['trend','momentum','volatility','reversion']);
const PARAMETERS='fast_window|plugin_strengths|plugin_weights|risk_fraction|slow_window';
const REVISION_KEYS='companion_revision|growth_revision|lineup_revision|source_revision';
const keyed=x=>x && typeof x==='object' && !Array.isArray(x);
const keys=x=>Object.keys(x).sort().join('|');
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const exactInt=(value,min,max)=>Number.isInteger(value) && value>=min && value<=max;

export function validateLabModel(value){
  if(!keyed(value)||keys(value)!==PARAMETERS)throw fail('予測モデルの5項目を指定してください');
  const {fast_window:fast,slow_window:slow,risk_fraction:risk,
    plugin_weights:weights,plugin_strengths:strengths}=value;
  if(!exactInt(fast,2,19)||!exactInt(slow,3,20)||fast>=slow)
    throw fail('期間は2以上、短期より長期が大きく、長期は20以下にしてください');
  if(typeof risk!=='number'||!Number.isFinite(risk) || risk<.05 || risk>1)
    throw fail('仮想投資比率は5〜100％にしてください');
  if(!keyed(weights)||keys(weights)!==[...INDICATORS].sort().join('|')||
     !INDICATORS.every(id=>exactInt(weights[id],0,100))||
     INDICATORS.reduce((sum,id)=>sum+weights[id],0)!==100)
    throw fail('4つの分析の重みは整数で合計100％にしてください');
  if(!keyed(strengths)||keys(strengths)!==[...INDICATORS].sort().join('|')||
     !INDICATORS.every(id=>exactInt(strengths[id],50,150)))
    throw fail('分析の感度はそれぞれ50〜150の整数にしてください');
  return {fast_window:fast,slow_window:slow,risk_fraction:risk,
    plugin_weights:Object.fromEntries(INDICATORS.map(id=>[id,weights[id]])),
    plugin_strengths:Object.fromEntries(INDICATORS.map(id=>[id,strengths[id]]))};
}

export function labRevisions(snapshot,companion){
  return {source_revision:snapshot.source_revision,
    lineup_revision:snapshot.lineup_revision,
    growth_revision:snapshot.growth_revision,
    companion_revision:companion.revision};
}
export function validateLabRevisions(value){
  if(!keyed(value)||keys(value)!==REVISION_KEYS||
     !Object.values(value).every(v=>Number.isSafeInteger(v)&&v>=0))
    throw fail('読込時のモデル版数が必要です');
  return {...value};
}
export function sameLabRevisions(left,right){
  return ['source_revision','lineup_revision','growth_revision','companion_revision']
    .every(key=>left?.[key]===right?.[key]);
}
function report(plan,slot){
  const allocations={mine:0,owl:0,turtle:0};
  allocations[slot]=100;
  const output=runSyntheticGame({...plan,allocations});
  const wallet=output.characters[slot];
  return {
    final_coins:output.final_coins,profit_coins:output.profit_coins,
    return_pct:output.return_pct,max_drawdown_pct:output.max_drawdown_pct,
    trades:wallet.trades,fees:wallet.fees,long_steps:wallet.long_steps,
    effective_sha256:wallet.effective_sha256,
    equity_path:output.equity_path,
    signals:output.decisions.map(x=>x.signals[slot]),
  };
}

export function compareLabPlan(plan,baseline,candidate){
  if(plan?.mode!=='PRACTICE_SYNTHETIC_ONLY'||plan.future_prices?.length!==12||
     plan.signals?.length!==12)throw fail('固定架空12日間の予測結果以外は比較できません',503);
  const original=report(plan,'owl');
  const changed=report(plan,'mine');
  const different_signals=original.signals.reduce((n,s,i)=>n+(s!==changed.signals[i]?1:0),0);
  return {
    mode:'PRACTICE_SYNTHETIC_ONLY',scope:'MODEL_VARIABLES_FIXED_SYNTHETIC_12',
    comparison_only:true,save_performed:false,xp_awarded:false,
    live_market:false,holdout_evaluated:false,
    initial_coins_each:plan.initial_coins,fee_rate_pct:plan.fee_rate*100,
    baseline:{parameters:validateLabModel(baseline),...original},
    candidate:{parameters:validateLabModel(candidate),...changed},
    difference:{
      return_pct:Math.round((changed.return_pct-original.return_pct)*100)/100,
      profit_coins:Math.round((changed.profit_coins-original.profit_coins)*100)/100,
      drawdown_pct:Math.round((changed.max_drawdown_pct-original.max_drawdown_pct)*100)/100,
      different_signals,
    },
    notice:'同じ固定の架空12日間で比較しています。これは保留期間の評価ではなく、未来の予測能力や実相場の利益を示しません。モデル・XP・学習結果の保存はありません。',
  };
}
