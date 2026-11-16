import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {readFile} from 'node:fs/promises';
import {createGameServer, pythonPredict} from '../../game_runtime/server.mjs';

const id='tv_'+'f'.repeat(32);
const draftId='bp_'+'e'.repeat(32);
const weights={trend:100,momentum:0,volatility:0,reversion:0};
const strengths={trend:100,momentum:100,volatility:100,reversion:100};
const model=(w=weights)=>({fast_window:3,slow_window:9,risk_fraction:.4,
  plugin_weights:w,plugin_strengths:strengths});
const trainedModel=model({trend:0,momentum:0,volatility:0,reversion:100});
const allocations={mine:100,owl:0,turtle:0};
const snapshot=(rev=3)=>({
  state:{revision:rev,model:model()},
  lineup:{revision:1,slots:[{slot:'owl',model:model()},{slot:'turtle',model:model()}]},
  growth:{revision:1,slots:[{slot:'mine',gear:'none'},{slot:'owl',gear:'none'},{slot:'turtle',gear:'none'}]},
  source_revision:rev,lineup_revision:1,growth_revision:1,
});
const brain=()=>({kind:'trained_practice_only',version_id:id,source_draft_id:draftId,
  parameters_sha256:'a'.repeat(64),model:trainedModel});
async function serve(config,fn){
  const srv=createGameServer(config);
  await new Promise(resolve=>srv.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+srv.address().port;
  try {await fn(url);}finally{await new Promise(resolve=>srv.close(resolve));}
}
const post=(base,body,headers={})=>fetch(base+'/api/practice',{
  method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body),
});
test('saved training version is the actual model used by Python; standard remains unchanged',async()=>{
  let selectedPlan;
  const opts={
    loadSnapshot:async()=>snapshot(),
    trainedVersion:async idRequested=>{assert.equal(idRequested,id);return brain();},
    predict:async models=>{selectedPlan=models;return pythonPredict(models);},
    trainedVersions:async()=>({versions:[{id,source_draft_id:draftId}],notice:'synthetic'}),
  };
  await serve(opts,async base=>{
    const defaultRun=await post(base,{allocations});
    assert.equal(defaultRun.status,200);
    const original=await defaultRun.json();
    assert.deepEqual(original.brain,{kind:'standard_mine'});
    const trainedRun=await post(base,{allocations,trained_version_id:id});
    assert.equal(trainedRun.status,200);
    const selected=await trainedRun.json();
    assert.equal(selected.brain.version_id,id);
    assert.equal(selected.brain.parameters_sha256,'a'.repeat(64));
    assert.deepEqual(selectedPlan.models.mine.plugin_weights,trainedModel.plugin_weights);
    assert.deepEqual(selectedPlan.models.owl.plugin_weights,weights);
    assert.deepEqual(selectedPlan.base_model.plugin_weights,weights);
    assert.equal(selected.brain.effective_sha256,selected.characters.mine.effective_sha256);
    assert.notEqual(selected.characters.mine.effective_sha256,original.characters.mine.effective_sha256);
    const versions=await fetch(base+'/api/trained/versions');
    assert.equal(versions.status,200);
    assert.equal((await versions.json()).versions[0].id,id);
  });
});

test('browser cannot supply forecast parameters or an arbitrary ID',async()=>{
  let resolverCalls=0;
  await serve({loadSnapshot:async()=>snapshot(),trainedVersion:async()=>{resolverCalls++;return brain();}},
    async base=>{
      for(const body of [
        {allocations,trained_version_id:'../etc/passwd'},
        {allocations,trained_version_id:{id}},
        {allocations,models:{mine:trainedModel}},
        {allocations,trained_version_id:id,signals:[{mine:'LONG'}]},
        {allocations,trained_version_id:null},
      ]){
        const result=await post(base,body);
        assert.equal(result.status,400,JSON.stringify(body));
      }
      const cross=await post(base,{allocations,trained_version_id:id},
        {Origin:'https://example.invalid'});
      assert.equal(cross.status,403);
    });
  assert.equal(resolverCalls,0);
});

