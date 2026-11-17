import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,stat,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {createArtworkStore,validateArtworkImage} from '../../game_runtime/artwork.mjs';
import {createGameServer} from '../../game_runtime/server.mjs';
import {createCompanionChatGptHttpServer} from '../companion-chatgpt.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const png={mime:'image/png',base64:'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGMMqFjAwMDAxMDAwMDAAAAQugFsZnyF3gAAAABJRU5ErkJggg=='};
const slots=['base','hair','face','outfit'];
const send=async(url,path,body,headers={})=>fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
async function serve(t,run) {
 const dir=await mkdtemp(join(tmpdir(),'creature-s34-art-'));
 const file=join(dir,'artwork.json'),artworkStore=createArtworkStore({file});
 const game=createGameServer({artworkStore});
 await new Promise(ok=>game.listen(0,'127.0.0.1',ok));
 const gameUrl='http://127.0.0.1:'+game.address().port;
 const mcp=createCompanionChatGptHttpServer({apiBase:gameUrl});
 await new Promise(ok=>mcp.listen(0,'127.0.0.1',ok));
 const mcpUrl='http://127.0.0.1:'+mcp.address().port;
 t.after(async()=>{
   await new Promise(ok=>mcp.close(ok));
   await new Promise(ok=>game.close(ok));
   await rm(dir,{recursive:true,force:true});
 });
 await run({file,dir,gameUrl,mcpUrl,artworkStore});
}
test('read-only metadata without writes, valid PNG, explicit save and clear persist revision',async t=>{
 await serve(t,async({file,dir,gameUrl,artworkStore})=>{
   const before=await fetch(gameUrl+'/api/artwork').then(r=>r.json());
   assert.equal(before.created,false);
   assert.equal(before.revision,0);
   for(const slot of slots) assert.equal(before.slots[slot].exists,false);
   await assert.rejects(stat(file),{code:'ENOENT'});
   let res=await send(gameUrl,'/api/artwork',{expected_revision:0,slot:'base',image:png});
   assert.equal(res.status,200,await res.text());
   const meta=await artworkStore.read();
   assert.equal(meta.revision,1);
   assert.equal(meta.slots.base.mime,'image/png');
   assert.equal(meta.slots.face.exists,false);
   assert.equal('base64' in meta,false);
   const raw=await fetch(gameUrl+'/api/artwork/image/base');
   assert.equal(raw.status,200);
   assert.equal(raw.headers.get('content-type'),'image/png');
   assert.equal(raw.headers.get('x-content-type-options'),'nosniff');
   assert.equal(raw.headers.get('cache-control'),'no-store');
   assert.match(raw.headers.get('content-security-policy'),/sandbox/);
   assert.deepEqual(Buffer.from(await raw.arrayBuffer()),Buffer.from(png.base64,'base64'));
   assert.equal((await fetch(gameUrl+'/api/artwork/image/face')).status,404);
   const stale=await send(gameUrl,'/api/artwork',{expected_revision:0,slot:'base',image:null});
   assert.equal(stale.status,409);
   res=await send(gameUrl,'/api/artwork',{expected_revision:1,slot:'base',image:null});
   assert.equal(res.status,200);
   assert.equal((await res.json()).revision,2);
   assert.equal((await fetch(gameUrl+'/api/artwork/image/base')).status,404);
   assert.equal((await artworkStore.read()).slots.base.exists,false);
   assert.deepEqual(await readdir(dir),['artwork.json']);
 });
});
test('rejects forged image, bad base64, wrong MIME, oversized payload, unknown slots, cross-origin',async t=>{
 await serve(t,async({gameUrl,dir})=>{
   for(const [slot,image] of [
     ['base',{mime:'image/svg+xml',base64:png.base64}],
     ['hair',{mime:'image/jpeg',base64:png.base64}],
     ['face',{mime:'image/png',base64:'@@@@'}],
     ['base',{mime:'image/png',base64:Buffer.from('<script>alert(1)</script>').toString('base64')}],
     ['base',{...png,base64:png.base64+' '}],
     ['script',png],
   ]) {
     const response=await send(gameUrl,'/api/artwork',{expected_revision:0,slot,image});
     assert.ok([400,415].includes(response.status),slot+' '+response.status);
   }
   const huge={...png,base64:Buffer.alloc(500*1024).toString('base64')};
   assert.throws(()=>validateArtworkImage('base',huge),{status:413});
   assert.equal((await send(gameUrl,'/api/artwork',{expected_revision:0,slot:'base',image:huge})).status,413);
   const evil=await send(gameUrl,'/api/artwork',{expected_revision:0,slot:'base',image:png},
     {Origin:'https://attacker.invalid'});
   assert.equal(evil.status,403);
   assert.equal((await fetch(gameUrl+'/api/artwork/image/../../../etc/passwd')).status,404);
   assert.deepEqual(await readdir(dir),[]);
 });
});
test('serializes concurrent artwork writes; never silently resets corrupted saved images',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'creature-s34-art-race-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=join(dir,'artwork.json'),a=createArtworkStore({file}),b=createArtworkStore({file});
 const race=await Promise.allSettled([
   a.save({expected_revision:0,slot:'base',image:png}),
   b.save({expected_revision:0,slot:'hair',image:png}),
 ]);
 assert.equal(race.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(race.filter(r=>r.status==='rejected').length,1);
 assert.equal((await a.read()).revision,1);
 await writeFile(file,'{"wrong":true}');
 await assert.rejects(a.read(),{status:503});
 await assert.rejects(a.save({expected_revision:0,slot:'base',image:png}),{status:503});
});
test('MCP reads artwork presence but never returns image bytes',async t=>{
 await serve(t,async({gameUrl,mcpUrl})=>{
  const c=new Client({name:'art-meta-test',version:'1.0.0'});
  await c.connect(new StreamableHTTPClientTransport(new URL(mcpUrl+'/mcp')));
  try {
    const tools=(await c.listTools()).tools.map(x=>x.name);
    assert.equal(tools.length,10);
    assert.ok(tools.includes('get_my_artwork'));
    assert.equal(tools.some(x=>x.includes('upload')||x.includes('write_artwork')),false);
    const before=await c.callTool({name:'get_my_artwork',arguments:{}});
    assert.equal(before.structuredContent.revision,0);
    assert.equal(before.structuredContent.slots.base.exists,false);
    await send(gameUrl,'/api/artwork',{expected_revision:0,slot:'base',image:png});
    const after=await c.callTool({name:'get_my_artwork',arguments:{}});
    assert.equal(after.structuredContent.slots.base.exists,true);
    assert.equal(JSON.stringify(after).includes(png.base64),false);
  }finally{await c.close();}
 });
});
test('game includes manual image layer inputs, keeps legacy DRAFT and CSS selector',async()=>{
 const html=await readFile(new URL('../../game_runtime/demo.html',import.meta.url),'utf8');
 const js=await readFile(new URL('../../game_runtime/demo.mjs',import.meta.url),'utf8');
 for(const name of ['Base','Hair','Face','Outfit']){
   assert.match(html,new RegExp('id="artworkFile'+name+'"'));
   assert.match(html,new RegExp('id="artworkSave'+name+'"'));
   assert.match(html,new RegExp('id="artworkClear'+name+'"'));
 }
 assert.match(html,/artworkStage/);
 assert.match(html,/自動切り抜き・自動分割は行いません/);
 assert.match(html,/skinSelect/);
 assert.match(html,/chibi/);
 assert.match(js,/URL\.createObjectURL/);
 assert.match(js,/revokeObjectURL/);
 assert.doesNotMatch(js,/innerHTML|localStorage/);
 assert.match(html,/①完成イラストを選ぶ → ② SAVE → ③ 練習へ戻る。これだけで自作キャラで遊べます。/);
 assert.match(html,/髪・顔・服の分割や画像工房は、あとからこだわりたい人向けの任意機能です。/);
 assert.match(html,/<p id="artworkPendingNotice" aria-live="polite"/);
 assert.match(html,/評価用の正解データとは別/);
 assert.match(html,/外部転送・自動反映はありません/);
});

