import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync(new URL('../../web/pack-lab.html',import.meta.url),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
function harness(){
  const nodes=new Map(),draws=[],closed=[],urls=[],clicks=[];
  function element(){return {disabled:true,children:[],width:1,height:1,value:'fallback',append(...n){this.children.push(...n);},replaceChildren(){this.children=[];},getContext(){return {clearRect(){draws.length=0;},drawImage(img){draws.push(img.name);}};},toBlob(fn,type){fn(new Blob(['image'],{type}));},click(){clicks.push(this.download);}};}
  const sandbox={console,Blob,Map,Set,Uint8Array,DataView,JSON,Error,Number,Array,String,Promise,
    document:{getElementById(id){if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);},createElement:element},
    window:{addEventListener(){}},URL:{createObjectURL(){urls.push('created');return 'blob:local';},revokeObjectURL(){urls.push('revoked');}},setTimeout(fn){fn();},
    async createImageBitmap(file){return {width:2,height:2,name:file.name,close(){closed.push(file.name);}};}};
  const context=vm.createContext(sandbox);vm.runInContext(script,context);
  return {context,nodes,draws,closed,urls,clicks,run:s=>vm.runInContext(s,context)};
}
const manifest=()=>({manifest_version:1,canvas:{width:2,height:2},source:{kind:'image',sha256:'a'.repeat(64)},mode_default:'fallback',layers:[{id:'layer_00',slot:'unclassified',path:'parts/layer_00.png',z:0,visible:true}]});
function blob(name,data,type=''){return Object.assign(new Blob([data],{type}),{name,webkitRelativePath:''});}
function png(name){const bytes=new Uint8Array(24);bytes.set([137,80,78,71,13,10,26,10]);const view=new DataView(bytes.buffer);view.setUint32(16,2);view.setUint32(20,2);return blob(name,bytes,'image/png');}
function files(m=manifest()){return [blob('manifest.json',JSON.stringify(m)),png('original.png'),png('layer_00.png')];}

test('manifest rejects traversal, duplicates, invalid sizes/types and excessive memory',()=>{
  const h=harness();h.context.m=manifest();h.run('validateManifest(m)');
  for(const path of ['../a.png','parts/../a.png','parts/a/b.png','parts/a.svg','original.png','https://evil/a.png','parts/a%2e.png']){
    h.context.m=manifest();h.context.m.layers[0].path=path;assert.throws(()=>h.run('validateManifest(m)'));
  }
  for(const patch of [{manifest_version:true},{mode_default:'both'},{canvas:{width:4097,height:1}},{layers:Array(65).fill(manifest().layers[0])},{canvas:{width:4096,height:4096},layers:Array.from({length:5},(_,i)=>({...manifest().layers[0],id:`l${i}`,path:`parts/l${i}.png`,z:i}))}]){
    h.context.m={...manifest(),...patch};assert.throws(()=>h.run('validateManifest(m)'));
  }
});
test('file indexing accepts directory and individual files, rejects duplicates and quotas',()=>{
  const h=harness();h.context.files=files();assert.equal(h.run('indexFiles(files).size'),3);
  h.context.files=files().map(f=>Object.assign(f,{webkitRelativePath:'pack/'+(f.name==='layer_00.png'?'parts/':'')+f.name}));assert.equal(h.run('indexFiles(files).size'),3);
  for(const bad of [[...files(),png('layer_00.png')],[...files(),blob('../evil.png','x')],[...files(),{name:'source.psd',size:21*1024*1024}],[...files(),{name:'source.psd',size:301*1024*1024}]]){h.context.files=bad;assert.throws(()=>h.run('indexFiles(files)'));}
});
test('render plan never overlays fallback and parts; z order and visibility explicit',()=>{
  const h=harness();h.context.m=manifest();h.context.m.layers.push({id:'back',path:'parts/back.png',slot:'unclassified',z:-1,visible:true});
  assert.equal(h.run('JSON.stringify(renderPlan(m,"fallback"))'),'["original.png"]');
  assert.equal(h.run('JSON.stringify(renderPlan(m,"layers"))'),'["parts/back.png","parts/layer_00.png"]');
  h.context.m.layers[0].visible=false;assert.equal(h.run('JSON.stringify(renderPlan(m,"layers"))'),'["parts/back.png"]');
});
test('local import, exclusive canvas draw, full resolution export and resource cleanup',async()=>{
  const h=harness();h.context.files=files();await h.run('openPack(files)');
  assert.match(h.nodes.get('status').textContent,/読込完了/);assert.deepEqual(h.draws,['original.png']);
  assert.equal(h.nodes.get('preview').width,2);h.nodes.get('mode').value='layers';h.run('render()');assert.deepEqual(h.draws,['layer_00.png']);
  await h.run('download("image/png")');await h.run('download("image/webp")');assert.deepEqual(h.clicks,['character.png','character.webp']);assert.deepEqual(h.urls,['created','revoked','created','revoked']);
  await h.run('openPack(files)');assert.equal(h.closed.length,2);
});
test('bad signature or mismatched dimensions fails closed and releases decoded images',async()=>{
  const h=harness();h.context.files=[...files().slice(0,2),blob('layer_00.png','bad','image/png')];await h.run('openPack(files)');
  assert.equal(h.nodes.get('png').disabled,true);assert.equal(h.closed.length,1);assert.match(h.nodes.get('status').textContent,/署名/);
  const mismatch=png('layer_00.png');h.context.file=mismatch;
  await assert.rejects(h.run('decodeAsset(file,"parts/layer_00.png",{width:4096,height:4096})'));
});
test('no network, storage, dynamic HTML, or remote dependencies in standalone viewer',()=>{
  assert.doesNotMatch(html,/\b(?:fetch|XMLHttpRequest|localStorage|sessionStorage|innerHTML)\b|<script[^>]+src=|https?:\/\//);
  assert.match(html,/webkitdirectory/);assert.match(html,/textContent/);assert.match(html,/toBlob/);
});
