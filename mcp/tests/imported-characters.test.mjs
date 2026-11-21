import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,stat,readdir,symlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createImportedCharacterStore,MAX_IMPORTED_PORTRAIT_REQUEST}
  from '../../game_runtime/imported-characters.mjs';
import {createGameServer,pythonPredict} from '../../game_runtime/server.mjs';

const png={mime:'image/png',base64:'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGMMqFjAwMDAxMDAwMDAAAAQugFsZnyF3gAAAABJRU5ErkJggg=='};
const red={...png,base64:'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg=='};
const green={...png,base64:'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNkaGBgYGBgYmBgYGBgAAAGKgCE5tEtPAAAAABJRU5ErkJggg=='};
const pngBytes=({base64})=>Buffer.from(base64,'base64');
const checksum=image=>createHash('sha256').update(pngBytes(image)).digest('hex');
const payload=(name,approach='trend',risk_percent=50)=>({
  name,approach,risk_percent,images:{body:png,ready:png,happy:png,portrait:png},
});
const equipmentPayload=accessories=>({
  name:'アクセサリー付き',look:{hair_style:'bob',expression:'cheerful',accessory:'none'},
  colors:{hair_color:'#a58bd9',clothing_color:'#78c2c5'},
  images:{body:png,ready:png,portrait:png},accessories,
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

test('equipment snapshots survive reopening and reject valid-looking replacements with a mismatched hash',async()=>{
  await tempStore(async(store,root)=>{
    const custom={name:'月のブローチ',method:'moving_average_trend'};
    const registered=await store.register(equipmentPayload(['star','glasses',custom]));
    const reopened=createImportedCharacterStore({root});
    assert.deepEqual((await reopened.list()).characters,[registered]);
    assert.deepEqual(registered.accessory_analysis.equipped.map(({name,method})=>({name,method})),[
      {name:'星',method:'bollinger_breakout'},{name:'眼鏡',method:'rsi_oversold'},custom,
    ]);
    const snapshot=await reopened.model(registered.id);
    assert.match(snapshot.equipment_hash,/^[0-9a-f]{64}$/);
    const replacement=await store.register(equipmentPayload(['star','ribbon',custom]));
    const file=join(root,registered.id+'.json');
    const original=JSON.parse(await readFile(file,'utf8'));
    for(const corrupted of [
      {...original,equipped:replacement.accessory_analysis.equipped},
      {...original,equipped:original.equipped.map(item=>item.name===custom.name?{...item,name:'別名'}:item)},
      {...original,equipment_hash:'0'.repeat(64)},
      {...original,schema:1},
    ]) {
      await writeFile(file,JSON.stringify(corrupted));
      await assert.rejects(reopened.model(registered.id),{status:503});
      await assert.rejects(reopened.image(registered.id),{status:503});
    }
  });
});
test('equipment registration validates names, methods, count and legacy none mixing',async()=>{
  await tempStore(async store=>{
    const custom={name:'月のブローチ',method:'moving_average_trend'};
    for(const accessories of [
      null,[],['star','glasses','ribbon',custom],['none','star'],['constructor'],['star','star'],
      ['star',{...custom,method:'bollinger_breakout'}],[{...custom,method:'arbitrary'}],
      [{...custom,name:' '}],[{...custom,name:'bad\u0000name'}],[{...custom,name:'a'.repeat(25)}],
      [{...custom,unexpected:true}],
    ])await assert.rejects(store.register(equipmentPayload(accessories)),{status:400});
    const valid=equipmentPayload([custom]);
    await assert.rejects(store.register({...valid,look:{...valid.look,accessory:'star'}}),{status:400});
    assert.deepEqual((await store.list()).characters,[]);
  });
});
test('local catalog is bounded and duplicate or competing additions never replace a definition',async()=>{
  await tempStore(async(store,root)=>{
    const definition={name:'月のブローチ',method:'rsi_oversold'};
    const first=await store.addAccessory(definition);
    const file=join(root,first.id+'.json');
    const originalInode=(await stat(file)).ino;
    const reopened=createImportedCharacterStore({root});
    assert.deepEqual(await reopened.addAccessory({...definition,name:'  月のブローチ  '}),first);
    assert.equal((await stat(file)).ino,originalInode);
    for(let n=0;n<30;n++)await store.addAccessory({...definition,name:'ブローチ'+n});
    const results=await Promise.allSettled([
      store.addAccessory({...definition,name:'最後の候補A'}),
      reopened.addAccessory({...definition,name:'最後の候補B'}),
    ]);
    assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
    assert.equal(results.find(result=>result.status==='rejected').reason.status,409);
    assert.equal((await reopened.listAccessories()).accessories.length,35);
    await assert.rejects(reopened.addAccessory({...definition,name:'追加の候補'}),{status:409});
    assert.deepEqual(await reopened.addAccessory(definition),first);
    assert.equal((await stat(file)).ino,originalInode);
    await writeFile(file,JSON.stringify({...first,method:'moving_average_trend'}));
    await assert.rejects(reopened.listAccessories(),{status:503});
    await assert.rejects(reopened.addAccessory(definition),{status:503});
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
    const combined=await store.register(equipmentPayload(['star','glasses',
      {name:'ピン',method:'macd_momentum'}]));
    const renamed=await store.register(equipmentPayload([{name:'別の名前',method:'macd_momentum'},'glasses','star']));
    const inputs=[],plans=[];
    const server=createGameServer({importedCharacterStore:store,
      loadSnapshot:async()=>snapshot(),
      predict:async input=>{inputs.push(input);const plan=await pythonPredict(input);plans.push(plan);return plan;},
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
      const multi=await post(combined.id),cosmetic=await post(renamed.id);
      assert.equal(multi.status,200,JSON.stringify(multi.body));
      assert.equal(cosmetic.status,200,JSON.stringify(cosmetic.body));
      assert.equal(multi.body.daily_ai_signals.length,12);
      assert.deepEqual(inputs[2].accessory_methods,['bollinger_breakout','rsi_oversold','macd_momentum']);
      assert.deepEqual(multi.body.daily_synthetic_prices,left.body.daily_synthetic_prices);
      assert.deepEqual(multi.body.daily_ai_signals,cosmetic.body.daily_ai_signals);
      assert.equal(plans[2].models.mine.effective_sha256,plans[3].models.mine.effective_sha256);
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

test('visual edit updates the same saved ID and preserves every other field in both schemas',async()=>{
  await tempStore(async(store,root)=>{
    const legacy={...equipmentPayload([])};
    delete legacy.accessories;
    legacy.look.accessory='star';
    for(const input of [
      legacy,
      equipmentPayload(['glasses',{name:'月のブローチ',method:'moving_average_trend'}]),
      {...legacy,look:{...legacy.look,accessory:'none'}},
      payload('旧モデル','reversion',75),
    ]) {
      const images={...input.images,happy:green,cautious:red};
      const character=await store.register({...input,images});
      const {id}=character;
      const file=join(root,id+'.json');
      const before=await readFile(file,'utf8');
      const model=await store.model(id);
      const expected_image_sha256=checksum(png);
      const edit=await store.visualEdit(id);
      assert.deepEqual(edit.character,character);
      assert.deepEqual(edit.portrait,{width:2,height:2,image_sha256:expected_image_sha256});
      const {portrait:oldImage,...oldSources}=JSON.parse(before).images;
      assert.deepEqual(edit.sources,oldSources);
      const {image_sha256}=await store.updatePortrait(id,{expected_image_sha256,portrait:red});
      assert.equal(image_sha256,checksum(red));
      const oldPortrait=JSON.stringify(oldImage);
      const newPortrait=JSON.stringify({...red,size:pngBytes(red).length});
      const committed=await readFile(file,'utf8');
      assert.equal(committed,before.replace('"portrait":'+oldPortrait,'"portrait":'+newPortrait));
      assert.equal((await stat(file)).mode & 0o777,0o600);
      const reopened=createImportedCharacterStore({root});
      assert.deepEqual(await reopened.model(id),model);
      assert.deepEqual((await reopened.image(id)).bytes,pngBytes(red));
      assert.deepEqual((await reopened.visualEdit(id)).character,
        {...character,image_url:character.image_url.replace(expected_image_sha256,image_sha256)});
      await assert.rejects(reopened.updatePortrait(id,{expected_image_sha256,portrait:green}),{status:409});
      assert.equal(await readFile(file,'utf8'),committed);
    }
    assert.equal((await store.list()).characters.length,4);
  });
});

test('only one competing portrait replacement commits across store instances',async()=>{
  await tempStore(async(store,root)=>{
    const {id}=await store.register(payload('競合'));
    const expected_image_sha256=checksum(png);
    const results=await Promise.allSettled([
      store.updatePortrait(id,{expected_image_sha256,portrait:red}),
      createImportedCharacterStore({root}).updatePortrait(id,{expected_image_sha256,portrait:green}),
    ]);
    const winner=results.filter(result=>result.status==='fulfilled');
    const loser=results.filter(result=>result.status==='rejected');
    assert.equal(winner.length,1);
    assert.equal(loser.length,1);
    assert.equal(loser[0].reason.status,409);
    assert.equal((await store.visualEdit(id)).portrait.image_sha256,winner[0].value.image_sha256);
    assert.deepEqual(await readdir(root),[id+'.json']);
  });
});

test('visual edit API rejects invalid requests and symlinks without modifying the saved record',async()=>{
  await tempStore(async(store,root)=>{
    const {id}=await store.register(equipmentPayload(['star','glasses']));
    const file=join(root,id+'.json');
    const before=await readFile(file);
    const server=createGameServer({importedCharacterStore:store});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const port=server.address().port;
    const origin='http://127.0.0.1:'+port;
    const path=origin+'/api/imported-characters/visual-edit/';
    const post=(target,body,headers={})=>fetch(path+target,{
      method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body),
    });
    const good={expected_image_sha256:checksum(png),portrait:red};
    try {
      const current=await fetch(path+id);
      assert.equal(current.status,200);
      assert.equal(current.headers.get('cache-control'),'no-store');
      assert.deepEqual(await current.json(),await store.visualEdit(id));
      for(const [body,status] of [
        [{...good,appearance:{look:'changed'}},400],
        [{...good,expected_image_sha256:'broken'},400],
        [{...good,expected_image_sha256:'0'.repeat(64)},409],
        [{...good,portrait:{...png,path:file}},400],
        [{...good,portrait:{mime:'image/svg+xml',base64:png.base64}},400],
        [{...good,portrait:{...png,base64:'AAAA'}},415],
        [{...good,portrait:{...png,base64:'A'.repeat(4*Math.ceil((1024*1024+2)/3))}},413],
        [{...good,portrait:{...png,base64:'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEElEQVR4nGP8zwAFTDAGAwATKQED8NgHhAAAAABJRU5ErkJggg=='}},400],
        [{...good,extra:'x'.repeat(MAX_IMPORTED_PORTRAIT_REQUEST)},413],
      ]) assert.equal((await post(id,body)).status,status);
      assert.equal((await post(id,good,{'Content-Type':'text/plain'})).status,415);
      for(const headers of [{Origin:'http://localhost:'+port},{'Sec-Fetch-Site':'cross-site'}]) {
        assert.equal((await fetch(path+id,{headers})).status,403);
        assert.equal((await post(id,good,headers)).status,403);
      }
      const missing='zip_'+'f'.repeat(32);
      for(const target of [missing,'','%2e%2e%2fother',id+'/extra']) {
        assert.equal((await fetch(path+target)).status,404);
        assert.equal((await post(target,good)).status,404);
      }
      await symlink(file,join(root,missing+'.json'));
      assert.equal((await fetch(path+missing)).status,503);
      assert.equal((await post(missing,good)).status,503);
      assert.deepEqual(await readFile(file),before);
      const saved=await post(id,good,{Origin:origin});
      assert.equal(saved.status,200,await saved.clone().text());
      assert.deepEqual(await saved.json(),{id,image_sha256:checksum(red)});
    }finally{await new Promise(resolve=>server.close(resolve));}
  });
});
