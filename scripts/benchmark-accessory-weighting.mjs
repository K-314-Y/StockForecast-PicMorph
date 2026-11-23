#!/usr/bin/env node
// Research-only experiment. Calls Python locally and performs synthetic game accounting.
// Does not change the game model, access real market data, or write player saves.
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {runSyntheticGame} from '../game_runtime/practice.mjs';

const args=process.argv.slice(2);
const option=(flag,fallback)=>{
  const i=args.indexOf(flag);
  return i<0?fallback:args[i+1];
};
const count=Number(option('--count','240'));
const cohort=option('--set','development');
if (!Number.isSafeInteger(count) || count<4 || count>2000 || count%4!==0 ||
    !['development','validation'].includes(cohort) ||
    args.length%2!==0 ||
    args.some((v,i)=>i%2===0?!['--count','--set'].includes(v):v===undefined)) {
  console.error('Usage: node scripts/benchmark-accessory-weighting.mjs [--count N] [--set development|validation]');
  process.exit(2);
}

const root=fileURLToPath(new URL('../',import.meta.url));
const py=String.raw`
import copy,hashlib,json,sys
sys.dont_write_bytecode=True
sys.path.insert(0,sys.argv[1])
from engine import SYNTHETIC_PRICES,prediction
from game_runtime.predict_bridge import create_prediction_plan,model_from_record
from game_runtime.accessory_analysis import experimental_strength_weighted_signal,EXPERIMENTAL_STRENGTH_VERSION
count=int(sys.argv[2]);cohort=sys.argv[3]
model={'fast_window':3,'slow_window':9,'risk_fraction':.35,
'plugin_weights':{'trend':100,'momentum':0,'reversion':0,'volatility':0},
'plugin_strengths':{'trend':100,'momentum':100,'reversion':100,'volatility':100}}
engine=model_from_record(model)
methods=['bollinger_breakout','rsi_oversold','macd_momentum']
for i in range(count):
    token='v1_'+hashlib.sha256(('accessory-strength-v1-'+cohort+'-20261123-'+str(i)).encode('ascii')).hexdigest()[:16]
    request={'base_model':model,'models':{'mine':model,'owl':model,'turtle':model},
             'scenario_token':token,'accessory_methods':methods}
    equal=create_prediction_plan(request)
    weighted=copy.deepcopy(equal)
    history=list(SYNTHETIC_PRICES)
    for idx,next_price in enumerate(equal['future_prices']):
        baseline_up=prediction(engine,tuple(history))['UP']
        weighted['signals'][idx]['mine']=experimental_strength_weighted_signal(methods,tuple(history),baseline_up)
        history.append(next_price)
    weighted['models']['mine']['effective_sha256']=hashlib.sha256(
      (equal['models']['mine']['effective_sha256']+'\n'+EXPERIMENTAL_STRENGTH_VERSION).encode()).hexdigest()
    for mode,plan in (('equal',equal),('strength',weighted)):
        plan.update({'initial_coins':1000,'allocations':{'mine':100,'owl':0,'turtle':0}})
        print(json.dumps({'i':i,'mode':mode,'plan':plan},separators=(',',':')))
`;

const child=spawn('python3',['-B','-c',py,root,String(count),cohort],{
  stdio:['ignore','pipe','pipe']
});
let errors='';
child.stderr.setEncoding('utf8');
child.stderr.on('data',s=>errors=(errors+s).slice(-3500));
const done=new Promise((resolve,reject)=>{
  child.once('error',reject);
  child.once('close',code=>code===0?resolve():reject(Error('Python failed '+code+': '+errors)));
});

