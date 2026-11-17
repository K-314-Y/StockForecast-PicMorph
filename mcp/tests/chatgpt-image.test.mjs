import {createServer} from 'node:http';
import {MAX_ARTWORK_FILE} from '../../game_runtime/artwork.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createGameServer} from '../../game_runtime/server.mjs';
import {createArtworkStore} from '../../game_runtime/artwork.mjs';
import {createCompanionStore} from '../../game_runtime/companion.mjs';
import {createLookStore} from '../../game_runtime/looks.mjs';
import {createGrowthStore} from '../../game_runtime/growth.mjs';
import {createCompanionChatGptHttpServer} from '../companion-chatgpt.mjs';

const sampleImage={
  mime:'image/png',
  base64:'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGMMqFjAwMDAxMDAwMDAAAAQugFsZnyF3gAAAABJRU5ErkJggg=='
};
async function serve(server) {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return 'http://127.0.0.1:'+server.address().port;
}
async function fixture(t,run) {
  const dir=await mkdtemp(join(tmpdir(),'chatgpt-image-mcp-'));
  const artworkStore=createArtworkStore({file:join(dir,'art.json')});
  const game=createGameServer({
    artworkStore,
    companionStore:createCompanionStore({file:join(dir,'companion.json')}),
    lookStore:createLookStore({file:join(dir,'looks.json')}),
    store:createGrowthStore({file:join(dir,'growth.json'),legacyFile:join(dir,'old.json')}),
  });
  const gameUrl=await serve(game);
  const app=createCompanionChatGptHttpServer({apiBase:gameUrl});
  const mcpUrl=await serve(app);
  t.after(async()=>{
    await new Promise(resolve=>app.close(resolve));
    await new Promise(resolve=>game.close(resolve));
    await rm(dir,{recursive:true,force:true});
  });
  const client=new Client({name:'creature-image-test',version:'1.0.0'});
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl+'/mcp')));
  try{await run({client,gameUrl,dir});}finally{await client.close();}
}
const upload=(url,slot,image=sampleImage)=>fetch(url+'/api/artwork',{
  method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({expected_revision:0,slot,image}),
});

test('MCP read-only workspace snapshot does not save files and does not return art bytes',async t=>{
  await fixture(t,async({client,dir})=>{
    const info=await client.callTool({name:'get_my_character_sheet',arguments:{}});
    assert.equal(info.isError,undefined,JSON.stringify(info));
    assert.equal(info.structuredContent.artwork.created,false);
    assert.equal(info.structuredContent.look.created,false);
    assert.equal(info.structuredContent.companion.created,false);
    assert.equal(info.structuredContent.read_only,true);
    assert.equal(JSON.stringify(info).includes(sampleImage.base64),false);
    assert.deepEqual(await readdir(dir),[]);
  });
});

test('view_my_artwork_image supplies actual user-saved art to ChatGPT as MCP image content',async t=>{
  await fixture(t,async({client,gameUrl,dir})=>{
    const names=(await client.listTools()).tools.map(x=>x.name);
    assert.equal(names.length,10);
    const reader=(await client.listTools()).tools.find(x=>x.name==='view_my_artwork_image');
    assert.equal(reader.annotations.readOnlyHint,true);
    assert.equal(reader.annotations.destructiveHint,false);
    const absent=await client.callTool({name:'view_my_artwork_image',arguments:{slot:'base'}});
    assert.equal(absent.isError,true);
    assert.match(absent.content[0].text,/まだ保存/);
    const saved=await upload(gameUrl,'base');
    assert.equal(saved.status,200);
    const result=await client.callTool({name:'view_my_artwork_image',arguments:{slot:'base'}});
    assert.equal(result.isError,undefined,JSON.stringify(result));
    assert.equal(result.structuredContent.read_only,true);
    assert.equal(result.structuredContent.slot,'base');
    assert.equal(result.structuredContent.automatic_segmentation,false);
    assert.equal(result.content.length,2);
    assert.equal(result.content[0].type,'text');
    assert.equal(result.content[1].type,'image');
    assert.equal(result.content[1].mimeType,'image/png');
    assert.equal(result.content[1].data,sampleImage.base64);
    assert.deepEqual(await readdir(dir),['art.json']);
    const summary=await client.callTool({name:'get_my_character_sheet',arguments:{}});
    assert.equal(summary.structuredContent.artwork.revision,1);
    assert.equal(summary.structuredContent.artwork.slots.base.exists,true);
    assert.equal(JSON.stringify(summary).includes(sampleImage.base64),false);
  });
});

