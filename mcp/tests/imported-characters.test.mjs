import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,stat,readdir,symlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {request} from 'node:http';
import {crc32,deflateSync} from 'node:zlib';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createImportedCharacterStore,MAX_IMPORTED_REQUEST,MAX_IMPORTED_VISUAL_EDIT_REQUEST}
  from '../../game_runtime/imported-characters.mjs';
import {validateAccessoryDefinition} from '../../game_runtime/accessory-catalog.mjs';
import {createGameServer,pythonPredict} from '../../game_runtime/server.mjs';

const png={mime:'image/png',base64:'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGMMqFjAwMDAxMDAwMDAAAAQugFsZnyF3gAAAABJRU5ErkJggg=='};
const red={...png,base64:'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg=='};
const green={...png,base64:'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNkaGBgYGBgYmBgYGBgAAAGKgCE5tEtPAAAAABJRU5ErkJggg=='};
const pngBytes=({base64})=>Buffer.from(base64,'base64');
const checksum=image=>createHash('sha256').update(pngBytes(image)).digest('hex');
const editCheck=edit=>({
  expected_image_sha256:edit.portrait.image_sha256,expected_edit_token:edit.edit_token,
});
const payload=(name,approach='trend',risk_percent=50)=>({
  name,approach,risk_percent,images:{body:png,ready:png,happy:png,portrait:png},
});
const equipmentPayload=accessories=>({
  name:'アクセサリー付き',look:{hair_style:'bob',expression:'cheerful',accessory:'none'},
  colors:{hair_color:'#a58bd9',clothing_color:'#78c2c5'},
  images:{body:png,ready:png,portrait:png},accessories,
});
const visualDraft=(mood='ready',overlays=[])=>({
  schema:1,mood,offsets:{body:{x:1,y:-1},face:{x:24,y:-24},outfit:{x:0,y:1},hair:{x:0,y:0}},
  overlays,
});
const overlay=(id,image=png)=>({id,image,x:100,y:-100,scale:25});
function pngChunk(type,data) {
  const chunk=Buffer.alloc(data.length+12);
  chunk.writeUInt32BE(data.length);
  chunk.write(type,4,'ascii');
  data.copy(chunk,8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4,-4)),chunk.length-4);
  return chunk;
}
function fixturePng(width,height,{size,animated=false}={}) {
  const header=Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height,4);
  header[8]=8;
  header[9]=2;
  const chunks=[pngBytes(png).subarray(0,8),pngChunk('IHDR',header),
    pngChunk('IDAT',deflateSync(Buffer.alloc((3*width+1)*height)))];
  if(animated)chunks.splice(2,0,pngChunk('acTL',Buffer.from([0,0,0,1,0,0,0,0])));
  if(size)chunks.push(pngChunk('tEXt',Buffer.alloc(size-24-chunks.reduce((n,b)=>n+b.length,0))));
  chunks.push(pngChunk('IEND',Buffer.alloc(0)));
  return {mime:'image/png',base64:Buffer.concat(chunks).toString('base64')};
}
async function statusWithContentLength(url,length) {
  return new Promise((resolve,reject)=>{
    const req=request(url,{method:'POST',headers:{
      'Content-Type':'application/json','Content-Length':length,Connection:'close',
    }},res=>{res.resume();resolve(res.statusCode);});
    req.on('error',reject);
    req.end();
  });
}
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

