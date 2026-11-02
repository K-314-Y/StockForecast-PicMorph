import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,stat,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createArtworkStore,validateArtworkImage} from '../../game_runtime/artwork.mjs';
import {createGameServer} from '../../game_runtime/server.mjs';
import {createCompanionChatGptHttpServer} from '../companion-chatgpt.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const png={mime:'image/png',base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9F7pSAAAAABJRU5ErkJggg=='};
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
    assert.equal(tools.length,8);
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
});
