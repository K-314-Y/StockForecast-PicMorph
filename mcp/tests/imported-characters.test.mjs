import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createImportedCharacterStore} from '../../game_runtime/imported-characters.mjs';
import {createGameServer,pythonPredict} from '../../game_runtime/server.mjs';

const png={mime:'image/png',base64:'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGMMqFjAwMDAxMDAwMDAAAAQugFsZnyF3gAAAABJRU5ErkJggg=='};
const payload=(name,approach='trend',risk_percent=50)=>({
  name,approach,risk_percent,images:{body:png,ready:png,happy:png,portrait:png},
});
async function tempStore(fn) {
  const root=await mkdtemp(join(tmpdir(),'zip-character-test-'));
  try {return await fn(createImportedCharacterStore({root}),root);}
  finally {await rm(root,{recursive:true,force:true});}
}
test('ZIP registration creates distinct character-model pairs, survives new store, and keeps original versions',async()=>{
  await tempStore(async(store,root)=>{
    const first=await store.register(payload('ラベンダー','momentum',50));
    const second=await store.register(payload('ミント','reversion',75));
    assert.match(first.id,/^zip_[a-f0-9]{32}$/);
    assert.notEqual(first.id,second.id);
    assert.equal(first.ai_id,first.id);
    assert.equal(second.ai_id,second.id);
    assert.equal(first.source,'ZIP_LOCAL');
    assert.equal(first.trained,false);
    assert.equal(first.live_market,false);
    assert.equal(first.model.plugin_weights.momentum,100);
    assert.equal(second.model.plugin_weights.reversion,100);
    assert.equal(first.model.risk_fraction,0.5);
    assert.equal(second.model.risk_fraction,0.75);
    const reader=createImportedCharacterStore({root});
    const list=await reader.list();
    assert.deepEqual(new Set(list.characters.map(x=>x.id)),new Set([first.id,second.id]));
    assert.equal((await reader.model(first.id)).model_version,first.model_version);
    assert.equal((await reader.model(second.id)).model_revision,1);
    assert.deepEqual((await reader.image(first.id)).bytes,Buffer.from(png.base64,'base64'));
  });
});

test('appearance attributes create different actual forecast model weights and risk',async()=>{
  await tempStore(async(store,root)=>{
    const colors={hair_color:'#a58bd9',clothing_color:'#78c2c5'};
    const look={hair_style:'bob',expression:'cheerful',accessory:'star'};
    const images={body:png,ready:png,portrait:png};
    const register=async(name,look,colors)=>store.register({name,look,colors,images});
    const star=await register('星',look,colors);
    const glasses=await register('眼鏡',{...look,accessory:'glasses'},colors);
    const ribbon=await register('リボン',{...look,accessory:'ribbon'},colors);
    assert.equal(star.model_origin,'appearance_features');
    assert.deepEqual(star.accessory_analysis,{
      accessory:'star',method:'bollinger_breakout',version:'accessory-analysis-v1',
    });
    assert.equal(star.appearance.look.accessory,'star');
    assert.deepEqual(star.appearance.colors,colors);
    assert.ok(star.model.plugin_weights.volatility>glasses.model.plugin_weights.volatility);
    assert.ok(glasses.model.plugin_weights.reversion>star.model.plugin_weights.reversion);
    assert.ok(ribbon.model.plugin_weights.momentum>star.model.plugin_weights.momentum);
    assert.notEqual(star.model_version,glasses.model_version);
    assert.notEqual(ribbon.model_version,glasses.model_version);
    const calm=await register('慎重',{...look,expression:'calm'},colors);
    assert.ok(calm.model.risk_fraction<star.model.risk_fraction);
    const blue=await register('青い髪',look,{...colors,hair_color:'#0000ff'});
    assert.notDeepEqual(blue.model.plugin_weights,star.model.plugin_weights);
    const recovered=createImportedCharacterStore({root});
    assert.deepEqual((await recovered.model(star.id)).model,star.model);
    assert.equal((await recovered.model(glasses.id)).model_version,glasses.model_version);
    const stored=JSON.parse(await readFile(join(root,star.id+'.json'),'utf8'));
    stored.appearance.look.accessory='glasses'; // can't relabel the look without changing the forecast
    await writeFile(join(root,star.id+'.json'),JSON.stringify(stored));
    await assert.rejects(recovered.model(star.id),{status:503});
    assert.deepEqual((await recovered.model(glasses.id)).model,glasses.model);
  });
});
test('appearance-based registration strictly rejects unrecognized traits without writing',async()=>{
  await tempStore(async store=>{
    const good={name:'外見',look:{hair_style:'bob',expression:'calm',accessory:'glasses'},
      colors:{hair_color:'#112233',clothing_color:'#abcdef'},
      images:{body:png,ready:png,portrait:png}};
    for(const bad of [
      {...good,look:{...good.look,accessory:'laser'}},
      {...good,look:{...good.look,expression:'unsure'}},
      {...good,colors:{...good.colors,hair_color:'red'}},
      {...good,colors:{...good.colors,extraneous:'anything'}},
      {...good,risk_percent:100},
    ])await assert.rejects(store.register(bad));
    assert.equal((await store.list()).characters.length,0);
  });
});