// Exercise the actual browser module with controlled image decode events and no disk writes.
async function mountArtwork({baseSize=[128,128],storedHairSize=null,baseExists=true,storedSlots=null}={}) {
 const script=await readFile(new URL('../../game_runtime/demo.mjs',import.meta.url),'utf8');
 const nodes=new Map(),calls=[],confirms=[],revoked=[],images=new Map(),files=new Map(),windowHandlers={};
 class Element {
   constructor(){this.handlers={};this.children=[];this.attributes={};this.dataset={};this.value='';this.textContent='';}
   set innerHTML(_){throw Error('HTML insertion forbidden');}
   setAttribute(name,value){this.attributes[name]=value;}
   addEventListener(name,fn){this.handlers[name]=fn;}
   scrollIntoView(options){this.scrolls=(this.scrolls||0)+1;this.scrollOptions=options;}
   replaceChildren(...children){this.children=children;}
   append(child){this.children.push(child);}
   async fire(name='click'){await this.handlers[name]?.({preventDefault(){}});}
 }
 const get=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);};
 const state={accept:false,record:{revision:1,created:true,slots:Object.fromEntries(slots.map(slot=>
   [slot,{exists:storedSlots!==null ? storedSlots.includes(slot) :
     (slot==='base'&&baseExists)||(slot==='hair'&&storedHairSize!==null),mime:'image/png',size:88}]))}};
 const sizes={base:baseSize,hair:storedHairSize};
 const settle=async()=>{await new Promise(resolve=>setImmediate(resolve));};
 const fetch=async(path,options)=>{
   const body=options?.body?JSON.parse(options.body):undefined;
   calls.push({path,body});
   let value;
   if(path==='/api/artwork') {
     if(!body && state.getArtwork) await state.getArtwork();
     if(body) {
       assert.equal(body.expected_revision,state.record.revision);
       state.record={...state.record,revision:state.record.revision+1,slots:{...state.record.slots,
         [body.slot]:{exists:body.image!==null,mime:body.image?.mime,size:88}}};
       sizes[body.slot]=body.image?get('artworkFile'+body.slot[0].toUpperCase()+body.slot.slice(1)).files[0].dimensions:null;
     }
     value=state.record;
   } else if(path==='/api/growth')value={revision:0,slots:[{slot:'mine',xp:0,level:1,achievements:[]}]};
   else if(path==='/api/companion')value={revision:0,created:false,companion:{name:'私の相棒',hair_color:'#8882db',clothing_color:'#92e1d4',approach:'trend',risk_percent:35}};
   else if(path==='/api/looks')value={revision:0,created:false,look:{hair_style:'bob',expression:'cheerful',accessory:'ribbon'}};
   else throw Error('unexpected request '+path);
   return {ok:true,json:async()=>value};
 };
 class Image {
   set src(src) {
     images.set(src,this);
     const dimensions=files.get(src)?.dimensions??sizes[src.match(/image\/(\w+)/)?.[1]];
     if(dimensions==='pending')return;
     queueMicrotask(()=>{
       [this.naturalWidth,this.naturalHeight]=dimensions||[0,0];
       if(dimensions)this.onload();else this.onerror();
     });
   }
 }
 runInNewContext(script,{document:{getElementById:get,createElement:()=>new Element()},fetch,Image,
   URL:{createObjectURL(file){const url='blob:test-'+files.size;files.set(url,file);return url;},
     revokeObjectURL:url=>revoked.push(url)},
   btoa:value=>Buffer.from(value,'binary').toString('base64'),
   window:{confirm(message){confirms.push(message);return state.accept;},addEventListener(name,fn){windowHandlers[name]=fn;}}});
 await settle();
 async function select(slot,dimensions,extra={}) {
   const input=get('artworkFile'+slot[0].toUpperCase()+slot.slice(1));
   input.files=[{name:slot+'.png',type:'image/png',size:88,dimensions,
     arrayBuffer:async()=>Uint8Array.of(1,2,3).buffer,...extra}];
   await input.fire('change');await settle();
 }
 return {get,calls,confirms,revoked,images,state,select,settle,windowHandlers,
   writes:()=>calls.filter(call=>call.body),fire:(id,event)=>get(id).fire(event)};
}

