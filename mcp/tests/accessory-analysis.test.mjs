import test from 'node:test';
import assert from 'node:assert/strict';
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
    'sys.path.insert(0,"game_runtime")',
    'from accessory_analysis import accessory_signal',
    'prices=tuple([100.0]*30)',
    'print(accessory_signal("none",prices,0.0))',
    'print(accessory_signal("none",prices,1.0))',
  ].join(';')],{encoding:'utf8',timeout:3000});
  assert.deepEqual(output.trim().split('\n'),['CASH','LONG']);
});

test('legacy forecast remains unchanged without accessory and invalid method is refused',async()=>{
  const original=await pythonPredict(input);
  const baseline=await pythonPredict({...input});
  assert.deepEqual(original,baseline);
  await assert.rejects(pythonPredict({...input,accessory_strategy:'evil'}));
  await assert.rejects(pythonPredict({...input,accessory_strategy:7}));
});

test('browser cannot submit an accessory override to quick-practice',async()=>{
  const server=createGameServer();
  await new Promise((resolve,reject)=>{
    server.once('error',reject);server.listen(0,'127.0.0.1',resolve);
  });
  try{
    const res=await fetch('http://127.0.0.1:'+server.address().port+'/api/quick-practice',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({amount:1000,model_id:'self',accessory_strategy:'star'}),
    });
    assert.equal(res.status,400);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
