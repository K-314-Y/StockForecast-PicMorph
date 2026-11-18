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
const idlePath = '/assets/hatchpet-demo-idle.webp';
const idleBytes = await readFile(new URL('.'+idlePath,root));

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
    this.handlers={};this.children=[];this.attributes={};this.dataset={};this.value='';
    this.hidden=false;this.disabled=false;this.textContent='';
    this.style=new Map();
    this.style.setProperty=this.style.set.bind(this.style);
    this.style.removeProperty=this.style.delete.bind(this.style);
  }
  addEventListener(k,fn){this.handlers[k]=fn;}
  replaceChildren(...nodes){this.children=[...nodes];}
  append(n){this.children.push(n);}
  setAttribute(k,v){this.attributes[k]=v;}
  async click(name='click'){return this.handlers[name]?.({preventDefault(){}});}
}
async function mount(drafts=catalog().drafts, {artwork=false, companion={}, look={}, decode=async()=>{}}={}) {
  const nodes=new Map(),calls=[],writes=[],urls=new Map();
  const companionRecord={revision:0,created:false,companion:{name:'私の相棒',hair_color:'#8882db',
    clothing_color:'#92e1d4',approach:'trend',risk_percent:35,...companion}};
  const lookRecord={revision:0,created:false,look:{hair_style:'bob',expression:'cheerful',accessory:'ribbon',...look}};
  const $=id=>{
    if(!nodes.has(id))nodes.set(id,new Element());
    return nodes.get(id);
  };
  const fetch=async (path,options)=>{
    calls.push(path);
    if (options?.method === 'POST') {
      const body=JSON.parse(options.body);
      writes.push({path,body});
      const record=path==='/api/companion' ? companionRecord : path==='/api/looks' ? lookRecord : null;
      assert.ok(record,'only appearance forms can write in this harness');
      record.revision++;
      record.created=true;
      Object.assign(record,body.companion ? {companion:body.companion} : {look:body.look});
    }
    if(path===idlePath) {
      assert.equal(options.mode,'same-origin');
      return {ok:true,blob:async()=>new Blob([idleBytes],{type:'image/webp'})};
    }
    if(path==='/api/growth')return {ok:true,json:async()=>({
      revision:0,slots:[{slot:'mine',level:1,xp:0,gear:'none',
        gear_options:[{id:'none',unlocked:true,name:'装備なし',icon:'·'}]}]})};
    if(path==='/api/appearance/drafts')return {ok:true,json:async()=>({drafts})};
    if(path==='/api/looks')return {ok:true,json:async()=>lookRecord};
    if(path==='/api/companion')return {ok:true,json:async()=>companionRecord};
    if(path==='/api/artwork')return {ok:true,json:async()=>({revision:0,created:artwork,
      slots:Object.fromEntries(['base','hair','face','outfit'].map(slot=>[slot,{exists:artwork && slot==='base',mime:null,size:0}]))})};
    throw Error('unexpected browser fetch '+path);
  };
  class Image {
    async decode() {
      assert.ok(urls.has(this.src));
      await decode();
      this.naturalWidth=1152;
      this.naturalHeight=208;
    }
  }
  let nextUrl=0;
  runInNewContext(script,{document:{getElementById:$,createElement:()=>new Element()},fetch,Image,
    URL:{createObjectURL(blob){const url='blob:fixture/'+ ++nextUrl;urls.set(url,blob);return url;},
      revokeObjectURL:url=>urls.delete(url)}});
  // Drain initialization fetch/json continuations before firing UI events or ending a test.
  await new Promise(resolve=>setImmediate(resolve));
  assert.match($('lookStatus').textContent,/パーツは未保存/);
  assert.match($('companionStatus').textContent,/まだ未作成/);
  assert.match($('artworkStatus').textContent,artwork?/保存済みイラストを復元/:/まだ画像は保存されていません/);
  return {get:$,calls,writes,urls,click:async(id,evt='click')=>$(id).click(evt)};
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

test('the demo atlas route serves exact bytes and accepts only same-origin GET to the fixed path',async()=>{
  const server=createGameServer();
  server.address=()=>({port:8890});
  const [handleRequest]=server.listeners('request');
  async function send(url,method='GET',headers={}) {
    const response={};
    await handleRequest({url,method,headers:{host:'127.0.0.1:8890',...headers},socket:{remoteAddress:'127.0.0.1'}},{
      writeHead(status,headers) {
        response.status=status;
        response.headers=new Headers(headers);
      },
      end(body){response.body=body;},
    });
    return response;
  }
  const response=await send(idlePath);
  assert.equal(response.status,200);
  for (const [name,value] of Object.entries({'content-type':'image/webp','cache-control':'no-store',
    'x-content-type-options':'nosniff','x-frame-options':'DENY','content-length':String(idleBytes.length),
    'cross-origin-resource-policy':'same-origin',
    'content-security-policy':"default-src 'none'; frame-ancestors 'none'; sandbox"})) {
    assert.equal(response.headers.get(name),value,name);
  }
  assert.deepEqual(response.body,idleBytes);
  for (const path of ['/assets/', '/assets/other.webp', '/assets/%2e%2e%2flocal_state/private',
    '/assets/../assets/hatchpet-demo-idle.webp', '/assets/%68atchpet-demo-idle.webp', '/local_state/private', '/workspaces/private']) {
    assert.equal((await send(path)).status,404,path);
  }
  assert.equal((await send(idlePath,'HEAD')).status,404);
  assert.equal((await send(idlePath,'POST')).status,404);
  assert.equal((await send(idlePath,'GET',{origin:'https://other.invalid'})).status,403);
  assert.equal((await send(idlePath,'GET',{origin:'http://localhost:8890'})).status,403);
  assert.equal((await send(idlePath,'GET',{origin:'http://127.0.0.1:8890'})).status,200);
});

test('the optional front character button uses six idle frames inside the chibi and a static first frame for reduced motion',()=>{
  const front=html.slice(html.indexOf('id="frontCharacter"'),html.indexOf('id="simpleHome"'));
  assert.match(front,/<button id="hatchIdleToggle"[^>]*aria-pressed="false"[^>]*>動くデモを見る<\/button>/);
  assert.match(front,/実験用に生成した固定デモ画像。髪や服の色・予測モデルは変わりません。自作イラストには適用しません。/);
  const sprite=/\.scene\[data-mood="ready"\]:not\(\[data-expression-other-model\]\) #chibi\[data-hatch-idle="true"\]:not\(\[hidden\]\)::after/;
  const declarations=html.match(new RegExp(sprite.source+'\\{([^}]+)\\}'))?.[1];
  assert.ok(declarations);
  assert.match(declarations,/width:150px;height:162\.5px/);
  assert.match(declarations,/background-size:900px 162\.5px;background-position:0 0/);
  assert.match(declarations,/steps\(6,jump-none\)/);
  assert.match(html,/@keyframes hatch-idle-frames\{to\{background-position:-750px 0\}\}/);
  const reduced=html.split('@media(prefers-reduced-motion:reduce)')[1].split('</style>')[0];
  assert.match(reduced,sprite);
  assert.match(reduced,/animation:none/);
  assert.doesNotMatch(html,/\/assets\/hatchpet-demo-idle/);
  assert.doesNotMatch(script,/setTimeout|setInterval|requestAnimationFrame/);
});

test('preview loads on click and can be toggled off without persisting appearance',async()=>{
  const {get,click,calls,writes,urls}=await mount();
  const button=get('hatchIdleToggle');
  const chibi=get('chibi');
  assert.equal(button.disabled,false);
  assert.equal(button.attributes['aria-pressed'],'false');
  assert.equal(calls.includes(idlePath),false);
  await click('hatchIdleToggle');
  assert.equal(button.attributes['aria-pressed'],'true');
  assert.equal(chibi.dataset.hatchIdle,'true');
  assert.equal(chibi.style.get('--hatch-idle-image'),'url("blob:fixture/1")');
  await click('hatchIdleToggle');
  assert.equal(button.attributes['aria-pressed'],'false');
  assert.equal(chibi.dataset.hatchIdle,undefined);
  assert.equal(urls.size,0);
  assert.deepEqual(writes,[]);
});

test('custom preview, save, reload and restored appearance take priority over the sprite',async()=>{
  const ui=await mount();
  const {get,click,writes}=ui;
  await click('hatchIdleToggle');
  get('creatorClothing').value='#ff6677';
  await click('creatorClothing','input');
  assert.equal(get('hatchIdleToggle').disabled,true);
  assert.equal(get('hatchIdleToggle').attributes['aria-pressed'],'false');
  assert.equal(get('chibi').dataset.hatchIdle,undefined);
  assert.match(get('chibi').attributes.style,/--clothing:#ff6677/);
  await click('companionForm','submit');
  await click('reloadCompanion');
  assert.equal(writes[0].body.companion.clothing_color,'#ff6677');
  assert.equal(get('hatchIdleToggle').disabled,true);
  assert.match(get('chibi').attributes.style,/--clothing:#ff6677/);
  get('creatorClothing').value='#92e1d4';
  await click('creatorClothing','input');
  assert.equal(get('hatchIdleToggle').disabled,false);
  assert.equal(get('hatchIdleToggle').attributes['aria-pressed'],'false');
  for (const appearance of [{companion:{clothing_color:'#ff6677'}},{companion:{hair_color:'#ff6677'}},
    {look:{hair_style:'long'}},{look:{expression:'calm'}},{look:{accessory:'glasses'}}]) {
    const restored=await mount(undefined,appearance);
    assert.equal(restored.get('hatchIdleToggle').disabled,true);
    await restored.click('hatchIdleToggle');
    assert.equal(restored.calls.includes(idlePath),false);
  }
});

test('saved artwork and portraits suppress the preview during loading and after display',async()=>{
  const {get,click,calls}=await mount(undefined,{artwork:true});
  assert.equal(get('hatchIdleToggle').disabled,true);
  get('artworkBase').onload();
  assert.equal(get('chibi').hidden,true);
  assert.equal(calls.includes(idlePath),false);
  await click('showChibi');
  await click('hatchIdleToggle');
  await click('showArtwork');
  assert.equal(get('chibi').dataset.hatchIdle,undefined);
  assert.equal(get('hatchIdleToggle').disabled,true);
  await click('showChibi');
  await click('loadSkins');
  await click('hatchIdleToggle');
  get('skinSelect').value=id;
  await click('skinSelect','change');
  assert.equal(get('chibi').dataset.hatchIdle,undefined);
  assert.equal(get('hatchIdleToggle').disabled,true);
  get('portrait').onload();
  assert.equal(get('chibi').hidden,true);
  await click('showChibi');
  assert.equal(get('hatchIdleToggle').disabled,false);
  assert.equal(get('hatchIdleToggle').attributes['aria-pressed'],'false');
});

test('decode failure and switching appearance during decode leave the CSS chibi intact',async()=>{
  const failed=await mount(undefined,{decode:async()=>{throw Error('corrupt image');}});
  await failed.click('hatchIdleToggle');
  assert.equal(failed.get('chibi').dataset.hatchIdle,undefined);
  assert.equal(failed.get('hatchIdleToggle').disabled,false);
  assert.match(failed.get('hatchIdleStatus').textContent,/デモ画像を表示できません/);
  assert.equal(failed.urls.size,0);

  let finish;
  const decoding=new Promise(resolve=>{finish=resolve;});
  const pending=await mount(undefined,{decode:()=>decoding});
  const activation=pending.click('hatchIdleToggle');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(pending.urls.size,1);
  pending.get('lookHair').value='long';
  await pending.click('lookHair','change');
  finish();
  await activation;
  assert.equal(pending.get('chibi').dataset.hatchIdle,undefined);
  assert.equal(pending.get('chibi').dataset.hairStyle,'long');
  assert.equal(pending.urls.size,0);
});
test('empty catalog and missing art keep default cosmetic avatar',async()=>{
  const {get,click}=await mount([]);
  await click('loadSkins');
  assert.match(get('skinStatus').textContent,/まだありません/);
  assert.equal(get('portrait').hidden,true);
  assert.equal(get('chibi').hidden,false);
});