test('known base/layer mismatch disables SAVE and blocks even direct clicks without altering stored layers',async()=>{
 const ui=await mountArtwork({storedHairSize:[64,128]});
 assert.match(ui.get('artworkInfoHair').textContent,/保存済み.*64×128px.*寸法が違います/);
 assert.equal(ui.get('artworkClearHair').disabled,false);
 await ui.select('hair',[128,64]);
 assert.match(ui.get('artworkInfoBase').textContent,/128×128px/);
 assert.match(ui.get('artworkInfoHair').textContent,/base 128×128px.*髪 128×64px.*選び直してください/);
 assert.equal(ui.get('artworkSaveHair').disabled,true);
 assert.equal(ui.get('artworkFileHair').attributes['aria-invalid'],'true');
 await ui.fire('artworkSaveHair');
 assert.equal(ui.confirms.length,0);
 assert.equal(ui.writes().length,0);
 assert.equal(ui.state.record.revision,1);
 await ui.select('hair',[128,128]);
 assert.equal(ui.get('artworkSaveHair').disabled,false);
 assert.equal(ui.get('artworkFileHair').attributes['aria-invalid'],'false');
 await ui.fire('artworkSaveHair'); // Cancel must keep the preview and saved data.
 assert.match(ui.confirms.at(-1),/髪（128×128px）.*SAVE/);
 assert.match(ui.confirms.at(-1),/同じ寸法.*余白・重なり/);
 assert.equal(ui.writes().length,0);
 assert.match(ui.get('artworkInfoHair').textContent,/未保存/);
 ui.state.accept=true;
 await ui.fire('artworkSaveHair');await ui.settle();
 assert.equal(ui.writes().length,1);
 assert.deepEqual(ui.writes()[0],{path:'/api/artwork',body:{expected_revision:1,slot:'hair',image:{mime:'image/png',base64:'AQID'}}});
 assert.ok(ui.revoked.length>=2);
});