test('MCP refuses arbitrary URLs, unknown image parts and omitted slots',async t=>{
  await fixture(t,async({client,dir})=>{
    for(const args of [
      {slot:'https://attacker.example/collect'},
      {slot:'../../secret'}, {slot:'base',url:'http://attacker.invalid'},
      {},{slot:'source'}, {slot:'hair',share_to_other_user:true},
    ]) {
      const result=await client.callTool({name:'view_my_artwork_image',arguments:args});
      assert.equal(result.isError,true,JSON.stringify(args));
    }
    assert.deepEqual(await readdir(dir),[]);
  });
});

test('MCP returns only the requested saved layer, not an unrelated image',async t=>{
  await fixture(t,async({client,gameUrl})=>{
    const saved=await upload(gameUrl,'hair');
    assert.equal(saved.status,200);
    const hair=await client.callTool({name:'view_my_artwork_image',arguments:{slot:'hair'}});
    assert.equal(hair.isError,undefined);
    assert.equal(hair.content[1].type,'image');
    const base=await client.callTool({name:'view_my_artwork_image',arguments:{slot:'base'}});
    assert.equal(base.isError,true);
    assert.equal(base.content.length,1);
    assert.equal(base.content[0].type,'text');
  });
});

// Fake game never accesses stores, upstream services or a live fixed port.
async function fakeGameFixture(t,handler,run) {
  const requests=[];
  const game=createServer((req,res)=>{requests.push(req.url);handler(req,res);});
  const gameUrl=await serve(game);
  const bridge=createCompanionChatGptHttpServer({apiBase:gameUrl});
  const bridgeUrl=await serve(bridge);
  const client=new Client({name:'bad-image-test',version:'1.0.0'});
  t.after(async()=>{
    await client.close();
    for(const server of [bridge,game]) {
      server.closeAllConnections();
      await new Promise(resolve=>server.close(resolve));
    }
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(bridgeUrl+'/mcp')));
  await run(client,requests);
}
const png=Buffer.from(sampleImage.base64,'base64');
for(const [name,handler] of [
  ['invalid Content-Type',(_req,res)=>res.writeHead(200,{'Content-Type':'text/html'}).end(png)],
  ['binary MIME spoof',(_req,res)=>res.writeHead(200,{'Content-Type':'image/png'}).end('private-not-an-image')],
  ['oversized Content-Length',(_req,res)=>res.writeHead(200,{'Content-Type':'image/png','Content-Length':MAX_ARTWORK_FILE+2049}).end()],
  ['streamed oversized body',(_req,res)=>{res.writeHead(200,{'Content-Type':'image/png'});res.write(Buffer.alloc(MAX_ARTWORK_FILE));res.end(Buffer.alloc(1));}],
  ['missing slot',(_req,res)=>res.writeHead(404).end()],
  ['game failure',(_req,res)=>res.writeHead(500).end('private-not-an-image')],
  ['redirect to arbitrary URL',(_req,res)=>res.writeHead(302,{Location:'http://attacker.invalid/image'}).end()],
]) {
  test('image rejects '+name,async t=>{
    await fakeGameFixture(t,handler,async(client,requests)=>{
      const result=await client.callTool({name:'view_my_artwork_image',arguments:{slot:'base'}});
      assert.equal(result.isError,true);
      assert.ok(result.content.every(item=>item.type==='text'));
      assert.equal(result.structuredContent,undefined);
      assert.equal(JSON.stringify(result).includes(sampleImage.base64),false);
      assert.equal(JSON.stringify(result).includes('private-not-an-image'),false);
      assert.deepEqual(requests,['/api/artwork/image/base']);
    });
  });
}
test('image timeout signal rejects fetch without returning bytes',async t=>{
  // Replace only the timeout factory: immediately abort with the real timeout
  // reason, avoiding a 4.5s timer and any dependence on scheduler timing.
  t.mock.method(AbortSignal,'timeout',()=>AbortSignal.abort(new DOMException('Timed out','TimeoutError')));
  await fakeGameFixture(t,(_req,res)=>{res.writeHead(200,{'Content-Type':'image/png'});res.flushHeaders();},async client=>{
    const result=await client.callTool({name:'view_my_artwork_image',arguments:{slot:'base'}});
    assert.equal(result.isError,true);
    assert.ok(result.content.every(item=>item.type==='text'));
    assert.equal(result.structuredContent,undefined);
    assert.match(result.content[0].text,/Timed out/);
  });
});
