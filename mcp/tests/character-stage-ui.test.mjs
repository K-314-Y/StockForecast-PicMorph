import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('../../web/game.html',import.meta.url),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
function harness({drafts=[],denied=false,bitmap=true,canvas=true}={}){
  const nodes=new Map(),calls=[],draws=[],closed=[],created=[],revoked=[],events={};
  function node(){return {value:'',hidden:false,children:[],appendChild(n){this.children.push(n);},replaceChildren(...n){this.children=n;},removeAttribute(k){delete this[k];},getContext(){return canvas?{drawImage(img){draws.push(img.name);}}:null;},toBlob(fn){fn(new Blob(['png'],{type:'image/png'}));}};}
  const get=id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);};
  const context=vm.createContext({Blob,Uint8Array,DataView,Map,Set,location:{origin:'http://localhost:8765'},
    document:{getElementById:get,createElement:node},window:{addEventListener(k,fn){events[k]=fn;}},
    URL:{createObjectURL(){const url='blob:'+created.length;created.push(url);return url;},revokeObjectURL(url){revoked.push(url);}},
    fetch:async(path,opts)=>{calls.push({path,opts});return {ok:!denied,json:async()=>({drafts})};},
    createImageBitmap:bitmap?async f=>({width:2,height:2,name:f.name,close(){closed.push(f.name);}}):undefined});
  vm.runInContext(script,context);
  return {get,calls,draws,closed,created,revoked,events,context,select(id){get('portraitSelect').value=id;get('portraitSelect').onchange();},async pack(files){get('characterPack').files=files;await get('characterPack').onchange();}};
}
const id='bp_'+'a'.repeat(32),path='/api/blueprints/'+id+'/image';
const draft=(url=path)=>({id,user_declared:{name:'若葉'},visual_asset:{url}});
const manifest=()=>({manifest_version:1,canvas:{width:2,height:2},source:{kind:'image',sha256:'a'.repeat(64)},mode_default:'fallback',layers:[{id:'leaf',slot:'body',path:'parts/leaf.png',z:1,visible:true}]});
function file(path,data,type=''){return Object.assign(new Blob([data],{type}),{name:path.split('/').at(-1),webkitRelativePath:'pack/'+path});}
function png(path){const a=new Uint8Array(33);a.set([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82]);const v=new DataView(a.buffer);v.setUint32(16,2);v.setUint32(20,2);return file(path,a,'image/png');}
const files=(m=manifest())=>[file('manifest.json',JSON.stringify(m)),png('original.png'),...m.layers.map(l=>png(l.path))];

