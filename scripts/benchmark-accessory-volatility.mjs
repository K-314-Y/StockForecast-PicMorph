// Research only; no live data, no writes to game/player state.
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {runSyntheticGame} from '../game_runtime/practice.mjs';

const version='accessory-volatility-allocation-v1';
const mean=a=>a.reduce((s,x)=>s+x,0)/a.length;
const round=x=>Number(x.toFixed(6));
const hash=x=>createHash('sha256').update(x).digest('hex');
export function volatilityAllocation(history){
  if(!Array.isArray(history)||history.length<6||history.some(x=>!Number.isFinite(x)||x<=0))throw Error('Invalid past prices');
  const h=history.slice(-6),r=h.slice(1).map((p,i)=>p/h[i]-1);
  const rms=Math.sqrt(mean(r.map(x=>x*x)));
  return rms===0?.55:Math.min(.55,Math.max(.15,.35*.02/rms));
}
export function riskPath(history,future,signals){
  if(future.length!==signals.length)throw Error('Invalid length');
  const past=[...history],out=[];
  for(let i=0;i<signals.length;i++){
    if(!['LONG','CASH'].includes(signals[i]))throw Error('Invalid signal');
    out.push(signals[i]==='LONG'?volatilityAllocation(past):0);
    past.push(future[i]);
  }
  return out;
}
// Research copy of single-wallet accounting: fixed-risk paths are checked
// against the game's original full-precision equity path on every scenario.
export function simulate(plan,risks){
  if(plan.mode!=='PRACTICE_SYNTHETIC_ONLY'||plan.allocations.mine!==100||plan.allocations.owl!==0||plan.allocations.turtle!==0||risks.length!==plan.future_prices.length)throw Error('Unsupported plan');
  let cash=plan.initial_coins,units=0,prior=plan.initial_price,fees=0,trades=0,peak=cash,drawdown=0;
  const equity=[cash],exposures=[];
  for(let i=0;i<risks.length;i++){
    const risk=risks[i],next=plan.future_prices[i],feeRate=plan.fee_rate;
    if(!Number.isFinite(risk)||risk<0||risk>1||!Number.isFinite(next)||next<=0)throw Error('Invalid risk or price');
    const total=cash+units*prior,held=units*prior,target=total*risk;
    if(target>held+1e-8){
      const gross=Math.min(target-held,cash/(1+feeRate));
      if(gross>1e-8){const fee=gross*feeRate;cash-=gross+fee;units+=gross/prior;fees+=fee;trades++;}
    }else if(held>target+1e-8){
      const gross=held-target,fee=gross*feeRate;units-=gross/prior;cash+=gross-fee;fees+=fee;trades++;
    }
    if(cash< -1e-7||units< -1e-7)throw Error('Negative wallet');
    exposures.push(units*prior/(cash+units*prior));
    prior=next;
    const value=cash+units*next;
    equity.push(value);peak=Math.max(peak,value);drawdown=Math.max(drawdown,1-value/peak);
  }
  return {profit:equity.at(-1)-plan.initial_coins,drawdown:drawdown*100,fees,trades,equity,exposure:mean(exposures)*100,target:mean(risks)*100};
}
function fixed(plan,weight){
  const model=structuredClone(plan);
  model.models.mine.risk_fraction=weight;
  const r=simulate(plan,plan.signals.map(s=>s.mine==='LONG'?weight:0));
  const original=runSyntheticGame(model);
  if(original.raw_equity_path.length!==r.equity.length||original.raw_equity_path.some((x,i)=>Math.abs(x-r.equity[i])>1e-8)||original.characters.mine.trades!==r.trades)throw Error('Game accounting parity failure');
  return r;
}
function ci(values){
  const m=mean(values),sd=Math.sqrt(values.reduce((s,x)=>s+(x-m)**2,0)/(values.length-1)),margin=1.96*sd/Math.sqrt(values.length);
  return [round(m-margin),round(m+margin)];
}
function summarize(rows){
  const fields=['profit','drawdown','fees','trades','exposure','target'];
  const strategies=Object.fromEntries(['current','matched','dynamic','cash'].map(k=>[k,Object.fromEntries(fields.map(f=>[f,round(mean(rows.map(r=>r[k][f])))]))]));
  const diffs=f=>rows.map(r=>r.dynamic[f]-r.matched[f]);
  const profit=diffs('profit'),dd=diffs('drawdown'),exposure=mean(diffs('exposure'));
  const profitCI=ci(profit),drawdownCI=ci(dd);
  return {strategies,paired:{meanProfitDelta:round(mean(profit)),profitCI,meanDrawdownDelta:round(mean(dd)),drawdownCI,exposureDelta:round(exposure),betterProfitCases:profit.filter(x=>x>0).length,lowerDrawdownCases:dd.filter(x=>x<0).length},passes:Math.abs(exposure)<=1&&drawdownCI[1]<0&&profitCI[0]>=-.5};
}
const py=String.raw`
import hashlib,json,sys
sys.dont_write_bytecode=True
sys.path.insert(0,sys.argv[1])
from game_runtime.predict_bridge import create_prediction_plan,SYNTHETIC_PRICES
model={'fast_window':3,'slow_window':9,'risk_fraction':.35,'plugin_weights':{'trend':100,'momentum':0,'reversion':0,'volatility':0},'plugin_strengths':{'trend':100,'momentum':100,'reversion':100,'volatility':100}}
for cohort in ('development','validation'):
    for i in range(int(sys.argv[2])):
        token='v1_'+hashlib.sha256(('accessory-volatility-allocation-v1-20261125-'+cohort+'-'+str(i)).encode('ascii')).hexdigest()[:16]
        plan=create_prediction_plan({'base_model':model,'models':{'mine':model,'owl':model,'turtle':model},'scenario_token':token,'accessory_methods':['bollinger_breakout','rsi_oversold','macd_momentum']})
        plan.update({'initial_coins':1000,'allocations':{'mine':100,'owl':0,'turtle':0}})
        print(json.dumps({'cohort':cohort,'i':i,'token':token,'history':list(SYNTHETIC_PRICES),'plan':plan},separators=(',',':')))
`;
async function main(){
  const args=process.argv.slice(2);
  if(args.length&&!(args.length===2&&args[0]==='--count'))throw Error('Usage: --count N');
  const count=Number(args[1]??240);
  if(!Number.isSafeInteger(count)||count<4||count>2000)throw Error('Invalid count');
  const child=spawn('python3',['-B','-c',py,fileURLToPath(new URL('../',import.meta.url)),String(count)],{stdio:['ignore','pipe','pipe']});
  let errors='';child.stderr.setEncoding('utf8');child.stderr.on('data',s=>errors=(errors+s).slice(-3000));
  const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',c=>c===0?resolve():reject(Error('Python failed: '+errors)));});
  const sets={development:[],validation:[]},tokens=new Set(),ids=new Set();
  for await(const line of createInterface({input:child.stdout,crlfDelay:Infinity})){
    if(!line.trim())continue;
    const {cohort,i,token,history,plan}=JSON.parse(line),key=cohort+':'+i;
    if(!Object.hasOwn(sets,cohort)||!Number.isInteger(i)||i<0||i>=count||ids.has(key)||tokens.has(token)||!/^v1_[a-f0-9]{16}$/.test(token)||plan.fee_rate!==.001||plan.future_prices.length!==12||history.at(-1)!==plan.initial_price)throw Error('Invalid scenario');
    ids.add(key);tokens.add(token);
    const signals=plan.signals.map(s=>s.mine),risks=riskPath(history,plan.future_prices,signals);
    sets[cohort].push({i,token,plan,risks,signals});
  }
  await done;
  if(Object.values(sets).some(s=>s.length!==count))throw Error('Incomplete cohort');
  for(const set of Object.values(sets))set.sort((a,b)=>a.i-b.i);
  const active=sets.development.flatMap(x=>x.risks.filter((_,i)=>x.signals[i]==='LONG'));
  if(!active.length)throw Error('No LONG signals');
  const matched=mean(active),results={};
  for(const [cohort,set] of Object.entries(sets)){
    const rows=set.map(({plan,risks})=>({current:fixed(plan,.35),matched:fixed(plan,matched),dynamic:simulate(plan,risks),cash:fixed(plan,0)}));
    results[cohort]={tokenListSha256:hash(set.map(x=>x.token).join('\n')),...summarize(rows)};
  }
  console.log(JSON.stringify({mode:'RESEARCH_SYNTHETIC_ONLY',version,count,matchedLongAllocation:matched,accountingParityChecks:count*6,results,adopt:results.development.passes&&results.validation.passes},null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
