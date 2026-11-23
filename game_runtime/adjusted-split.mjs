import {compareAdjustedResearchWindow,modelMatches,summarizeWindows} from './historical-market.mjs';
import {validateLabModel} from './model-lab.mjs';

const ORIGIN='LOCAL_PRIVATE_JQUANTS_ADJUSTED_RESEARCH';
const SOURCE='J-Quants V2 adjusted close (private local research archive)';
const STATUS='PARTIAL_485_OF_487_RESEARCH_ONLY_NOT_FORWARD';
const CODES=['40050','46890','47550','50200','72010','84100','85930','86040','94320','95010'];
const FIRST='2024-08-05', CUTOFF='2025-08-01', LAST='2026-07-31';
const MISSING=['2024-08-01','2024-08-02'];
const FLAGS=['rights_verified','license_verified','pit_verified','corporate_action_verified','full_historical_coverage',
  'forward_eligible','training_eligible','actual_forward_eligible','live_forward_eligible',
  'forecast_accuracy_established','model_trained','official_allowed','production_certified','trading_allowed'];
const LOOKBACK=24, HORIZON=12, WIDTH=LOOKBACK+HORIZON;
const fail=()=>Object.assign(Error('調整済み株価の研究用比較結果が不正です'),{status:503});
const keys=value=>value && typeof value==='object' && !Array.isArray(value) ? Object.keys(value).sort().join('|') : '';

function calendarDates(calendar) {
  if(!Array.isArray(calendar) || calendar.length!==485 || calendar[0]!==FIRST || calendar.at(-1)!==LAST)throw fail();
  return Array.from(calendar,(value,index)=>{
    if(typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || (index>0 && value<=calendar[index-1]))throw fail();
    const time=Date.parse(value);
    if(!Number.isFinite(time) || new Date(time).toISOString().slice(0,10)!==value)throw fail();
    return time/86400000;
  });
}

function schedule(days,from,to) {
  const positions=[];
  for(let start=from;start+WIDTH<=to;) {
    let next=start+1;
    while(next<start+WIDTH && days[next]-days[next-1]<=10)next++;
    if(next===start+WIDTH)positions.push(start);
    start=next;
  }
  if(!positions.length)throw fail();
  return positions;
}

function phaseMetrics(pairs) {
  const metrics=summarizeWindows(pairs);
  for(const key of Object.keys(metrics)) {
    const delta=Number((pairs.reduce((sum,pair)=>sum+pair.candidate[key]-pair.baseline[key],0)/pairs.length).toFixed(6));
    const benefit=key==='profit_coins'?delta:-delta;
    metrics[key]={...metrics[key],delta,direction:benefit>0?'better':benefit<0?'worse':'tie'};
  }
  return metrics;
}

