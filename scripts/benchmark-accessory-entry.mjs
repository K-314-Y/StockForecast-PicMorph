// Offline research only; no live market access, no player data changes.
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {runSyntheticGame} from '../game_runtime/practice.mjs';
const version='accessory-entry-confirmation-v1';
const modes=['equal','confirm','cash'];
const hash=s=>createHash('sha256').update(s).digest('hex');
export function confirmEntries(signals){
  if(!Array.isArray(signals)||!signals.length||signals.some(s=>!['LONG','CASH'].includes(s)))throw Error('Invalid signals');
  let previous='CASH';
  return signals.map(s=>{const next=s==='LONG'&&previous==='LONG'?'LONG':'CASH';previous=s;return next;});
}
export function candidatePlan(plan,mode){
  if(!modes.includes(mode))throw Error('Unknown mode');
  const next=structuredClone(plan);
  if(mode==='equal')return next;
  const base=next.signals.map(s=>s.mine);
  const output=mode==='cash'?base.map(()=> 'CASH'):confirmEntries(base);
  next.signals.forEach((s,i)=>s.mine=output[i]);
  next.models.mine.effective_sha256=hash(next.models.mine.effective_sha256+'\n'+version+'\n'+mode);
  return next;
}
const mean=v=>v.reduce((a,b)=>a+b,0)/v.length;
const round=v=>Number(v.toFixed(6));
const median=v=>{const s=[...v].sort((a,b)=>a-b);return(s[(s.length-1)>>1]+s[s.length>>1])/2};
function ci(v){const a=mean(v),m=1.96*Math.sqrt(v.reduce((s,x)=>s+(x-a)**2,0)/(v.length-1)/v.length);return {lower:round(a-m),upper:round(a+m)}}
function summarize(rows){
  const strategies=Object.fromEntries(modes.map(mode=>{
    const r=rows.map(x=>x[mode]),p=r.map(x=>x.profit);
    return [mode,{meanProfit:round(mean(p)),medianProfit:median(p),meanDrawdownPct:round(mean(r.map(x=>x.drawdown))),meanTrades:round(mean(r.map(x=>x.trades))),meanLongDays:round(mean(r.map(x=>x.longDays))),meanFees:round(mean(r.map(x=>x.fees))),activeCases:r.filter(x=>x.longDays>0).length,winningCases:p.filter(x=>x>0).length,meanNoFeeProfit:round(mean(r.map(x=>x.noFeeProfit)))}];
  }));
  const d=rows.map(r=>r.confirm.profit-r.equal.profit),c=rows.map(r=>r.confirm.profit-r.cash.profit);
  return {strategies,paired:{meanProfitDelta:round(mean(d)),profitDelta95Approx:ci(d),meanDrawdownDelta:round(mean(rows.map(r=>r.confirm.drawdown-r.equal.drawdown))),meanNoFeeProfitDelta:round(mean(rows.map(r=>r.confirm.noFeeProfit-r.equal.noFeeProfit))),meanFeeSavings:round(mean(rows.map(r=>r.equal.fees-r.confirm.fees))),profitDeltaVersusCash95Approx:ci(c),better:d.filter(v=>v>0).length,worse:d.filter(v=>v<0).length,tied:d.filter(v=>v===0).length},profitImprovementSupported:ci(d).lower>0,improvementOverCashSupported:ci(c).lower>0};
}
const py=String.raw`
import hashlib,json,sys
sys.dont_write_bytecode=True
sys.path.insert(0,sys.argv[1])
from game_runtime.predict_bridge import create_prediction_plan
count=int(sys.argv[2]);cohort=sys.argv[3]
model={'fast_window':3,'slow_window':9,'risk_fraction':.35,'plugin_weights':{'trend':100,'momentum':0,'reversion':0,'volatility':0},'plugin_strengths':{'trend':100,'momentum':100,'reversion':100,'volatility':100}}
for i in range(count):
    token='v1_'+hashlib.sha256(('accessory-entry-confirmation-v1-20261124-'+cohort+'-'+str(i)).encode('ascii')).hexdigest()[:16]
    plan=create_prediction_plan({'base_model':model,'models':{'mine':model,'owl':model,'turtle':model},'scenario_token':token,'accessory_methods':['bollinger_breakout','rsi_oversold','macd_momentum']})
    plan.update({'initial_coins':1000,'allocations':{'mine':100,'owl':0,'turtle':0}})
    print(json.dumps({'i':i,'token':token,'plan':plan},separators=(',',':')))
`;
async function main(){
  const args=process.argv.slice(2),opts=new Map();
  if(args.length%2)throw Error('Invalid options');
  for(let i=0;i<args.length;i+=2){if(!['--count','--set'].includes(args[i])||opts.has(args[i]))throw Error('Invalid option');opts.set(args[i],args[i+1]);}
  const count=Number(opts.get('--count')??'240'),cohort=opts.get('--set')??'development';
  if(!Number.isSafeInteger(count)||count<4||count>2000||count%4||!['development','validation'].includes(cohort))throw Error('Invalid count or cohort');
  const child=spawn('python3',['-B','-c',py,fileURLToPath(new URL('../',import.meta.url)),String(count),cohort],{stdio:['ignore','pipe','pipe']});
  let errors='';child.stderr.setEncoding('utf8');child.stderr.on('data',s=>errors=(errors+s).slice(-3500));
  const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error('Python failed '+code+': '+errors)));});
  const rows=new Map(),tokens=new Set(),first=new Set();
  for await(const line of createInterface({input:child.stdout,crlfDelay:Infinity})){
    if(!line.trim())continue;
    const {i,token,plan}=JSON.parse(line);
    if(!Number.isSafeInteger(i)||i<0||i>=count||rows.has(i)||!/^v1_[a-f0-9]{16}$/.test(token)||tokens.has(token)||plan.future_prices.length!==12||plan.signals.length!==12||plan.fee_rate!==.001)throw Error('Invalid scenario');
    tokens.add(token);first.add(plan.signals[0].mine);
    const row={};
    for(const mode of modes){
      const candidate=candidatePlan(plan,mode),result=runSyntheticGame(candidate),free=runSyntheticGame({...candidate,fee_rate:0}),mine=result.characters.mine;
      row[mode]={profit:result.profit_coins,drawdown:result.max_drawdown_pct,trades:mine.trades,fees:mine.fees,longDays:mine.long_steps,noFeeProfit:free.profit_coins};
      if(mode==='cash'&&(row[mode].profit!==0||mine.trades!==0||mine.long_steps!==0))throw Error('Cash control failed');
    }
    rows.set(i,row);
  }
  await done;
  if(rows.size!==count||first.size!==1)throw Error('Incomplete or inconsistent batch');
  console.log(JSON.stringify({mode:'RESEARCH_SYNTHETIC_ONLY',version,set:cohort,scenarios:count,initialCoins:1000,riskFraction:.35,feeRate:.001,tokenListSha256:hash([...tokens].join('\n')),...summarize(Array.from({length:count},(_,i)=>rows.get(i)))},null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
