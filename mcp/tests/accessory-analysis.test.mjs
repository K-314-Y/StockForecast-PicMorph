import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {pythonPredict,createGameServer} from '../../game_runtime/server.mjs';

const MODEL={fast_window:3,slow_window:9,risk_fraction:.35,
  plugin_weights:{trend:100,momentum:0,reversion:0,volatility:0},
  plugin_strengths:{trend:100,momentum:100,reversion:100,volatility:100}};
const input={base_model:MODEL,models:{mine:MODEL,owl:MODEL,turtle:MODEL},
  scenario_token:'v1_0123456789abcdef'};

test('different accessory analyses are real algorithms, not different weights on identical forecasts',async()=>{
  const results=await Promise.all(['star','glasses','ribbon','none'].map(
    accessory_strategy=>pythonPredict({...input,accessory_strategy})));
  const [star,glasses,ribbon,none]=results;
  const series=results.map(out=>out.signals.map(step=>step.mine));
  assert.equal(series.length,4);
  assert.ok(series.every(s=>s.length===12&&s.every(x=>['LONG','CASH'].includes(x))));
  assert.ok(new Set(series.map(s=>s.join(','))).size>=3,
    'different accessories must produce substantially different 12-day decisions');
  for(const result of results){
    assert.deepEqual(result.future_prices,star.future_prices);
    assert.deepEqual(result.signals.map(s=>s.owl),star.signals.map(s=>s.owl));
    assert.deepEqual(result.signals.map(s=>s.turtle),star.signals.map(s=>s.turtle));
    assert.deepEqual(result.models.mine.plugin_weights,MODEL.plugin_weights);
    assert.deepEqual(result.models.mine.plugin_strengths,MODEL.plugin_strengths);
    assert.equal(result.models.mine.risk_fraction,MODEL.risk_fraction);
    assert.match(result.models.mine.effective_sha256,/^[a-f0-9]{64}$/);
  }
  assert.notEqual(star.models.mine.effective_sha256,glasses.models.mine.effective_sha256);
  assert.notEqual(star.models.mine.effective_sha256,ribbon.models.mine.effective_sha256);
  assert.notEqual(none.models.mine.effective_sha256,ribbon.models.mine.effective_sha256);
});

test('first decision cannot depend on unseen future scenario prices',async()=>{
  const a=await pythonPredict({...input,scenario_token:'v1_0000000000000001',
    accessory_strategy:'star'});
  const b=await pythonPredict({...input,scenario_token:'v1_ffffffffffffffff',
    accessory_strategy:'star'});
  assert.notDeepEqual(a.future_prices,b.future_prices);
  assert.equal(a.signals[0].mine,b.signals[0].mine);
  assert.equal(a.signals[0].owl,b.signals[0].owl);
});

test('base model is a secondary analysis, not an inert decoration',async()=>{
  const {execFileSync}=await import('node:child_process');
  const output=execFileSync('python3',['-B','-c',[
    'import sys',
    'sys.path.insert(0,sys.argv[1])',
    'from accessory_analysis import accessory_signal',
    'prices=tuple([100.0]*30)',
    'print(accessory_signal("none",prices,0.0))',
    'print(accessory_signal("none",prices,1.0))',
  ].join(';'),fileURLToPath(new URL('../../game_runtime/',import.meta.url))],{encoding:'utf8',timeout:3000});
  assert.deepEqual(output.trim().split('\n'),['CASH','LONG']);
});

test('legacy forecast remains unchanged without accessory and invalid method is refused',async()=>{
  const original=await pythonPredict(input);
  const baseline=await pythonPredict({...input});
  assert.deepEqual(original,baseline);
  await assert.rejects(pythonPredict({...input,accessory_strategy:'evil'}));
  await assert.rejects(pythonPredict({...input,accessory_strategy:7}));
});

test('equipped indicators affect 12-day signals and use order-independent strategy identity',async()=>{
  const accessory_methods=['bollinger_breakout','rsi_oversold','macd_momentum'];
  const run=(methods,options={})=>pythonPredict({...input,...options,accessory_methods:methods});
  const combined=await run(accessory_methods);
  assert.deepEqual(await run([...accessory_methods].reverse()),combined);
  const anotherScenario=await run(accessory_methods,{scenario_token:'v1_ffffffffffffffff'});
  assert.notDeepEqual(combined.future_prices,anotherScenario.future_prices);
  assert.deepEqual(combined.signals[0],anotherScenario.signals[0]);
  for(const dropped of accessory_methods) {
    const partial=await run(accessory_methods.filter(method=>method!==dropped));
    assert.notEqual(partial.models.mine.effective_sha256,combined.models.mine.effective_sha256);
    assert.notDeepEqual(partial.signals.map(step=>step.mine),combined.signals.map(step=>step.mine),dropped);
    assert.deepEqual(partial.signals.map(({owl,turtle})=>({owl,turtle})),
      combined.signals.map(({owl,turtle})=>({owl,turtle})));
  }
  const legacy=await pythonPredict({...input,accessory_strategy:'none'});
  const movingAverage=await run(['moving_average_trend']);
  assert.deepEqual(movingAverage.signals,legacy.signals);
  assert.equal(combined.signals.length,12);
});

test('Python rejects malformed equipment, duplicate methods and both strategy formats together',async()=>{
  for(const methods of [null,[],{},'rsi_oversold',['none'],[1],['rsi_oversold','rsi_oversold'],
    ['rsi_oversold','bollinger_breakout','moving_average_trend','macd_momentum']]) {
    await assert.rejects(pythonPredict({...input,accessory_methods:methods}));
  }
  await assert.rejects(pythonPredict({...input,accessory_strategy:'star',accessory_methods:['rsi_oversold']}));
});

