#!/usr/bin/env node
// Repeatable offline game-only experiment. No network, user saves or broker access.
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {runSyntheticGame} from '../game_runtime/practice.mjs';

const args=process.argv.slice(2);
const valueFor=(flag,fallback)=>{
  const at=args.indexOf(flag);
  return at<0?fallback:args[at+1];
};
const count=Number(valueFor('--count','240'));
const trialSet=valueFor('--set','main');
if (args.some(x=>!['--count','--set','main','holdout',String(count)].includes(x)) ||
    !Number.isSafeInteger(count) || count<4 || count>2000 || count%4!==0 ||
    !['main','holdout'].includes(trialSet)) {
  console.error('Usage: node scripts/benchmark-accessory-ai.mjs [--count N] [--set main|holdout] (N: 4..2000, divisible by 4)');
  process.exit(2);
}
const root=fileURLToPath(new URL('../',import.meta.url));
const strategies=['standard','star','glasses','ribbon','none','triple'];
// Mirrors the game predictor. Only the strategy changes; capital and every
// model parameter are deliberately identical. Future prices are SHA-derived.
const py=String.raw`
import hashlib,json,sys
sys.dont_write_bytecode=True
sys.path.insert(0,sys.argv[1])
from game_runtime.predict_bridge import create_prediction_plan
count=int(sys.argv[2]);name=sys.argv[3]
prefix='creature-v1-'+('precommitted' if name=='main' else 'heldout')+'-20261123-'
model={'fast_window':3,'slow_window':9,'risk_fraction':.35,'plugin_weights':{'trend':100,'momentum':0,'reversion':0,'volatility':0},'plugin_strengths':{'trend':100,'momentum':100,'reversion':100,'volatility':100}}
for i in range(count):
    token='v1_'+hashlib.sha256((prefix+str(i)).encode('ascii')).hexdigest()[:16]
    for strategy in ('standard','star','glasses','ribbon','none','triple'):
        plan={'base_model':model,'models':{'mine':model,'owl':model,'turtle':model},'scenario_token':token}
        if strategy=='triple':plan['accessory_methods']=['bollinger_breakout','rsi_oversold','macd_momentum']
        elif strategy!='standard':plan['accessory_strategy']=strategy
        result=create_prediction_plan(plan)
        result.update({'initial_coins':1000,'allocations':{'mine':100,'owl':0,'turtle':0}})
        print(json.dumps({'i':i,'name':strategy,'plan':result},separators=(',',':')))
`;
const child=spawn('python3',['-B','-c',py,root,String(count),trialSet],{stdio:['ignore','pipe','pipe']});
let err='';
child.stderr.setEncoding('utf8');
child.stderr.on('data',chunk=>{err=(err+chunk).slice(-2500)});
const closed=new Promise((resolve,reject)=>{
  child.once('error',reject);
  child.once('close',code=>code===0?resolve():reject(Error('Python exited '+code+': '+err)));
});
const runs=new Map();
let planCount=0;
for await(const line of createInterface({input:child.stdout,crlfDelay:Infinity})){
  if(!line)continue;
  const {i,name,plan}=JSON.parse(line);
  if(!Number.isInteger(i)||i<0||i>=count||!strategies.includes(name))throw Error('Unexpected plan identifier');
  const result=runSyntheticGame(plan);
  const row=runs.get(i)??{};
  if(row[name])throw Error('Duplicate plan for '+i+' '+name);
  row[name]={profit:result.profit_coins,drawdown:result.max_drawdown_pct,
    trades:result.characters.mine.trades,fee:result.characters.mine.fees,
    longDays:result.characters.mine.long_steps,
    priceSignature:createHash('sha256').update(JSON.stringify(plan.future_prices)).digest('hex'),
    signal:plan.signals.map(x=>x.mine).join(','),firstSignal:plan.signals[0].mine};
  runs.set(i,row);planCount++;
}
await closed;
if(runs.size!==count||planCount!==count*strategies.length)throw Error('Incomplete prediction batch');
const sorted=Array.from({length:count},(_,i)=>{
  const row=runs.get(i);
  if(!row||strategies.some(name=>!row[name]))throw Error('Missing strategy in scenario '+i);
  if(new Set(strategies.map(name=>row[name].priceSignature)).size!==1)throw Error('Mismatched synthetic prices');
  return row;
});
const average=values=>values.reduce((a,b)=>a+b,0)/values.length;
const sortedValues=v=>[...v].sort((a,b)=>a-b);
const median=v=>{const s=sortedValues(v),m=s.length/2;return (s[Math.floor(m)]+s[Math.ceil(m)-1])/2};
const round=(n,d=2)=>Number(n.toFixed(d));
const results={};
for (const strategy of strategies) {
  const xs=sorted.map(row=>row[strategy]);
  const profits=xs.map(x=>x.profit);
  results[strategy]={meanProfit:round(average(profits)),medianProfit:round(median(profits)),
    winningCases:profits.filter(x=>x>0).length,worstProfit:Math.min(...profits),
    averageMaxDrawdownPct:round(average(xs.map(x=>x.drawdown)),3),
    averageTrades:round(average(xs.map(x=>x.trades))),
    averageLongDays:round(average(xs.map(x=>x.longDays))),
    totalFees:round(xs.reduce((sum,x)=>sum+x.fee,0),3)};
}
const tripleComparisons={};
for(const strategy of strategies.filter(x=>x!=='triple')){
  const differences=sorted.map(row=>row.triple.profit-row[strategy].profit);
  tripleComparisons[strategy]={meanDifference:round(average(differences),3),
    tripleBetter: differences.filter(x=>x>0).length,
    tied:differences.filter(x=>x===0).length,
    tripleWorse:differences.filter(x=>x<0).length};
}
const blocks=Array.from({length:4},(_,block)=>{
  const rows=sorted.slice(block*count/4,(block+1)*count/4);
  return {block:block+1,meanTripleProfit:round(average(rows.map(x=>x.triple.profit))),
    meanTripleMinusStandard:round(average(rows.map(x=>x.triple.profit-x.standard.profit)))};
});
console.log(JSON.stringify({mode:'SYNTHETIC_12_DAY_GAME_ONLY',set:trialSet,scenarios:count,
  plans:planCount,initialCoins:1000,riskFraction:.35,feeRate:.001,
  pricesMatched:true,modelParametersMatched:true,
  firstDecisionsIndependentOfFuture:new Set(sorted.map(x=>x.triple.firstSignal)).size===1,
  results,tripleComparisons,blocks},null,2));