export function compareAdjustedSplit(payload,baseline,candidate) {
  const control=validateLabModel(baseline), change=validateLabModel(candidate);
  if(payload?.schema!==1 || payload.source_origin!==ORIGIN || payload.adjusted!==true ||
     payload.archive_status!==STATUS || payload.manifests_verified!==true || payload.sessions_per_code!==485 ||
     payload.split_date!==CUTOFF || JSON.stringify(payload.missing_sessions)!==JSON.stringify(MISSING) ||
     keys(payload.flags)!==[...FLAGS].sort().join('|') || !FLAGS.every(flag=>payload.flags[flag]===false) ||
     keys(payload.phases)!=='early|later')throw fail();

  const calendar=payload.calendar, days=calendarDates(calendar);
  const split=calendar.findIndex(day=>day>=CUTOFF);
  const limits={early:[0,split],later:[split,calendar.length]};
  const phases={}, ids=new Set();
  let hashes;
  const sameModels=JSON.stringify(control)===JSON.stringify(change);
  for(const [phase,[from,to]] of Object.entries(limits)) {
    const positions=schedule(days,from,to);
    const rows=payload.phases[phase];
    const count=positions.length*CODES.length;
    if(!Array.isArray(rows) || rows.length!==count || ids.size+count>160)throw fail();
    const reports=[], byCode=[];
    for(const code of CODES) {
      const pairs=[];
      for(const start of positions) {
        const raw=rows[reports.length], plan=raw?.plan, models=plan?.models;
        if(raw?.code!==code || raw.source!==SOURCE || raw.adjusted!==true ||
           raw.eligible_windows!==count || typeof raw.market_id!=='string' || raw.market_id.length!==28 || ids.has(raw.market_id) ||
           raw.start_date!==calendar[start] || raw.history_end_date!==calendar[start+LOOKBACK-1] ||
           raw.end_date!==calendar[start+WIDTH-1] || plan?.initial_price!==100 ||
           ![['owl',control],['turtle',control],['mine',change]].every(([slot,expected])=>{
             const model=models?.[slot];
             return modelMatches(model,expected) && model.fast_window===expected.fast_window && model.slow_window===expected.slow_window;
           }) || models.owl.effective_sha256!==models.turtle.effective_sha256 ||
           sameModels!==(models.owl.effective_sha256===models.mine.effective_sha256) || raw.brier?.owl!==raw.brier?.turtle ||
           !Array.isArray(plan.signals) || !plan.signals.every(row=>row?.owl===row?.turtle && (!sameModels || row.mine===row.owl)) ||
           (sameModels && raw.brier?.mine!==raw.brier?.owl))throw fail();
        const current={baseline:models.owl.effective_sha256,candidate:models.mine.effective_sha256,base:plan.model_sha256};
        if(hashes && Object.keys(current).some(key=>current[key]!==hashes[key]))throw fail();
        hashes ??=current;
        const report=compareAdjustedResearchWindow(raw,control,change);
        ids.add(raw.market_id);
        reports.push(report);
        pairs.push(report);
      }
      byCode.push({code,windows:pairs.length,metrics:phaseMetrics(pairs)});
    }
    const downside=slot=>({max_drawdown_pct:Math.max(...reports.map(pair=>pair[slot].max_drawdown_pct)),
      worst_profit_coins:Math.min(...reports.map(pair=>pair[slot].profit_coins))});
    phases[phase]={sessions_per_code:to-from,calendar_start:calendar[from],calendar_end:calendar[to-1],
      periods:reports.length,window_start:calendar[positions[0]],window_end:calendar[positions.at(-1)+WIDTH-1],
      metrics:phaseMetrics(reports),by_code:byCode,downside:{baseline:downside('baseline'),candidate:downside('candidate')},
      different_signals:reports.reduce((sum,pair)=>sum+pair.difference.different_signals,0),signal_comparisons:reports.length*HORIZON};
  }
  const direction_by_metric=Object.fromEntries(Object.keys(phases.early.metrics).map(key=>
    [key,{early:phases.early.metrics[key].direction,later:phases.later.metrics[key].direction}]));
  return {scope:'ACCESSORY_RULES_ADJUSTED_CHRONOLOGY_RESEARCH_V1',market:{source_origin:ORIGIN,adjusted:true,
    archive_status:STATUS,manifests_verified:true,codes:CODES.length,sessions_per_code:485,missing_sessions:[...MISSING]},
    split_date:CUTOFF,lookback_sessions:LOOKBACK,replay_sessions:HORIZON,weighting:'equal_per_window',phases,direction_by_metric,
    baseline:{effective_sha256:hashes.baseline},candidate:{effective_sha256:hashes.candidate},
    read_only:true,research_only:true,holdout_evaluated:false,trained:false,live_market:false,real_market_history:true,
    rights_verified:false,license_verified:false,point_in_time_verified:false,corporate_actions_verified:false,
    full_historical_coverage:false,forward_eligible:false,training_eligible:false,
    persisted:false,xp_awarded:false,coins_changed:false,order_placed:false,
    notice:'取得時点の調整済み終値を使います。権利・ライセンス、当時の入手可能性、企業行動の処理は未確認です。分析ルールの事前登録はなく、前半も後半も遡及比較です。両期間に同じ保存済みルールを使い、選び直しや学習はしません。銘柄は同じ市場・日程を共有します。'};
}