test('visual edit and rollback preserve every other field and restore legacy portraits in both schemas',async()=>{
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
      assert.equal(edit.can_restore_previous,false);
      await assert.rejects(store.restorePortrait(id,editCheck(edit)),{status:409});
      assert.equal(Object.hasOwn(edit,'visual'),false);
      assert.deepEqual(edit.portrait,{width:2,height:2,image_sha256:expected_image_sha256});
      const {portrait:oldImage,...oldSources}=JSON.parse(before).images;
      assert.deepEqual(edit.sources,oldSources);
      const {image_sha256}=await store.updatePortrait(id,{expected_image_sha256,portrait:red});
      assert.equal(image_sha256,checksum(red));
      const committed=await readFile(file,'utf8');
      const {previous_visual,...updated}=JSON.parse(committed);
      assert.deepEqual(previous_visual,{portrait:oldImage});
      assert.deepEqual(updated,{...JSON.parse(before),
        images:{...oldSources,portrait:{...red,size:pngBytes(red).length}}});
      assert.equal((await stat(file)).mode & 0o777,0o600);
      const reopened=createImportedCharacterStore({root});
      assert.deepEqual(await reopened.model(id),model);
      assert.deepEqual((await reopened.image(id)).bytes,pngBytes(red));
      assert.deepEqual((await reopened.visualEdit(id)).character,
        {...character,image_url:character.image_url.replace(expected_image_sha256,image_sha256)});
      await assert.rejects(reopened.updatePortrait(id,{expected_image_sha256,portrait:green}),{status:409});
      assert.equal(await readFile(file,'utf8'),committed);
      const equippedId=character.accessory_analysis?.equipped?.[0].id ??
        (character.accessory_analysis?.accessory==='star'?'star':null);
      const visual=visualDraft('happy',equippedId?[overlay(equippedId)]:[]);
      const oldEdit=await reopened.visualEdit(id);
      const saved=await reopened.updatePortrait(id,{...editCheck(oldEdit),portrait:red,visual});
      const changed=await store.visualEdit(id);
      assert.equal(saved.can_restore_previous,true);
      assert.equal(saved.edit_token,changed.edit_token);
      assert.equal(changed.portrait.image_sha256,oldEdit.portrait.image_sha256);
      assert.notEqual(changed.edit_token,oldEdit.edit_token);
      assert.deepEqual(changed.visual,visual);
      const withVisual=await readFile(file,'utf8');
      const noop=await reopened.updatePortrait(id,{...editCheck(changed),portrait:red,visual});
      assert.deepEqual(noop,saved);
      const signedZero=structuredClone(visual);
      signedZero.offsets.hair.x=-0;
      assert.deepEqual(await reopened.updatePortrait(id,{...editCheck(changed),portrait:red,visual:signedZero}),saved);
      assert.equal(await readFile(file,'utf8'),withVisual);
      await assert.rejects(reopened.updatePortrait(id,{...editCheck(oldEdit),portrait:red,visual}),{status:409});
      await assert.rejects(reopened.restorePortrait(id,editCheck(oldEdit)),{status:409});
      assert.equal(await readFile(file,'utf8'),withVisual);
      const restored=await reopened.restorePortrait(id,editCheck(changed));
      const restoredEdit=await store.visualEdit(id);
      assert.equal(restoredEdit.can_restore_previous,true);
      assert.equal(restoredEdit.edit_token,restored.edit_token);
      assert.equal(restored.image_sha256,checksum(red));
      assert.equal(Object.hasOwn(restoredEdit,'visual'),false);
      assert.deepEqual(restoredEdit.sources,oldSources);
      const {previous_visual:redo,...rolledBack}=JSON.parse(await readFile(file,'utf8'));
      assert.deepEqual(rolledBack,updated);
      assert.deepEqual(redo,{portrait:updated.images.portrait,visual});
      assert.deepEqual(await reopened.model(id),model);
      await store.restorePortrait(id,editCheck(restoredEdit));
      assert.deepEqual((await reopened.visualEdit(id)).visual,visual);
      await reopened.updatePortrait(id,{expected_image_sha256:image_sha256,portrait:green});
      assert.deepEqual((await store.visualEdit(id)).visual,visual);
      await store.restorePortrait(id,editCheck(await store.visualEdit(id)));
      assert.deepEqual((await reopened.image(id)).bytes,pngBytes(red));
      assert.deepEqual(await reopened.model(id),model);
    }
    assert.equal((await store.list()).characters.length,4);
  });
});

