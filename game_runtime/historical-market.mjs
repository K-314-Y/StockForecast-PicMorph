/** Read-only evaluation of actual historical prices in a virtual simulator. */
import {runSyntheticGame} from './practice.mjs';
import {INDICATORS,validateLabModel} from './model-lab.mjs';

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

export function compareLocalAccessoryHistory(payload,baseline,candidate,selection){
  if(payload?.source_origin!=='LOCAL_JPX_REPORT_CACHE_2024' || payload.adjusted!==false ||
     (selection.replay_id && payload.market_id!==selection.replay_id) ||
     payload.market_id===selection.exclude_id)throw fail();
  const {baseline:control,candidate:adjusted,...report}=compareHistoricalMarket(payload,baseline,candidate);
  const {period_start,history_end,period_end}=report.market;
  if(![period_start,history_end,period_end].every(day=>day.startsWith('2024-')))throw fail();
  // Return model metadata and aggregates only. The ordered data stays in the bridge.
  const metrics=({signals,equity_path,...aggregate})=>aggregate;
  return {...report,baseline:metrics(control),candidate:metrics(adjusted),
    scope:'ACCESSORY_RULES_HISTORICAL_LOCAL_12',read_only:true,persisted:false,coins_changed:false,order_placed:false,
    notice:'未調整の2024年終値から選んだ1期間の再現です。候補期間は互いに重なるため、独立した検証回数ではありません。分割や配当の影響が残ることがあります。独立した検証用データでの評価は行っていません。'};
}

const LOCAL_CODES=new Set(['40050','46890','47550','50200','72010','84100','85930','86040','94320','95010']);
const BATCH_LIMIT=40;
const DAY=86400000;

function day2024(value) {
  if(typeof value!=='string' || !/^2024-\d{2}-\d{2}$/.test(value))throw fail();
  const date=Date.parse(value);
  if(!Number.isFinite(date) || new Date(date).toISOString().slice(0,10)!==value)throw fail();
  return date/DAY;
}

function modelMatches(data,expected) {
  return data?.risk_fraction===expected.risk_fraction && INDICATORS.every(key=>
    data.plugin_weights?.[key]===expected.plugin_weights[key] && data.plugin_strengths?.[key]===expected.plugin_strengths[key]);
}

function summarizeWindows(windows) {
  const result={};
  for(const [key,direction] of [['brier',-1],['profit_coins',1],['max_drawdown_pct',-1]]) {
    let baseline=0,candidate=0,wins=0,ties=0,losses=0;
    for(const pair of windows) {
      const before=pair.baseline[key],after=pair.candidate[key];
      baseline+=before;
      candidate+=after;
      if(after===before)ties++;
      else if((after-before)*direction>0)wins++;
      else losses++;
    }
    const mean=total=>Number((total/windows.length).toFixed(6));
    result[key]={baseline_mean:mean(baseline),candidate_mean:mean(candidate),wins,ties,losses};
  }
  return result;
}

export function compareLocalAccessoryBatch(payload,baseline,candidate) {
  if(payload?.schema!==1 || !Array.isArray(payload.windows) || payload.windows.length!==payload.selected_windows ||
     payload.windows.length<1 || payload.windows.length>BATCH_LIMIT || !Number.isSafeInteger(payload.eligible_windows) ||
     payload.eligible_windows<payload.windows.length || payload.eligible_windows>LOCAL_CODES.size*(366-35))throw fail();

  const ids=new Set(),byCode=new Map(),reports=[];
  for(const raw of payload.windows) {
    const plan=raw?.plan;
    const models=plan?.models;
    if(!LOCAL_CODES.has(raw?.code) || typeof raw.market_id!=='string' || raw.market_id.length!==28 || ids.has(raw.market_id) ||
       raw.eligible_windows!==payload.eligible_windows || plan?.initial_price!==100 ||
       !modelMatches(models?.owl,baseline) || !modelMatches(models?.turtle,baseline) || !modelMatches(models?.mine,candidate) ||
       models.owl.effective_sha256!==models.turtle.effective_sha256 || raw.brier?.owl!==raw.brier?.turtle ||
       !Array.isArray(plan.signals) || !plan.signals.every(row=>row?.owl===row?.turtle))throw fail();
    const start=day2024(raw.start_date),historyEnd=day2024(raw.history_end_date),end=day2024(raw.end_date);
    if(historyEnd-start<23 || end-historyEnd<12)throw fail();
    const first=reports[0],previous=reports.at(-1)?.market;
    if(previous && (previous.code>raw.code || (previous.code===raw.code && raw.start_date<=previous.period_end)))throw fail();
    const report=compareLocalAccessoryHistory(raw,baseline,candidate,{});
    if(report.market.source!=='SoftHompo-reformatted JPX daily reports (2024)' ||
       (first && (first.market.warning!==report.market.warning || first.baseline.effective_sha256!==report.baseline.effective_sha256 ||
         first.candidate.effective_sha256!==report.candidate.effective_sha256 || first.base_sha256!==plan.model_sha256)))throw fail();
    ids.add(raw.market_id);
    reports.push({...report,base_sha256:plan.model_sha256});
    if(!byCode.has(raw.code))byCode.set(raw.code,[]);
    byCode.get(raw.code).push(report);
  }
  const first=reports[0];
  const coverage={eligible_windows:payload.eligible_windows,selected_windows:reports.length,codes:byCode.size,
    period_start:reports.map(row=>row.market.period_start).sort()[0],period_end:reports.map(row=>row.market.period_end).sort().at(-1),
    lookback_days:first.market.lookback_days,simulation_days:first.market.simulation_days};
  const downside=slot=>({max_drawdown_pct:Math.max(...reports.map(pair=>pair[slot].max_drawdown_pct)),
    worst_profit_coins:Math.min(...reports.map(pair=>pair[slot].profit_coins))});
  const model=slot=>({parameters:first[slot].parameters,effective_sha256:first[slot].effective_sha256});
  return {scope:'ACCESSORY_RULES_HISTORICAL_LOCAL_NONOVERLAP_V1',mode:'HISTORICAL_MARKET_REPLAY_ONLY',
    read_only:true,holdout_evaluated:false,trained:false,live_market:false,real_market_history:true,
    comparison_only:true,save_performed:false,persisted:false,xp_awarded:false,coins_changed:false,order_placed:false,
    market:{source_origin:first.market.source_origin,source:first.market.source,adjusted:false,warning:first.market.warning},
    coverage,weighting:'equal_per_window',selection:'earliest_full_window_per_code',
    baseline:model('baseline'),candidate:model('candidate'),metrics:summarizeWindows(reports),
    downside:{baseline:downside('baseline'),candidate:downside('candidate')},
    different_signals:reports.reduce((sum,pair)=>sum+pair.difference.different_signals,0),
    signal_comparisons:reports.length*coverage.simulation_days,
    by_code:[...byCode].map(([code,windows])=>({code,windows:windows.length,metrics:summarizeWindows(windows)})),
    notice:'各銘柄の24＋12営業日は重複しません。異なる銘柄は同じ市場や日程を共有し、統計的に独立していません。再現する12日間も含めて15%を超える前日比の変動などを除外するため、選択に偏りがあり得ます。独立した検証用データでの評価や学習は行っていません。'};
}