test('deleted or modified version is a conflict; mismatch in core revision remains a conflict',async()=>{
  await serve({loadSnapshot:async()=>snapshot(),
    trainedVersion:async()=>{throw Object.assign(Error('deleted'),{status:409});}},
    async base=>assert.equal((await post(base,{allocations,trained_version_id:id})).status,409));
  let n=0;
  await serve({loadSnapshot:async()=>snapshot(),
    trainedVersion:async()=>({...brain(),parameters_sha256:(++n===1?'a':'b').repeat(64)})},
    async base=>assert.equal((await post(base,{allocations,trained_version_id:id})).status,409));
  let reads=0;
  await serve({loadSnapshot:async()=>snapshot(++reads),trainedVersion:async()=>brain()},
    async base=>assert.equal((await post(base,{allocations,trained_version_id:id})).status,409));
});

test('trained version endpoint cannot be written to or queried by another origin',async()=>{
  await serve({trainedVersions:async()=>({versions:[]})},async base=>{
    assert.equal((await fetch(base+'/api/trained/versions',{method:'POST'})).status,404);
    assert.equal((await fetch(base+'/api/trained/versions',
      {headers:{Origin:'https://evil.invalid'}})).status,403);
  });
});

class Element{
  constructor(){this.children=[];this.handlers={};this.attributes={};this.value='';this.disabled=false;
    this.hidden=false;this.textContent='';this.dataset={};}
  addEventListener(k,cb){this.handlers[k]=cb;}
  setAttribute(k,v){this.attributes[k]=v;}
  replaceChildren(...items){this.children=items;}
  append(e){this.children.push(e);}
  async fire(k='click'){return this.handlers[k]?.();}
}
const gameJs=await readFile(new URL('../../game_runtime/demo.mjs',import.meta.url),'utf8');
const gameHtml=await readFile(new URL('../../game_runtime/demo.html',import.meta.url),'utf8');
test('UI selects a saved brain separately from appearance and pins execution attribution',async()=>{
  const elements=new Map(),calls=[];
  const get=k=>{if(!elements.has(k))elements.set(k,new Element());return elements.get(k)};
  const fetchFake=async(path,opt)=>{
    const body=opt?.body?JSON.parse(opt.body):undefined;
    calls.push({path,body});
    if(path==='/api/growth')return {ok:true,json:async()=>({revision:2,slots:[{
      slot:'mine',gear:'none',level:1,xp:0,
      gear_options:[{id:'none',icon:'·',name:'なし',unlocked:true}]}]})};
    if(path==='/api/trained/versions')return {ok:true,json:async()=>({versions:[{id,source_draft_id:draftId}]})};
    if(path==='/api/practice'){
      const values={mode:'PRACTICE_SYNTHETIC_ONLY',decisions:Array.from({length:12},(_,i)=>({
          price:100+i,signals:{mine:'LONG'}})),equity_path:Array.from({length:13},()=>10000),
        final_coins:10000,profit_coins:0,max_drawdown_pct:0,
        brain:{kind:'trained_practice_only',version_id:id},
        training_ticket:null};
      return {ok:true,json:async()=>values};
    }
    throw Error('Unexpected request: '+path);
  };
  get('adventureMode').value='solo';
  runInNewContext(gameJs,{document:{getElementById:get,createElement:()=>new Element()},fetch:fetchFake});
  await new Promise(resolve=>setImmediate(resolve));
  await get('loadBrains').fire();
  assert.equal(get('brainSelect').children.length,2);
  get('brainSelect').value=id;
  await get('brainSelect').fire('change');
  assert.match(get('brainStatus').textContent,/実相場精度は未検証/);
  await get('play').fire();
  const req=calls.find(x=>x.path==='/api/practice');
  assert.deepEqual(JSON.parse(JSON.stringify(req.body)),{allocations,trained_version_id:id});
  assert.match(get('brainResult').textContent,/学習済み練習版/);
  assert.match(get('modelJudgmentHeading').textContent,/保存した練習版/);
  assert.match(gameHtml,/外見を選ぶ/);
  assert.match(gameHtml,/練習に使う予測モデルを選ぶ/);
  assert.doesNotMatch(gameJs,/localStorage|sessionStorage|indexedDB/);
});