test('same-image competing layout saves and a save racing restore share one lock',async()=>{
  await tempStore(async(store,root)=>{
    const {id}=await store.register({...payload('競合'),visual:visualDraft('ready')});
    const reopened=createImportedCharacterStore({root});
    const check=editCheck(await store.visualEdit(id));
    const first=visualDraft('ready');
    const second=visualDraft('ready');
    first.offsets.face.x=10;
    second.offsets.face.x=20;
    const results=await Promise.allSettled([
      store.updatePortrait(id,{...check,portrait:png,visual:first}),
      reopened.updatePortrait(id,{...check,portrait:png,visual:second}),
    ]);
    const winner=results.filter(result=>result.status==='fulfilled');
    const loser=results.filter(result=>result.status==='rejected');
    assert.equal(winner.length,1);
    assert.equal(loser.length,1);
    assert.equal(loser[0].reason.status,409);
    const edit=await store.visualEdit(id);
    assert.equal(edit.portrait.image_sha256,checksum(png));
    assert.equal(edit.edit_token,winner[0].value.edit_token);
    assert.deepEqual(edit.visual,results[0].status==='fulfilled'?first:second);
    const racing=await Promise.allSettled([
      store.updatePortrait(id,{...editCheck(edit),portrait:red,visual:first}),
      reopened.restorePortrait(id,editCheck(edit)),
    ]);
    assert.equal(racing.filter(result=>result.status==='fulfilled').length,1);
    assert.equal(racing.find(result=>result.status==='rejected').reason.status,409);
    const final=await store.visualEdit(id);
    assert.equal(final.edit_token,racing.find(result=>result.status==='fulfilled').value.edit_token);
    assert.deepEqual(final.visual,racing[0].status==='fulfilled'?first:visualDraft());
    await store.restorePortrait(id,editCheck(final));
    assert.deepEqual((await store.visualEdit(id)).visual,edit.visual);
    assert.deepEqual(await readdir(root),[id+'.json']);
  });
});

test('registered visuals require exact fields, matching strip geometry and canonical equipped IDs',async()=>{
  await tempStore(async(store,root)=>{
    const custom={name:'月',method:'moving_average_trend'};
    const customId=validateAccessoryDefinition(custom).id;
    const input=equipmentPayload(['star',custom]);
    input.images={...input.images,body:fixturePng(12,2),ready:fixturePng(12,2),happy:fixturePng(12,2)};
    const visual=visualDraft('happy',[overlay('star'),overlay(customId,red)]);
    const registered=await store.register({...input,visual});
    const reopened=createImportedCharacterStore({root});
    assert.deepEqual((await reopened.visualEdit(registered.id)).visual,visual);
    assert.equal(Object.hasOwn(registered,'visual'),false);
    const changed={...visual,overlays:[{...visual.overlays[0],x:50}]};
    await reopened.updatePortrait(registered.id,
      {...editCheck(await reopened.visualEdit(registered.id)),portrait:png,visual:changed});
    assert.deepEqual((await store.visualEdit(registered.id)).visual,changed);
    const check=editCheck(await reopened.visualEdit(registered.id));
    const malformed=[
      [{...visual,schema:2},400],
      [{...visual,mood:'cautious'},400],
      [{...visual,offsets:{...visual.offsets,body:{x:2,y:0}}},400],
      [{...visual,offsets:{...visual.offsets,face:{x:25,y:0}}},400],
      [{...visual,offsets:{...visual.offsets,face:{x:0.5,y:0}}},400],
      [{...visual,offsets:{...visual.offsets,['__proto__']:{x:0,y:0}}},400],
      [{...visual,overlays:[overlay('manifest-1')]},400],
      [{...visual,overlays:[overlay('star'),overlay('star')]},400],
      [{...visual,overlays:Array(4).fill(overlay('star'))},400],
      [{...visual,overlays:[{...overlay('star'),scale:201}]},400],
      [{...visual,overlays:[{...overlay('star'),y:-101}]},400],
      [{...visual,overlays:[overlay('star',{...png,path:'../overlay.png'})]},400],
      [{...visual,overlays:[overlay('star',{...png,mime:'image/svg+xml'})]},400],
      [{...visual,overlays:[overlay('star',fixturePng(1025,1))]},415],
      [{...visual,overlays:[overlay('star',fixturePng(2,2,{animated:true}))]},415],
      [{...visual,overlays:[overlay('star',fixturePng(2,2,{size:5*1024*1024+1}))]},413],
    ];
    const file=join(root,registered.id+'.json');
    const original=await readFile(file,'utf8');
    for(const [bad,status] of malformed) {
      await assert.rejects(store.register({...input,visual:bad}),{status});
      await assert.rejects(reopened.updatePortrait(registered.id,
        {...check,portrait:red,visual:bad}),{status});
      assert.equal(await readFile(file,'utf8'),original);
    }
    for(const images of [
      {...input.images,ready:png}, {...input.images,portrait:fixturePng(4,2)},
      {body:fixturePng(1025,1),ready:fixturePng(1025,1),portrait:fixturePng(1025,1)},
    ])await assert.rejects(store.register({...input,images,visual}),
      error=>error.status===400||error.status===415);
    const record=JSON.parse(original);
    const wrongSize=fixturePng(3,2);
    for(const corrupted of [
      {...record,visual:{...changed,extra:true}},
      {...record,visual:{...changed,overlays:[overlay('glasses')]}},
      {...record,visual:{...changed,overlays:[overlay('star',{...png,base64:'AAAA'})]}},
      {...record,images:{...record.images,happy:record.images.portrait}},
      {...record,previous_visual:null},
      {...record,previous_visual:{...record.previous_visual,extra:true}},
      {...record,previous_visual:{...record.previous_visual,visual:{...visual,overlays:[overlay('glasses')]}}},
      {...record,previous_visual:{...record.previous_visual,visual:{...visual,mood:'cautious'}}},
      {...record,previous_visual:{portrait:{...record.images.portrait,size:1}}},
      {...record,previous_visual:{portrait:{...record.images.portrait,extra:true}}},
      {...record,previous_visual:{portrait:{...wrongSize,size:pngBytes(wrongSize).length}}},
      {...record,previous_visual:{...record.previous_visual,visual:null}},
      {...record,previous_visual:{portrait:{...red,size:pngBytes(red).length,base64:'AAAA'}}},
      {...record,extra:true},
    ]) {
      const disk=JSON.stringify(corrupted);
      await writeFile(file,disk);
      await assert.rejects(reopened.visualEdit(registered.id),{status:503});
      await assert.rejects(reopened.model(registered.id),{status:503});
      await assert.rejects(reopened.updatePortrait(registered.id,
        {expected_image_sha256:checksum(png),portrait:red}),{status:503});
      await assert.rejects(reopened.restorePortrait(registered.id,check),{status:503});
      assert.equal(await readFile(file,'utf8'),disk);
    }
  });
});

