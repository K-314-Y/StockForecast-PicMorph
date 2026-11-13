/** Read-only evaluation of actual historical prices in a virtual simulator. */
import {runSyntheticGame} from './practice.mjs';
import {validateLabModel} from './model-lab.mjs';

const REGEX=/^mkt_[a-f0-9]{24}$/;
const positive=value=>typeof value==='number'&&Number.isFinite(value)&&value>0;
const validBrier=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=2;
const fail=()=>Object.assign(Error('過去株価の比較結果が不正です'),{status:503});
const round=value=>Math.round(value*100)/100;

function independent(plan,slot){
  const allocations={mine:0,owl:0,turtle:0};
  allocations[slot]=100;
  const result=runSyntheticGame({...plan,allocations});
  const character=result.characters[slot];
  return {
    final_coins:result.final_coins,profit_coins:result.profit_coins,
    return_pct:result.return_pct,max_drawdown_pct:result.max_drawdown_pct,
    fees:character.fees,trades:character.trades,long_steps:character.long_steps,
    effective_sha256:character.effective_sha256,
    signals:result.decisions.map(day=>day.signals[slot]),
    equity_path:result.equity_path,
  };
}
export function compareHistoricalMarket(payload,baseline,candidate){
  validateLabModel(baseline);
  validateLabModel(candidate);
  const plan=payload?.plan;
  if(payload?.mode!=='HISTORICAL_MARKET_REPLAY_ONLY'||
     !['LOCAL_JPX_REPORT_CACHE_2024','JQUANTS_API_V2_CACHE'].includes(payload.source_origin)||
     !REGEX.test(payload.market_id||'')||
     typeof payload.code!=='string'||!/^[0-9A-Z]{5}$/.test(payload.code)||
     ![payload.start_date,payload.history_end_date,payload.end_date].every(d=>
       typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d))||
     !(payload.start_date<payload.history_end_date &&
       payload.history_end_date<payload.end_date)||
     payload.lookback_days!==24||payload.future_days!==12||
     payload.price_index_base!==100||payload.flat_threshold_pct!==.3||
     typeof payload.source!=='string'||typeof payload.source_warning!=='string'||
     typeof payload.adjusted!=='boolean'||
     !Number.isSafeInteger(payload.eligible_windows)||payload.eligible_windows<1||
     plan?.mode!=='PRACTICE_SYNTHETIC_ONLY'||
     plan?.future_prices?.length!==12||plan?.signals?.length!==12||
     !positive(plan.initial_price)||!plan.future_prices.every(positive)||
     !validBrier(payload.brier?.mine)||!validBrier(payload.brier?.owl)||
     plan.initial_coins!==10000||plan.fee_rate!==.001){
    throw fail();
  }
  const control=independent(plan,'owl'),change=independent(plan,'mine');
  return {
    mode:'HISTORICAL_MARKET_REPLAY_ONLY',scope:'MODEL_VARIABLES_HISTORICAL_REPLAY_12',
    comparison_only:true,save_performed:false,xp_awarded:false,
    trained:false,real_market_history:true,live_market:false,holdout_evaluated:false,
    market:{
      id:payload.market_id,code:payload.code,period_start:payload.start_date,
      history_end:payload.history_end_date,period_end:payload.end_date,
      source_origin:payload.source_origin,source:payload.source,
      warning:payload.source_warning,adjusted:payload.adjusted,
      eligible_windows:payload.eligible_windows,
      lookback_days:24,simulation_days:12,flat_threshold_pct:.3,
    },
    initial_coins_each:10000,fee_rate_pct:0.1,
    baseline:{parameters:validateLabModel(baseline),brier:payload.brier.owl,...control},
    candidate:{parameters:validateLabModel(candidate),brier:payload.brier.mine,...change},
    difference:{
      brier:round(payload.brier.mine-payload.brier.owl),
      profit_coins:round(change.profit_coins-control.profit_coins),
      return_pct:round(change.return_pct-control.return_pct),
      drawdown_pct:round(change.max_drawdown_pct-control.max_drawdown_pct),
      different_signals:control.signals.filter((s,i)=>s!==change.signals[i]).length,
    },
    notice:'同じ株価履歴と日程で、確率評価と仮想損益を分離。過去データの再現実験であり、未来・実運用の性能証明ではありません。元の予測モデルとXPは変更しません。',
  };
}