const scenarios=new Map();
let received=0;
for await (const line of createInterface({input:child.stdout,crlfDelay:Infinity})){
  if(!line.trim())continue;
  const {i,mode,plan}=JSON.parse(line);
  if(!Number.isSafeInteger(i)||i<0||i>=count||!['equal','strength'].includes(mode)){
    throw Error('Invalid scenario response');
  }
  const game=runSyntheticGame(plan);
  const row=scenarios.get(i)??{};
  if(row[mode])throw Error('Duplicate scenario');
  row[mode]={
    profit:game.profit_coins,
    maxDrawdown:game.max_drawdown_pct,
    fees:game.characters.mine.fees,
    trades:game.characters.mine.trades,
    longDays:game.characters.mine.long_steps,
    first:plan.signals[0].mine,
    decisions:plan.signals.map(s=>s.mine),
    pricesHash:createHash('sha256').update(JSON.stringify(plan.future_prices)).digest('hex')
  };
  scenarios.set(i,row);
  received++;
}
await done;
if(received!==count*2 || scenarios.size!==count)throw Error('Incomplete result count');
const pairs=Array.from({length:count},(_,i)=>{
  const p=scenarios.get(i);
  if(!p?.equal||!p.strength||p.equal.pricesHash!==p.strength.pricesHash){
    throw Error('Missing or non-identical scenarios');
  }
  return p;
});
const sum=v=>v.reduce((a,b)=>a+b,0);
const mean=v=>sum(v)/v.length;
const sorted=v=>[...v].sort((a,b)=>a-b);
const median=v=>{const s=sorted(v);return(s[(s.length-1)>>1]+s[s.length>>1])/2};
const round=(v,d=3)=>Number(v.toFixed(d));
// Approximate sampling uncertainty; not a claim of real-market performance.
const approximate95Interval=values=>{
  const avg=mean(values);
  const variance=sum(values.map(value=>(value-avg)**2))/(values.length-1);
  const margin=1.96*Math.sqrt(variance/values.length);
  return {lower:round(avg-margin),upper:round(avg+margin)};
};
const stats={};
for (const mode of ['equal','strength']){
  const rows=pairs.map(p=>p[mode]);
  const profit=rows.map(r=>r.profit);
  stats[mode]={
    meanProfit:round(mean(profit)),medianProfit:round(median(profit)),
    wins:profit.filter(v=>v>0).length, p10Profit:sorted(profit)[Math.floor((count-1)*.1)],
    worstProfit:Math.min(...profit),
    meanMaxDrawdownPct:round(mean(rows.map(r=>r.maxDrawdown))),
    worstDrawdownPct:Math.max(...rows.map(r=>r.maxDrawdown)),
    meanTrades:round(mean(rows.map(r=>r.trades))),
    meanLongDays:round(mean(rows.map(r=>r.longDays))),
    totalFees:round(sum(rows.map(r=>r.fees))),
  };
}
const delta=pairs.map(p=>p.strength.profit-p.equal.profit);
const block=Array.from({length:4},(_,idx)=>{
  const s=pairs.slice(idx*count/4,(idx+1)*count/4);
  return {block:idx+1,meanDelta:round(mean(s.map(p=>p.strength.profit-p.equal.profit)))};
});
const drawdownDelta=pairs.map(p=>p.strength.maxDrawdown-p.equal.maxDrawdown);
const profitDelta95Approx=approximate95Interval(delta);
const drawdownDelta95Approx=approximate95Interval(drawdownDelta);
const changed=pairs.filter(p=>p.equal.decisions.join()!=p.strength.decisions.join()).length;
const changedDays=sum(pairs.map(p=>p.equal.decisions.filter((v,i)=>v!==p.strength.decisions[i]).length));
const firstIndependentOfFuture=['equal','strength'].every(m=>
  new Set(pairs.map(p=>p[m].first)).size===1);
console.log(JSON.stringify({
  mode:'UNTRAINED_SYNTHETIC_ACCESSORY_EXPERIMENT',
  version:'accessory-strength-experiment-v1',set:cohort,scenarios:count,plans:received,
  samePrices:true,sameBaseModel:true,initialCoins:1000,feeRate:0.001,
  uncertaintyMethod:'normal-approximation-95-percent',
  firstDecisionsIndependentOfFuture:firstIndependentOfFuture,
  strategies:stats,
  paired:{
    meanProfitDelta:round(mean(delta)),medianProfitDelta:round(median(delta)),
    meanProfitDelta95Approx:profitDelta95Approx,
    profitImprovementSupported:profitDelta95Approx.lower>0,
    meanDrawdownDelta:round(mean(drawdownDelta)),
    meanDrawdownDelta95Approx:drawdownDelta95Approx,
    drawdownImprovementSupported:drawdownDelta95Approx.upper<0,
    strengthBetter:delta.filter(v=>v>0).length,
    equalBetter:delta.filter(v=>v<0).length,
    tied:delta.filter(v=>v===0).length,
    changedCases:changed,changedDays,
    byBlock:block
  }
},null,2));
