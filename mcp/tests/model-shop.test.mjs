import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createModelShopStore} from '../../game_runtime/model-shop.mjs';
import {createGameServer,pythonPredict} from '../../game_runtime/server.mjs';

async function temporary(fn){
  const dir=await mkdtemp(join(tmpdir(),'creature-shop-test-'));
  try{return await fn(join(dir,'model-shop.json'));}
  finally{await rm(dir,{recursive:true,force:true});}
}
function defaultModel(){
  return {fast_window:3,slow_window:9,risk_fraction:.35,
    plugin_weights:{trend:100,momentum:0,volatility:0,reversion:0},
    plugin_strengths:{trend:100,momentum:100,volatility:100,reversion:100}};
}
function snapshot(){
  const m=defaultModel();
  return {state:{revision:2,model:m},
    lineup:{revision:1,slots:['owl','turtle'].map(slot=>({slot,model:m}))},
    growth:{revision:0,slots:['mine','owl','turtle'].map(slot=>({slot,gear:'none'}))},
    source_revision:2,lineup_revision:1,growth_revision:0};
}
async function post(root,path,data,headers={}){
  const result=await fetch(root+path,{method:'POST',
    headers:{'Content-Type':'application/json',...headers},
    body:JSON.stringify(data)});
  return {status:result.status,body:await result.json()};
}
async function serverWith(shop,fn){
  const server=createGameServer({modelShopStore:shop,predict:pythonPredict,
    loadSnapshot:async()=>snapshot(),
    store:{public:async()=>snapshot().growth,
      complete:()=>{throw Error('XP write unexpected')},
      equip:()=>{throw Error('XP write unexpected')}},
    companionStore:{read:async()=>({revision:0,created:false,companion:null}),
      save:()=>{throw Error('companion write unexpected')}}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{await fn('http://127.0.0.1:'+server.address().port);}
  finally{await new Promise(resolve=>server.close(resolve));}
}
test('model identity license: one purchase, never per-version, no repeat charge',async()=>{
  await temporary(async file=>{
    const shop=createModelShopStore({file});
    const initial=await shop.public();
    assert.equal(initial.coins,200);
    assert.equal(initial.models.length,2);
    assert.equal(initial.models[0].owned,false);
    assert.ok(!Object.hasOwn(initial.models[0],'version'));
    const {id,price}=initial.models[0];
    await assert.rejects(shop.licensedModel(id),{status:403});
    const first=await shop.purchase({id,expected_revision:initial.revision});
    assert.equal(first.purchase_status,'unlocked');
    assert.equal(first.coins,200-price);
    assert.equal(first.revision,1);
    const second=await shop.purchase({id,expected_revision:0});
    assert.equal(second.purchase_status,'already_owned');
    assert.equal(second.coins,first.coins);
    assert.equal(second.revision,first.revision);
    const model=await shop.licensedModel(id);
    assert.equal(model.fast_window,4);
    model.fast_window=999;
    assert.equal((await shop.licensedModel(id)).fast_window,4,
      'caller may not change author model');
    assert.deepEqual((await createModelShopStore({file}).public()).models
      .map(m=>m.owned),[true,false]);
    const disk=JSON.parse(await readFile(file,'utf8'));
    assert.deepEqual(disk.licenses,[id]);
    assert.ok(!('version' in disk));
    assert.deepEqual(Object.keys(disk).sort(),['coins','licenses','revision','schema']);
  });
});
test('concurrent purchases serialized, insufficient funds do not write or overdraw',async()=>{
  await temporary(async file=>{
    const shop=createModelShopStore({file});
    const state=await shop.public();
    const id=state.models[1].id;
    const results=await Promise.all([
      shop.purchase({id,expected_revision:0}),
      shop.purchase({id,expected_revision:0}),
    ]);
    assert.equal(results.filter(x=>x.purchase_status==='unlocked').length,1);
    assert.equal(results.filter(x=>x.purchase_status==='already_owned').length,1);
    const after=await shop.public();
    assert.equal(after.coins,90);
    await assert.rejects(shop.purchase({id,version:'v1',expected_revision:0}),
      {status:400});
    await assert.rejects(shop.purchase({id:'../unexpected',expected_revision:0}),
      {status:404});
    assert.equal((await shop.public()).revision,1);
    // Simulate a valid existing wallet whose funds are insufficient.
    await writeFile(file,JSON.stringify({schema:1,revision:2,coins:30,licenses:[id]}));
    await assert.rejects(
      shop.purchase({id:state.models[0].id,expected_revision:2}),
      {status:400});
    assert.equal((await shop.public()).coins,30);
    assert.equal((await shop.public()).revision,2);
  });
});
test('shop API: owner-only practice runs real forecast locally, no market or XP writes',async()=>{
  await temporary(async file=>{
    const shop=createModelShopStore({file});
    await serverWith(shop,async root=>{
      const before=await (await fetch(root+'/api/model-shop')).json();
      assert.equal(before.mode,'LOCAL_DEMO_SHOP_ONLY');
      const item=before.models[0];
      const unauthorised=await post(root,'/api/model-shop/practice',{id:item.id});
      assert.equal(unauthorised.status,403);
      const bad=await post(root,'/api/model-shop/buy',
        {id:item.id,expected_revision:0,version:'v1'});
      assert.equal(bad.status,400);
      const cross=await post(root,'/api/model-shop/buy',
        {id:item.id,expected_revision:0},{Origin:'https://not-this-site.example'});
      assert.equal(cross.status,403);
      const purchase=await post(root,'/api/model-shop/buy',
        {id:item.id,expected_revision:before.revision});
      assert.equal(purchase.status,200,JSON.stringify(purchase.body));
      assert.equal(purchase.body.coins,120);
      const run=await post(root,'/api/model-shop/practice',{id:item.id});
      assert.equal(run.status,200,JSON.stringify(run.body));
      assert.equal(run.body.mode,'LOCAL_SHOP_LICENSED_PRACTICE');
      assert.equal(run.body.decisions,12);
      assert.equal(run.body.real_market,false);
      assert.equal(run.body.investment_balance_changed,false);
      assert.equal(run.body.charged_for_practice,false);
      assert.ok(!Object.hasOwn(run.body,'version'));
      const after=await (await fetch(root+'/api/model-shop')).json();
      assert.equal(after.coins,120);
      assert.equal(after.revision,1);
    });
  });
});