test('pending dimensions block SAVE; late decodes cannot overwrite a replacement and unknown base stays a warning',async()=>{
 const ui=await mountArtwork({baseSize:null});
 await ui.select('face','pending');
 assert.equal(ui.get('artworkSaveFace').disabled,true);
 const oldImage=[...ui.images.values()].at(-1);
 await ui.select('face',[128,128]);
 oldImage.naturalWidth=1;oldImage.naturalHeight=1;oldImage.onload();
 assert.equal(ui.get('artworkSaveFace').disabled,false);
 assert.match(ui.get('artworkInfoFace').textContent,/128×128px.*base寸法が確認できない.*判断できません/);
 await ui.fire('artworkSaveFace');
 assert.match(ui.confirms.at(-1),/base寸法が確認できない.*判断できません/);
 assert.equal(ui.writes().length,0);
 ui.state.accept=true;
 await ui.fire('artworkSaveFace');
 assert.equal(ui.writes().length,1);
});

test('oversized replacement reports bytes and a dimension-preserving fix, clearing only the unsaved preview',async()=>{
 const ui=await mountArtwork({storedHairSize:[128,128]});
 await ui.select('hair',[128,128]);
 await ui.select('hair',[128,128],{size:450*1024+1});
 assert.match(ui.get('artworkStatus').textContent,/460,801 bytes（450.0KB）.*上限450KB.*圧縮して選び直し.*余白を切らず/);
 assert.match(ui.get('artworkInfoHair').textContent,/460,801 bytes.*圧縮して選び直し/);
 assert.equal(ui.get('artworkFileHair').attributes['aria-invalid'],'true');
 assert.equal(ui.get('artworkSaveHair').disabled,true);
 assert.match(ui.get('artworkInfoHair').textContent,/保存済み/);
 assert.equal(ui.get('artworkClearHair').disabled,false);
 assert.equal(ui.writes().length,0);
 await ui.select('hair',[128,128],{size:450*1024});
 assert.equal(ui.get('artworkSaveHair').disabled,false);
 assert.equal(ui.get('artworkFileHair').attributes['aria-invalid'],'false');
 await ui.select('hair',[128,128],{type:'image/jpeg'});
 assert.equal(ui.get('artworkSaveHair').disabled,true);
 assert.match(ui.get('artworkStatus').textContent,/レイヤーはPNG\/WebP/);
});

test('unsaved base cannot bypass the stored base check; saving base rechecks layers without changing them',async()=>{
 const ui=await mountArtwork();
 await ui.select('base',[256,128]);
 await ui.select('outfit',[256,128]);
 assert.equal(ui.get('artworkSaveOutfit').disabled,true);
 assert.match(ui.get('artworkInfoOutfit').textContent,/保存済みbase（128×128px）.*先に新しいbaseをSAVE/);
 await ui.fire('artworkSaveOutfit');
 assert.equal(ui.writes().length,0);
 ui.state.accept=true;
 await ui.fire('artworkSaveBase');await ui.settle();
 assert.equal(ui.get('artworkSaveOutfit').disabled,false);
 assert.equal(ui.writes().length,1);
 assert.equal(ui.writes()[0].body.slot,'base');
 assert.equal(ui.state.record.slots.outfit.exists,false);
 await ui.fire('artworkClearBase');await ui.settle();
 assert.equal(ui.get('artworkSaveOutfit').disabled,false);
 assert.match(ui.get('artworkInfoOutfit').textContent,/base寸法が確認できない/);
});