test('two visual-trait models enter the actual predictor independently on the same market',async()=>{
  await tempStore(async store=>{
    const model={fast_window:3,slow_window:9,risk_fraction:.35,
      plugin_weights:{trend:100,momentum:0,volatility:0,reversion:0},
      plugin_strengths:{trend:100,momentum:100,volatility:100,reversion:100}};
    const snapshot=()=>({
      state:{revision:2,model},
      lineup:{revision:1,slots:['owl','turtle'].map(slot=>({slot,model}))},
      growth:{revision:0,slots:['mine','owl','turtle'].map(slot=>({slot,gear:'none'}))},
      source_revision:2,lineup_revision:1,growth_revision:0,
    });
    const images={body:png,ready:png,portrait:png};
    const colors={hair_color:'#a58bd9',clothing_color:'#78c2c5'};
    const look={hair_style:'bob',expression:'cheerful',accessory:'star'};
    const star=await store.register({name:'星',look,colors,images});
    const glasses=await store.register({
      name:'眼鏡',look:{...look,accessory:'glasses'},colors,images,
    });
    const inputs=[];
    const server=createGameServer({importedCharacterStore:store,
      loadSnapshot:async()=>snapshot(),
      predict:async plan=>{inputs.push(plan);return pythonPredict(plan);},
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base='http://127.0.0.1:'+server.address().port;
    try {
      const post=async id=>{
        const res=await fetch(base+'/api/quick-practice',{
          method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({model_id:id,amount:1000,
            scenario_token:'v1_0123456789abcdef'}),
        });
        return {status:res.status,body:await res.json()};
      };
      const left=await post(star.id),right=await post(glasses.id);
      assert.equal(left.status,200,JSON.stringify(left.body));
      assert.equal(right.status,200,JSON.stringify(right.body));
      assert.deepEqual(left.body.daily_synthetic_prices,right.body.daily_synthetic_prices);
      assert.equal(inputs.length,2);
      assert.deepEqual(inputs[0].models.mine,star.model);
      assert.deepEqual(inputs[1].models.mine,glasses.model);
      assert.equal(inputs[0].accessory_strategy,'star');
      assert.equal(inputs[1].accessory_strategy,'glasses');
      assert.notDeepEqual(inputs[0].models.mine.plugin_weights,inputs[1].models.mine.plugin_weights);
      assert.notDeepEqual(left.body.daily_ai_signals,right.body.daily_ai_signals,
        'different accessory methods must actually change future-safe practice decisions');
      assert.equal(left.body.real_market,false);
      assert.equal(right.body.order_placed,false);
    }finally{await new Promise(resolve=>server.close(resolve));}
  });
});
test('malformed ZIP registration is rejected without creating a character',async()=>{
  await tempStore(async store=>{
    for(const bad of [
      {...payload(''),name:''},
      payload('A','unknown',50),
      payload('A','trend',NaN),
      {...payload('A'),images:{ready:png,portrait:png}},
      {...payload('A'),images:{body:png,ready:png,portrait:{...png,base64:'hello'}}},
    ])await assert.rejects(store.register(bad));
    assert.equal((await store.list()).characters.length,0);
    await assert.rejects(store.model('zip_../../bad'),{status:404});
  });
});
test('local APIs create, list and serve character art linked to the model',async()=>{
  await tempStore(async store=>{
    const server=createGameServer({importedCharacterStore:store});
    await new Promise((resolve,reject)=>{
      server.once('error',reject);
      server.listen(0,'127.0.0.1',resolve);
    });
    const base='http://127.0.0.1:'+server.address().port;
    try {
      const before=await fetch(base+'/api/imported-characters');
      assert.deepEqual(await before.json(),{characters:[]});
      const response=await fetch(base+'/api/imported-characters/register',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify(payload('ZIPテスト','volatility',25)),
      });
      assert.equal(response.status,201);
      const created=await response.json();
      assert.equal(created.id,created.ai_id);
      assert.equal(created.model.plugin_weights.volatility,100);
      assert.equal(created.model.risk_fraction,0.25);
      const listing=await (await fetch(base+'/api/imported-characters')).json();
      assert.equal(listing.characters.length,1);
      assert.equal(listing.characters[0].id,created.id);
      const image=await fetch(base+created.image_url);
      assert.equal(image.status,200);
      assert.equal(image.headers.get('content-type'),'image/png');
      assert.deepEqual(Buffer.from(await image.arrayBuffer()),Buffer.from(png.base64,'base64'));
      const invalid=await fetch(base+'/api/imported-characters/register',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify(payload('bad','invalid',25)),
      });
      assert.equal(invalid.status,400);
      assert.equal((await (await fetch(base+'/api/imported-characters')).json()).characters.length,1);
      assert.equal((await fetch(base+'/api/imported-characters/image/zip_../../etc/passwd')).status,404);
    } finally {await new Promise(resolve=>server.close(resolve));}
  });
});