test('browser cannot submit an accessory override to quick-practice',async()=>{
  const server=createGameServer();
  await new Promise((resolve,reject)=>{
    server.once('error',reject);server.listen(0,'127.0.0.1',resolve);
  });
  try{
    for(const override of [{accessory_strategy:'star'},{accessory_methods:['rsi_oversold']}]) {
      const res=await fetch('http://127.0.0.1:'+server.address().port+'/api/quick-practice',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({amount:1000,model_id:'self',...override}),
      });
      assert.equal(res.status,400);
    }
  }finally{await new Promise(resolve=>server.close(resolve));}
});


test('the offline accessory benchmark reproduces fixed scenarios without real market or user data',async()=>{
  const {execFileSync}=await import('node:child_process');
  const benchmark=fileURLToPath(new URL('../../scripts/benchmark-accessory-ai.mjs',import.meta.url));
  const run=set=>JSON.parse(execFileSync(process.execPath,[benchmark,'--count','8','--set',set],
    {encoding:'utf8',timeout:20000}));
  const main=run('main'),repeat=run('main'),heldout=run('holdout');
  assert.deepEqual(repeat,main,'predeclared synthetic scenario replays must be deterministic');
  assert.equal(main.mode,'SYNTHETIC_12_DAY_GAME_ONLY');
  assert.equal(main.scenarios,8);
  assert.equal(main.plans,48);
  assert.equal(main.initialCoins,1000);
  assert.equal(main.riskFraction,.35);
  assert.equal(main.feeRate,.001);
  assert.equal(main.pricesMatched,true);
  assert.equal(main.modelParametersMatched,true);
  assert.equal(main.firstDecisionsIndependentOfFuture,true);
  assert.deepEqual(Object.keys(main.results),['standard','star','glasses','ribbon','none','triple']);
  assert.equal(heldout.set,'holdout');
  assert.equal(heldout.plans,48);
  assert.notDeepEqual(main.results,heldout.results,'held-out tokens must produce different outcome sets');
  for(const result of Object.values(main.tripleComparisons)){
    assert.equal(result.tripleBetter+result.tied+result.tripleWorse,8);
  }
});


test('experimental strength weighting is order-independent and cannot see next synthetic price',async()=>{
  const {execFileSync}=await import('node:child_process');
  const runtime=fileURLToPath(new URL('../../',import.meta.url));
  const script=[
    'import sys,json',
    'sys.path.insert(0,sys.argv[1])',
    'from game_runtime.accessory_analysis import experimental_strength_weighted_signal as weighted,equipped_accessory_signal as equal',
    'from engine import SYNTHETIC_PRICES',
    'history=tuple(SYNTHETIC_PRICES)',
    'methods=["bollinger_breakout","rsi_oversold","macd_momentum"]',
    'assert weighted(methods,history,.35)==weighted(list(reversed(methods)),history,.35)',
    'assert weighted(methods,history,.35)==weighted(methods,history,.35)',
    'assert weighted(["rsi_oversold"],history,.35)==equal(["rsi_oversold"],history,.35)',
    'assert weighted(["bollinger_breakout"],history,.35)==equal(["bollinger_breakout"],history,.35)',
    'for bad in ([],["rsi_oversold","rsi_oversold"],["not_an_indicator"]):',
    '  try: weighted(bad,history,.35); raise AssertionError("invalid method accepted")',
    '  except ValueError: pass',
    'for bad in (float("nan"),-1,2):',
    '  try: weighted(methods,history,bad); raise AssertionError("invalid probability accepted")',
    '  except ValueError: pass',
    'print(json.dumps({"valid":True,"decision":weighted(methods,history,.35)}))',
  ].join('\n');
  const result=JSON.parse(execFileSync('python3',['-B','-c',script,runtime],
    {encoding:'utf8',timeout:6000}));
  assert.equal(result.valid,true);
  assert.ok(['LONG','CASH'].includes(result.decision));
});

test('experimental benchmark uses disjoint reproducible offline scenario cohorts',async()=>{
  const {execFileSync}=await import('node:child_process');
  const script=fileURLToPath(new URL('../../scripts/benchmark-accessory-weighting.mjs',import.meta.url));
  const run=set=>JSON.parse(execFileSync(process.execPath,[script,'--count','8','--set',set],
    {encoding:'utf8',timeout:20000}));
  const development=run('development'),same=run('development'),validation=run('validation');
  assert.deepEqual(same,development);
  for(const record of [development,validation]){
    assert.equal(record.mode,'UNTRAINED_SYNTHETIC_ACCESSORY_EXPERIMENT');
    assert.equal(record.version,'accessory-strength-experiment-v1');
    assert.equal(record.scenarios,8);
    assert.equal(record.plans,16);
    assert.equal(record.samePrices,true);
    assert.equal(record.sameBaseModel,true);
    assert.equal(record.firstDecisionsIndependentOfFuture,true);
    assert.equal(record.initialCoins,1000);
    assert.equal(record.feeRate,.001);
    assert.ok(Number.isFinite(record.strategies.equal.meanProfit));
    assert.ok(Number.isFinite(record.strategies.strength.meanProfit));
    const p=record.paired;
    assert.equal(p.strengthBetter+p.equalBetter+p.tied,8);
    assert.equal(p.changedCases,p.strengthBetter+p.equalBetter);
    assert.equal(p.byBlock.length,4);
  }
  assert.notDeepEqual(development.strategies,validation.strategies,
    'validation token cohort must be different from development');
});