// Synthetic VM state only: cancellation must preserve both stored and pending artwork.
for (const action of ['Clear', 'Save']) {
 test(`base ${action} confirms before writes and cancellation preserves all UI state`,async()=>{
   const ui=await mountArtwork({storedHairSize:[128,128]});
   await ui.select('base',[128,128]);
   await ui.select('face',[128,128]);
   ui.get('artworkFileBase').value='synthetic-base.png';
   ui.get('skinSelect').value='synthetic-selection';
   const record=JSON.stringify(ui.state.record);
   const input=ui.get('artworkFileBase').files;
   const snapshot=()=>JSON.stringify(['artworkBase','artworkFace','artworkInfoBase','artworkStatus','skinSelect','skinCaption','artworkFileBase'].map(id=>{
     const n=ui.get(id);return [n.src,n.value,n.textContent,n.disabled,n.hidden,n.attributes];
   }));
   const before=snapshot(),revoked=[...ui.revoked];
   await ui.fire('artwork'+action+'Base');
   assert.equal(ui.writes().length,0);
   assert.equal(JSON.stringify(ui.state.record),record);
   assert.equal(snapshot(),before);
   assert.equal(ui.get('artworkFileBase').files,input);
   assert.deepEqual(ui.revoked,revoked);
   assert.equal(ui.confirms.length,1);
   assert.match(ui.confirms[0],action==='Clear'?/このPC.*削除/:/base.*既存.*置き換え/);
   assert.match(ui.confirms[0],action==='Clear'?/他の部位は変更しません/:/髪・顔・服.*変更しません/);
   ui.state.accept=true;
   await ui.fire('artwork'+action+'Base');await ui.settle();
   assert.deepEqual(ui.writes(),[{path:'/api/artwork',body:{expected_revision:1,slot:'base',
     image:action==='Clear'?null:{mime:'image/png',base64:'AQID'}}}]);
   assert.equal(ui.state.record.revision,2);
   for(const slot of ['hair','face','outfit']) assert.deepEqual(ui.state.record.slots[slot],JSON.parse(record).slots[slot]);
   assert.match(ui.get('artworkInfoFace').textContent,/未保存/);
 });
}
test('initial base SAVE needs no confirmation and writes only base',async()=>{
 const ui=await mountArtwork({baseExists:false});
 await ui.select('base',[128,128]);
 await ui.fire('artworkSaveBase');await ui.settle();
 assert.equal(ui.confirms.length,0);
 assert.deepEqual(ui.writes(),[{path:'/api/artwork',body:{expected_revision:1,slot:'base',image:{mime:'image/png',base64:'AQID'}}}]);
});
test('CLEAR of saved hair confirms and preserves its pending preview on cancel',async()=>{
 const ui=await mountArtwork({storedHairSize:[128,128]});
 await ui.select('hair',[128,128]);
 const src=ui.get('artworkHair').src;
 await ui.fire('artworkClearHair');
 assert.equal(ui.writes().length,0);
 assert.equal(ui.get('artworkHair').src,src);
 assert.match(ui.confirms[0],/髪.*このPC.*削除/);
 ui.state.accept=true;
 await ui.fire('artworkClearHair');
 assert.deepEqual(ui.writes(),[{path:'/api/artwork',body:{expected_revision:1,slot:'hair',image:null}}]);
 assert.equal(ui.state.record.slots.base.exists,true);
});

test('reload cancellation preserves all pending UI and makes no GET',async()=>{
 const ui=await mountArtwork();
 await ui.select('base',[128,128]);
 await ui.select('face',[128,128]);
 ui.get('artworkFileBase').value='synthetic.png';
 const snapshot=()=>JSON.stringify(['artworkBase','artworkFace','artworkFileBase','artworkStatus','skinCaption','artworkPendingNotice','reloadArtwork'].map(id=>ui.get(id)));
 const before=snapshot(),calls=ui.calls.length,revoked=[...ui.revoked];
 await ui.fire('reloadArtwork');
 assert.equal(ui.calls.length,calls);
 assert.equal(snapshot(),before);
 assert.deepEqual(ui.revoked,revoked);
 assert.match(ui.confirms.at(-1),/未保存.*破棄/);
 assert.match(ui.confirms.at(-1),/SAVEしていない画像は失われます/);
});

test('confirmed reload waits for successful GET before discarding previews and restores fetched metadata',async()=>{
 const ui=await mountArtwork();
 await ui.select('base',[128,128]);
 ui.get('artworkFileBase').value='synthetic.png';
 const src=ui.get('artworkBase').src,revoked=[...ui.revoked];
 let complete;
 ui.state.getArtwork=()=>new Promise(resolve=>{complete=resolve;});
 ui.state.accept=true;
 const loading=ui.fire('reloadArtwork');
 await ui.settle();
 assert.equal(ui.calls.at(-1).path,'/api/artwork');
 assert.equal(ui.calls.at(-1).body,undefined);
 assert.equal(ui.get('artworkBase').src,src);
 assert.equal(ui.get('artworkFileBase').value,'synthetic.png');
 assert.deepEqual(ui.revoked,revoked);
 assert.match(ui.get('artworkPendingNotice').textContent,/未保存の画像があります/);
 ui.state.record={...ui.state.record,revision:9};
 complete();await loading;await ui.settle();
 assert.ok(ui.revoked.includes(src));
 assert.equal(ui.get('artworkFileBase').value,'');
 assert.match(ui.get('artworkBase').src,/revision=9|[?&]v=9/);
 assert.match(ui.get('artworkStatus').textContent,/revision 9/);
 assert.equal(ui.get('artworkPendingNotice').textContent,'保存前の変更はありません。');
});

