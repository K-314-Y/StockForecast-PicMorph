import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createImportedCharacterStore} from '../../game_runtime/imported-characters.mjs';
import {createGameServer} from '../../game_runtime/server.mjs';

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
