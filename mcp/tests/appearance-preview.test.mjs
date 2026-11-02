import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {readFile} from 'node:fs/promises';
import {createGameServer} from '../../game_runtime/server.mjs';
import {sanitizeDrafts, isValidAppearanceId, readAppearanceImage} from '../../game_runtime/appearance.mjs';

const id = 'bp_'+'a'.repeat(32);
const draft = {id, status:'draft', user_declared:{name:'花の旅人'},
  visual_asset:{media_type:'image/png',bytes:56}};
const catalog = ()=>({drafts:[{id,name:'花の旅人',has_image:true}],notice:'外見のみ'});
const png = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
const root = new URL('../../game_runtime/',import.meta.url);
const html = await readFile(new URL('demo.html',root),'utf8');
const script = await readFile(new URL('demo.mjs',root),'utf8');

async function serve(opts,fn) {
  const server = createGameServer(opts);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+server.address().port;
  try {await fn(url);}
  finally {await new Promise(resolve=>server.close(resolve));}
}
test('draft metadata is reduced to visual-only fields and strict canonical IDs',()=>{
  const result=sanitizeDrafts({drafts:[draft]});
  assert.deepEqual(result.drafts,[{id,name:'花の旅人',has_image:true}]);
  assert.equal(isValidAppearanceId(id),true);
  assert.equal(isValidAppearanceId('../etc/passwd'),false);
  assert.throws(()=>sanitizeDrafts({drafts:[draft,{...draft}]}));
  assert.throws(()=>sanitizeDrafts({drafts:[{...draft,id:'../../oops'}]}));
  assert.deepEqual(sanitizeDrafts({drafts:[{...draft,visual_asset:null}]}).drafts[0].has_image,false);
});
test('Node appearance API serves restricted same-origin catalog/images without trading writes',async()=>{
  let listCalls=0,imageCalls=0;
  await serve({
    appearanceCatalog:async()=>{listCalls++;return catalog();},
    appearanceImage:async input=>{
      imageCalls++;assert.equal(input,id);return {mime:'image/png',bytes:png};
    },
  },async base=>{
    const c=await fetch(base+'/api/appearance/drafts');
    assert.equal(c.status,200);assert.deepEqual((await c.json()).drafts,catalog().drafts);
    const img=await fetch(base+'/api/appearance/image/'+id);
    assert.equal(img.status,200);assert.equal(img.headers.get('content-type'),'image/png');
    assert.equal(img.headers.get('x-content-type-options'),'nosniff');
    assert.equal(img.headers.get('cache-control'),'no-store');
    assert.equal(Buffer.from(await img.arrayBuffer()).equals(png),true);
    const traversal=await fetch(base+'/api/appearance/image/%2e%2e%2fprivate');
    assert.equal(traversal.status,404);
    const invalid=await fetch(base+'/api/appearance/image/not-an-id');
    assert.equal(invalid.status,404);
    const forged=await fetch(base+'/api/appearance/drafts',{headers:{Origin:'https://evil.invalid'}});
    assert.equal(forged.status,403);
    const write=await fetch(base+'/api/appearance/drafts',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    assert.equal(write.status,404);
  });
  assert.equal(listCalls,1);assert.equal(imageCalls,1);
});
test('non-image, large image, and missing upstream image are rejected',async()=>{
  for(const [out,status] of [
    [{mime:'text/html',bytes:Buffer.from('<script>')},415],
    [{mime:'image/svg+xml',bytes:Buffer.from('<svg/>')},415],
    [{mime:'image/png',bytes:Buffer.alloc(1048577)},415],
  ]){
    await serve({appearanceCatalog:async()=>catalog(),appearanceImage:async()=>out},async base=>{
      const response=await fetch(base+'/api/appearance/image/'+id);
      assert.equal(response.status,status);
    });
  }
  await serve({appearanceImage:async()=>{throw Object.assign(Error('gone'),{status:404});}},
    async base=>assert.equal((await fetch(base+'/api/appearance/image/'+id)).status,404));
});
test('catalog-derived lookup blocks deleted/non-image drafts without proxying image',async()=>{
  await assert.rejects(readAppearanceImage(id,async()=>({drafts:[]})),{status:404});
  await assert.rejects(readAppearanceImage(id,async()=>({drafts:[{id,has_image:false}]})),{status:404});
});

class Element {
  constructor(){
    this.handlers={};this.children=[];this.attributes={};this.value='';
    this.hidden=false;this.disabled=false;this.textContent='';
  }
  addEventListener(k,fn){this.handlers[k]=fn;}
  replaceChildren(...nodes){this.children=[...nodes];}
  append(n){this.children.push(n);}
  setAttribute(k,v){this.attributes[k]=v;}
  async click(name='click'){return this.handlers[name]?.();}
}
async function mount(drafts=catalog().drafts) {
  const nodes=new Map(),calls=[];
  const $=id=>{
    if(!nodes.has(id))nodes.set(id,new Element());
    return nodes.get(id);
  };
  const fetch=async path=>{
    calls.push(path);
    if(path==='/api/growth')return {ok:true,json:async()=>({
      revision:0,slots:[{slot:'mine',level:1,xp:0,gear:'none',
        gear_options:[{id:'none',unlocked:true,name:'装備なし',icon:'·'}]}]})};
    if(path==='/api/appearance/drafts')return {ok:true,json:async()=>({drafts})};
    throw Error('unexpected browser fetch '+path);
  };
  runInNewContext(script,{document:{getElementById:$,createElement:()=>new Element()},fetch});
  await new Promise(resolve=>setImmediate(resolve));
  return {get:$,calls,click:async(id,evt='click')=>$(id).click(evt)};
}
test('UI keeps draft visuals separate from saved companion rules, falls back on deleted image, never contacts Python directly',async()=>{
  assert.match(html,/予測：標準モデル mine（未作成）/);
  assert.match(html,/DRAFTの予測ルールは未適用/);
  const {get,click,calls}=await mount();
  await click('loadSkins');
  assert.equal(get('skinSelect').children.length,2);
  get('skinSelect').value=id;
  await click('skinSelect','change');
  assert.equal(get('portrait').src,'/api/appearance/image/'+id);
  assert.equal(get('chibi').hidden,false,'old sprite remains until image onload');
  get('portrait').onload();
  assert.equal(get('chibi').hidden,true);
  assert.match(get('skinStatus').textContent,/予測は保存済み相棒のルール/);
  get('portrait').onerror();
  assert.equal(get('chibi').hidden,false);
  assert.match(get('skinStatus').textContent,/初期外見に戻しました/);
  assert.deepEqual(calls,['/api/growth','/api/looks','/api/companion','/api/artwork','/api/appearance/drafts']);
  assert.doesNotMatch(script,/localStorage|sessionStorage|indexedDB/);
});
test('empty catalog and missing art keep default cosmetic avatar',async()=>{
  const {get,click}=await mount([]);
  await click('loadSkins');
  assert.match(get('skinStatus').textContent,/まだありません/);
  assert.equal(get('portrait').hidden,true);
  assert.equal(get('chibi').hidden,false);
});