test('catalog loads only on action, selection uses canonical path and is cosmetic',async()=>{
  const h=harness({drafts:[draft(),{...draft(),id:'../evil'}, {...draft(),id:'bp_'+'b'.repeat(32),visual_asset:null}]});
  assert.equal(h.calls.length,0);assert.equal(h.get('characterPortrait').src,undefined);
  await h.get('portraitReload').onclick();assert.equal(h.calls.length,1);
  assert.equal(h.get('portraitSelect').children.length,2);assert.equal(h.get('characterPortrait').src,undefined);
  h.select(id);assert.equal(h.get('characterPortrait').src,path);assert.equal(h.get('characterGeneric').hidden,true);
  assert.match(h.get('characterSource').textContent,/若葉/);assert.equal(h.calls[0].opts.method,'GET');
  h.get('characterPortrait').onerror();assert.equal(h.get('characterGeneric').hidden,false);assert.equal(h.get('characterPortrait').src,undefined);
  assert.equal(h.calls.length,1);
});
test('absent, denied, unsafe URLs and invalid IDs never select an image',async()=>{
  for(const drafts of [[],[draft('https://evil.test/'+path)],[draft('//localhost:8765'+path)],[draft(path+'?x')],[{...draft(),id:'bp_'+'A'.repeat(32)}]]){
    const h=harness({drafts});await h.get('portraitReload').onclick();h.select(id);assert.equal(h.get('characterPortrait').src,undefined);assert.match(h.get('portraitStatus').textContent,/汎用/);
  }
  const h=harness({denied:true});await h.get('portraitReload').onclick();assert.match(h.get('portraitStatus').textContent,/取得できません/);
  const same=harness({drafts:[draft('http://localhost:8765'+path)]});await same.get('portraitReload').onclick();same.select(id);assert.equal(same.get('characterPortrait').src,path);
});
test('PACK fallback and sorted visible layers never double draw; resources close and URLs dispose',async()=>{
  const h=harness();await h.pack(files());assert.deepEqual(h.draws,['original.png']);assert.equal(h.created.length,1);
  const m=manifest();m.mode_default='layers';m.layers.push({id:'back',slot:'body',path:'parts/back.png',z:-1,visible:true},{id:'hide',slot:'body',path:'parts/hide.png',z:3,visible:false});
  h.draws.length=0;await h.pack(files(m));assert.deepEqual(h.draws,['back.png','leaf.png']);assert.deepEqual(h.revoked,['blob:0']);assert.match(h.get('characterSource').textContent,/このセッション/);
  h.events.pagehide();assert.deepEqual(h.revoked,['blob:0','blob:1']);assert.equal(h.closed.length,9);assert.equal(h.calls.length,0);
});
test('replacing PACK by saved draft or standard releases URL',async()=>{
  const h=harness({drafts:[draft()]});await h.get('portraitReload').onclick();await h.pack(files());h.select(id);assert.deepEqual(h.revoked,['blob:0']);assert.equal(h.get('characterPortrait').src,path);
  await h.pack(files());h.get('portraitDefault').onclick();assert.deepEqual(h.revoked,['blob:0','blob:1']);assert.equal(h.get('characterGeneric').hidden,false);
});
test('invalid manifest versions, paths, quotas, modes, signatures and dimensions fail to standard',async()=>{
  const mutations=[m=>m.manifest_version=true,m=>m.manifest_version=2,m=>m.mode_default='both',m=>m.canvas.width=4097,m=>m.layers[0].path='parts/../evil.png',m=>m.layers[0].path='parts/a.webp',m=>m.layers[0].visible=1,m=>m.layers.push({...m.layers[0]}),m=>{m.canvas={width:4096,height:4096};m.layers=Array.from({length:5},(_,i)=>({...m.layers[0],id:'a'+i,path:'parts/a'+i+'.png',z:i}));}];
  for(const mutate of mutations){const m=manifest();mutate(m);const h=harness();await h.pack(files(m));assert.equal(h.created.length,0);assert.equal(h.get('characterGeneric').hidden,false);assert.match(h.get('portraitStatus').textContent,/表示できません/);}
  const invalidFiles=[Array(68).fill(png('original.png')), [...files(),png('parts/../bad.png')], [...files(),png('parts/x.png')], [...files(),{name:'source.psd',webkitRelativePath:'pack/source.psd',size:21*1024*1024}], [file('manifest.json',' '.repeat(131073)),png('original.png'),png('parts/leaf.png')], [...files().slice(0,2),file('parts/leaf.png','bad','image/png')], [...files().slice(0,2),file('parts/leaf.png',await png('parts/leaf.png').arrayBuffer(),'image/jpeg')]];
  const mismatch=png('parts/leaf.png');const b=new Uint8Array(await mismatch.arrayBuffer());new DataView(b.buffer).setUint32(16,4096);invalidFiles.push([...files().slice(0,2),file('parts/leaf.png',b,'image/png')]);
  for(const list of invalidFiles){const h=harness();await h.pack(list);assert.equal(h.created.length,0);assert.match(h.get('portraitStatus').textContent,/表示できません/);}
});
test('unsupported browser APIs preserve gameplay fallback',async()=>{
  for(const opts of [{bitmap:false},{canvas:false}]){const h=harness(opts);await h.pack(files());assert.equal(h.get('characterGeneric').hidden,false);assert.match(h.get('portraitStatus').textContent,/未対応/);}
});
test('pending import cannot replace a later explicit selection or survive pagehide',async()=>{
  for(const cancel of [h=>h.get('portraitDefault').onclick(),h=>h.events.pagehide()]){
    const h=harness();let resolve;const pending=new Promise(r=>resolve=r);h.context.createImageBitmap=()=>pending;
    const loading=h.pack(files());await new Promise(r=>setImmediate(r));cancel(h);resolve({width:2,height:2,close(){h.closed.push('pending');}});await loading;
    assert.equal(h.created.length,0);assert.deepEqual(h.closed,['pending']);
  }
});
test('appearance script has no persistence, trading writes, timers or injected HTML',()=>{
  assert.doesNotMatch(script,/localStorage|sessionStorage|innerHTML|setTimeout|setInterval|method:\s*['"]POST|\/api\/(?:practice|training|lineup|code|visual)/);
  assert.match(html,/prefers-reduced-motion:reduce/);assert.match(html,/汎用アバター/);
});

test('file and aggregate byte limits apply before any decoding',async()=>{
  for(const sizes of [[71*1024*1024],[...Array(5).fill(70*1024*1024)]]){
    const h=harness();const list=files();list.push(...sizes.map((size,i)=>({name:'extra'+i+'.png',webkitRelativePath:'pack/parts/extra'+i+'.png',size})));
    await h.pack(list);assert.equal(h.created.length,0);assert.equal(h.closed.length,0);assert.match(h.get('portraitStatus').textContent,/サイズ制限/);
  }
});
test('decoded size mismatch and failed PNG export release resources and keep standard',async()=>{
  const h=harness();h.context.createImageBitmap=async()=>({width:3,height:2,close(){h.closed.push('mismatch');}});
  await h.pack(files());assert.deepEqual(h.closed,['mismatch']);assert.equal(h.created.length,0);
  const n=harness();const create=n.context.document.createElement;n.context.document.createElement=tag=>{const node=create(tag);node.toBlob=fn=>fn(null);return node;};
  await n.pack(files());assert.equal(n.created.length,0);assert.equal(n.closed.length,3);assert.equal(n.get('characterGeneric').hidden,false);
});
test('both inline scripts parse independently without changing beginner extraction markers',()=>{
  for(const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g))assert.doesNotThrow(()=>new vm.Script(match[1]));
  assert.equal((html.match(/\/\/ Beginner mode reuses the existing fixed, fictional practice/g)||[]).length,1);
  assert.equal((html.match(/\/\/ Details use only the existing evaluation ledger/g)||[]).length,1);
});