test('failed reload preserves pending display and saved revision for subsequent SAVE',async()=>{
 const ui=await mountArtwork();
 await ui.select('base',[128,128]);
 ui.get('artworkFileBase').value='synthetic.png';
 const src=ui.get('artworkBase').src,caption=ui.get('skinCaption').textContent,revoked=[...ui.revoked];
 ui.state.accept=true;
 ui.state.getArtwork=async()=>{throw Error('synthetic GET failure');};
 await ui.fire('reloadArtwork');
 assert.equal(ui.get('artworkBase').src,src);
 assert.equal(ui.get('skinCaption').textContent,caption);
 assert.equal(ui.get('artworkFileBase').value,'synthetic.png');
 assert.deepEqual(ui.revoked,revoked);
 assert.match(ui.get('artworkStatus').textContent,/読み込めません/);
 assert.equal(ui.get('artworkPendingNotice').textContent,'未保存の画像があります。SAVEするまで保存されません。');
 assert.equal(ui.get('artworkSaveBase').disabled,false);
 await ui.fire('artworkSaveBase');
 assert.equal(ui.writes()[0].body.expected_revision,1);
 assert.equal(ui.get('artworkPendingNotice').textContent,'保存前の変更はありません。');
});

test('reload with no pending images needs no confirmation; notice follows selection, cancel and save',async()=>{
 const ui=await mountArtwork();
 assert.equal(ui.get('artworkPendingNotice').textContent,'保存前の変更はありません。');
 const count=ui.calls.length;
 await ui.fire('reloadArtwork');
 assert.equal(ui.confirms.length,0);
 assert.equal(ui.calls.length,count+1);
 await ui.select('base',[128,128]);
 assert.equal(ui.get('artworkPendingNotice').textContent,'未保存の画像があります。SAVEするまで保存されません。');
 await ui.fire('artworkSaveBase');
 assert.match(ui.get('artworkPendingNotice').textContent,/未保存の画像があります/);
 ui.state.accept=true;
 await ui.fire('artworkSaveBase');
 assert.equal(ui.get('artworkPendingNotice').textContent,'保存前の変更はありません。');
});