test('maximum-sized ZIP images and overlays reload and history obeys the same record limit',async()=>{
  await tempStore(async(store,root)=>{
    const maxImage=fixturePng(2,2,{size:5*1024*1024});
    const portrait=fixturePng(2,2,{size:1024*1024});
    const input=equipmentPayload(['star','glasses','ribbon']);
    input.images={body:maxImage,ready:maxImage,happy:maxImage,cautious:maxImage,portrait};
    input.visual=visualDraft('cautious',input.accessories.map(id=>overlay(id,maxImage)));
    const {id}=await store.register(input);
    const file=join(root,id+'.json');
    const size=(await stat(file)).size;
    assert.ok(size>48*1024*1024 && size<MAX_IMPORTED_REQUEST);
    const reopened=createImportedCharacterStore({root});
    const edit=await reopened.visualEdit(id);
    assert.deepEqual(edit.visual,input.visual);
    assert.equal(edit.sources.cautious.base64,maxImage.base64);
    const update={...editCheck(edit),portrait,visual:input.visual};
    assert.ok(Buffer.byteLength(JSON.stringify(update))<MAX_IMPORTED_VISUAL_EDIT_REQUEST);
    assert.deepEqual(await reopened.updatePortrait(id,update),
      {id,image_sha256:edit.portrait.image_sha256,edit_token:edit.edit_token,can_restore_previous:false});
    const before=await readFile(file);
    await assert.rejects(reopened.updatePortrait(id,{...update,visual:{...update.visual,mood:'happy'}}),
      {status:413});
    assert.deepEqual(await readFile(file),before);
    assert.equal((await reopened.visualEdit(id)).can_restore_previous,false);
    const saved=await reopened.updatePortrait(id,{...update,visual:{...update.visual,overlays:[]}});
    assert.equal(saved.can_restore_previous,true);
    assert.ok((await stat(file)).size<MAX_IMPORTED_REQUEST);
    await reopened.restorePortrait(id,editCheck(await reopened.visualEdit(id)));
    const restored=await store.visualEdit(id);
    assert.deepEqual(restored.visual,input.visual);
    assert.equal(restored.portrait.image_sha256,edit.portrait.image_sha256);
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
      const currentEdit=await current.json();
      assert.deepEqual(currentEdit,await store.visualEdit(id));
      const restorePath=id+'/restore';
      const restoreCheck=editCheck(currentEdit);
      assert.equal((await post(restorePath,restoreCheck)).status,409);
      assert.equal((await post(restorePath,{...restoreCheck,portrait:red})).status,400);
      assert.equal((await post(restorePath,{...restoreCheck,expected_edit_token:null})).status,400);
      assert.equal((await post(restorePath,{expected_image_sha256:checksum(png)})).status,400);
      assert.equal((await post(restorePath,restoreCheck,{'Content-Type':'text/plain'})).status,415);
      assert.equal(await statusWithContentLength(path+restorePath,1025),413);
      assert.equal((await fetch(path+restorePath,{method:'POST',headers:{'Content-Type':'application/json'},
        body:'{'})).status,400);
      for(const method of ['GET','PUT']) {
        const response=await fetch(path+restorePath,{method});
        assert.equal(response.status,405);
        assert.equal(response.headers.get('allow'),'POST');
      }
      for(const [body,status] of [
        [{...good,appearance:{look:'changed'}},400],
        [{...good,expected_image_sha256:'broken'},400],
        [{...good,expected_image_sha256:'0'.repeat(64)},409],
        [{...good,portrait:{...png,path:file}},400],
        [{...good,portrait:{mime:'image/svg+xml',base64:png.base64}},400],
        [{...good,portrait:{...png,base64:'AAAA'}},415],
        [{...good,portrait:{...png,base64:'A'.repeat(4*Math.ceil((1024*1024+2)/3))}},413],
        [{...good,portrait:{...png,base64:'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEElEQVR4nGP8zwAFTDAGAwATKQED8NgHhAAAAABJRU5ErkJggg=='}},400],
        [{...good,visual:visualDraft()},400],
        [{...good,...restoreCheck,visual:null},400],
        [{...good,...restoreCheck,visual:visualDraft('ready',[overlay('../star')])},400],
      ]) assert.equal((await post(id,body)).status,status);
      assert.equal(await statusWithContentLength(path+id,MAX_IMPORTED_VISUAL_EDIT_REQUEST+1),413);
      assert.equal(await statusWithContentLength(origin+'/api/imported-characters/register',
        MAX_IMPORTED_REQUEST+1),413);
      assert.equal((await post(id,good,{'Content-Type':'text/plain'})).status,415);
      for(const headers of [{Origin:'http://localhost:'+port},{'Sec-Fetch-Site':'cross-site'}]) {
        assert.equal((await fetch(path+id,{headers})).status,403);
        assert.equal((await post(id,good,headers)).status,403);
        assert.equal((await post(restorePath,restoreCheck,headers)).status,403);
      }
      const missing='zip_'+'f'.repeat(32);
      for(const target of [missing,'','%2e%2e%2fother',id+'/extra']) {
        assert.equal((await fetch(path+target)).status,404);
        assert.equal((await post(target,good)).status,404);
      }
      for(const target of [missing+'/restore',id+'/%72estore',restorePath+'/',restorePath+'?extra=1',
        id+'/nested/restore'])assert.equal((await post(target,restoreCheck)).status,404);
      await symlink(file,join(root,missing+'.json'));
      assert.equal((await fetch(path+missing)).status,503);
      assert.equal((await post(missing,good)).status,503);
      assert.equal((await post(missing+'/restore',restoreCheck)).status,503);
      assert.deepEqual(await readFile(file),before);
      const saved=await post(id,good,{Origin:origin});
      assert.equal(saved.status,200,await saved.clone().text());
      assert.deepEqual(await saved.json(),{id,image_sha256:checksum(red)});
      const savedBytes=await readFile(file);
      assert.equal((await post(restorePath,restoreCheck)).status,409);
      assert.deepEqual(await readFile(file),savedBytes);
      const restored=await post(restorePath,editCheck(await store.visualEdit(id)),{Origin:origin});
      assert.equal(restored.status,200,await restored.clone().text());
      const result=await restored.json();
      const edit=await store.visualEdit(id);
      assert.deepEqual(result,{id,image_sha256:checksum(png),edit_token:edit.edit_token,can_restore_previous:true});
      assert.deepEqual((await store.image(id)).bytes,pngBytes(png));
    }finally{await new Promise(resolve=>server.close(resolve));}
  });
});