test('artwork return click has one owner in quick-home, preserving practice focus',async()=>{
 const demo=await readFile(new URL('../../game_runtime/demo.mjs',import.meta.url),'utf8');
 const quick=await readFile(new URL('../../game_runtime/quick-home.mjs',import.meta.url),'utf8');
 const registration=/[\w$]+\(['"]artworkReturn['"]\)\??\.addEventListener\(['"]click['"]/g;
 assert.equal([...demo.matchAll(registration)].length,0);
 assert.equal([...quick.matchAll(registration)].length,1);
 assert.match(quick,/element\('artworkReturn'\)\.addEventListener\('click',\(\)=>scrollAndFocus\('simpleHome','quickModel'\)\)/);
});

test('beforeunload warns only with pending images and cancellation retains object URLs until pagehide',async()=>{
 const ui=await mountArtwork();
 const event=()=>({prevented:0,returnValue:undefined,preventDefault(){this.prevented++;}});
 const clean=event();ui.windowHandlers.beforeunload(clean);
 assert.equal(clean.prevented,0);assert.equal(clean.returnValue,undefined);
 assert.equal(ui.get('artworkPendingNotice').dataset.pending,'false');
 await ui.select('base',[128,128]);
 const src=ui.get('artworkBase').src,revoked=ui.revoked.length;
 const pending=event();ui.windowHandlers.beforeunload(pending);
 assert.equal(pending.prevented,1);assert.equal(pending.returnValue,'');
 assert.equal(ui.revoked.length,revoked);assert.equal(ui.get('artworkBase').src,src);
 assert.equal(ui.get('artworkPendingNotice').dataset.pending,'true');
 assert.equal(ui.writes().length,0);assert.equal(ui.confirms.length,0);
 ui.state.accept=true;await ui.fire('artworkSaveBase');await ui.settle();
 const saved=event();ui.windowHandlers.beforeunload(saved);
 assert.equal(saved.prevented,0);assert.equal(saved.returnValue,undefined);
 assert.equal(ui.get('artworkPendingNotice').dataset.pending,'false');
 await ui.select('face',[128,128]);
 const lastRevoked=ui.revoked.length;
 ui.windowHandlers.pagehide();assert.ok(ui.revoked.length>lastRevoked);
});

test('artwork instructions and pending warning use narrow readable CSS rules',async()=>{
 const html=await readFile(new URL('../../game_runtime/demo.html',import.meta.url),'utf8');
 assert.match(html,/#artworkSteps\{font-size:15px;line-height:1\.55;font-weight:600;color:#edf7fb\}/);
 assert.match(html,/#artworkPendingNotice\[data-pending='true'\]\{[^}]*font-weight:800;[^}]*border-left:3px solid/);
 assert.match(html,/①完成イラストを選ぶ → ② SAVE → ③ 練習へ戻る/);
 assert.match(html,/髪・顔・服の分割や画像工房は、あとからこだわりたい人向けの任意機能/);
});

test('front artwork and portrait preserve the full image and saved layer order at every width',async()=>{
 const html=await readFile(new URL('../../game_runtime/demo.html',import.meta.url),'utf8');
 assert.match(html,/\.front-character #artworkStage\{width:min\(220px,100%\);height:auto;aspect-ratio:150\/192\}/);
 assert.match(html,/#artworkStage img\{[^}]*position:absolute;inset:0;width:100%;height:100%;object-fit:contain/);
 assert.match(html,/#portrait\{[^}]*max-width:94%;[^}]*object-fit:contain/);
 assert.match(html,/#artworkBase\{z-index:0\}#artworkOutfit\{z-index:1\}#artworkFace\{z-index:2\}#artworkHair\{z-index:3\}/);
 const front=html.slice(html.indexOf('id="frontCharacter"'),html.indexOf('id="simpleHome"'));
 const layers=['artworkBase','artworkOutfit','artworkFace','artworkHair'].map(id=>front.indexOf('id="'+id+'"'));
 assert.ok(layers.every((offset,index)=>offset>=0&&(index===0||offset>layers[index-1])));
});

test('selecting front artwork only previews; each SAVE persists only its own slot',async()=>{
 const ui=await mountArtwork({storedSlots:[]});
 const before=JSON.stringify(ui.state.record);
 const initialCalls=ui.calls.length;
 await ui.select('base',[128,128]);
 await ui.select('hair',[128,128]);
 assert.equal(ui.calls.length,initialCalls,'selection must not issue API calls');
 assert.equal(JSON.stringify(ui.state.record),before);
 assert.equal(ui.writes().length,0);
 assert.match(ui.get('artworkBase').src,/^blob:/);
 assert.match(ui.get('artworkHair').src,/^blob:/);
 assert.match(ui.get('skinCaption').textContent,/未保存のプレビューあり/);
 await ui.fire('artworkSaveBase');await ui.settle();
 assert.equal(ui.writes().length,1);
 assert.equal(ui.writes()[0].body.slot,'base');
 assert.equal(ui.state.record.slots.base.exists,true);
 assert.equal(ui.state.record.slots.hair.exists,false,'base SAVE must not save optional previews');
 assert.match(ui.get('artworkBase').src,/^\/api\/artwork\/image\/base\?revision=2$/);
 assert.match(ui.get('artworkHair').src,/^blob:/);
 assert.deepEqual(ui.confirms,[]);
});

test('front scene keeps all four saved layers and restores on reload without auto-save',async()=>{
 const html=await readFile(new URL('../../game_runtime/demo.html',import.meta.url),'utf8');
 const front=html.slice(html.indexOf('id="frontCharacter"'),html.indexOf('id="simpleHome"'));
 for(const id of ['scene','companionName','speech','chibi','portrait','artworkStage',
   'artworkBase','artworkOutfit','artworkFace','artworkHair','skinCaption']) {
   assert.equal(html.split('id="'+id+'"').length-1,1,id);
   assert.ok(front.includes('id="'+id+'"'),id);
 }
 for(const storedSlots of [[],['hair'],['base'],slots]) {
  // A fresh module instance models page reload; reloadArtwork alone only refetches.
  for(let pageLoad=0;pageLoad<2;pageLoad++) {
   const ui=await mountArtwork({storedSlots});
   const before=JSON.stringify(ui.state.record);
   for(let reload=0;reload<2;reload++) {
     assert.equal(ui.get('companionName').textContent,'私の相棒');
     assert.notEqual(ui.get('portrait').hidden,false);
     if(storedSlots.includes('base')) {
       assert.equal(ui.get('artworkStage').hidden,true,'wait for base decode');
       for(const slot of slots) {
         const image=ui.get('artwork'+slot[0].toUpperCase()+slot.slice(1));
         assert.equal(image.hidden,!storedSlots.includes(slot));
         assert.equal(image.src,storedSlots.includes(slot)?'/api/artwork/image/'+slot+'?revision=1':'');
       }
       await ui.get('artworkBase').onload();
       assert.equal(ui.get('artworkStage').hidden,false);
       assert.equal(ui.get('chibi').hidden,true);
       assert.match(ui.get('skinCaption').textContent,/私のイラスト（保存済み）/);
     } else {
       assert.notEqual(ui.get('chibi').hidden,true);
       assert.notEqual(ui.get('artworkStage').hidden,false);
     }
     assert.equal(ui.writes().length,0);
     assert.equal(JSON.stringify(ui.state.record),before);
     if(reload===0){await ui.fire('reloadArtwork');await ui.settle();}
   }
   assert.equal(ui.calls.filter(call=>call.path==='/api/artwork').length,2);
   assert.deepEqual(ui.confirms,[]);
  }
 }
});

test('audit74: real PNG/JPEG/WebP, truncations, CRC, trailing bytes and atomic rejection',async t=>{
  // Generated once with Pillow; Pillow is not needed to run these tests or the game.
  const fixtures=JSON.parse(await readFile(new URL('./artwork-fixtures.json',import.meta.url),'utf8'));
  const dir=await mkdtemp(join(tmpdir(),'creature-audit74-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,'artwork.json'),store=createArtworkStore({file});
  await store.save({slot:'base',image:fixtures.png,expected_revision:0});
  const before=await readFile(file);
  const invalid=[{mime:'image/jpeg',base64:Buffer.from([255,216,255,217]).toString('base64')},
    {...fixtures.png,base64:Buffer.from(fixtures.png.base64,'base64').subarray(0,33).toString('base64')}];
  for(const image of Object.values(fixtures)) {
    assert.ok(validateArtworkImage('base',image).size>0);
    const b=Buffer.from(image.base64,'base64');
    for(let n=0;n<b.length;n++) invalid.push({...image,base64:b.subarray(0,n).toString('base64')});
    invalid.push({...image,base64:Buffer.concat([b,Buffer.from('trailing file')]).toString('base64')});
  }
  const corrupt=Buffer.from(fixtures.png.base64,'base64');corrupt[29]^=1;
  invalid.push({...fixtures.png,base64:corrupt.toString('base64')});
  for(const image of invalid) {
    assert.throws(()=>validateArtworkImage('base',image));
    await assert.rejects(store.save({slot:'base',image,expected_revision:1}));
  }
  assert.deepEqual(await readFile(file),before);
  assert.equal((await store.read()).revision,1);
});

import {deflateSync} from 'node:zlib';
test('audit74: PNG inflation size, filters, CRC and dimension budgets are enforced',()=>{
  function chunk(type,data) {
    const out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);out.write(type,4);data.copy(out,8);
    let crc=0xffffffff;
    for(const byte of out.subarray(4,-4)) {
      crc^=byte;for(let i=0;i<8;i++) crc=(crc>>>1)^((crc&1)?0xedb88320:0);
    }
    out.writeUInt32BE((crc^0xffffffff)>>>0,out.length-4);return out;
  }
  function make({w=1,h=1,raw=Buffer.from([0,1,2,3]),extra=Buffer.alloc(0)}={}) {
    const header=Buffer.alloc(13);header.writeUInt32BE(w);header.writeUInt32BE(h,4);header[8]=8;header[9]=2;
    const b=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),
      chunk('IDAT',Buffer.concat([deflateSync(raw),extra])),chunk('IEND',Buffer.alloc(0))]);
    return {mime:'image/png',base64:b.toString('base64')};
  }
  assert.ok(validateArtworkImage('base',make()));
  for(const image of [make({w:0}),make({w:16385}),make({w:8192,h:8192}),
    make({raw:Buffer.alloc(1024*1024)}),make({raw:Buffer.from([5,1,2,3])}),
    make({raw:Buffer.alloc(3)}),make({extra:Buffer.from('trailing zlib data')})]) {
    assert.throws(()=>validateArtworkImage('base',image));
  }
});
