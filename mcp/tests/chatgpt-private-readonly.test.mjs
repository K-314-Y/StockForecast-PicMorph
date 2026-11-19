import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CHATGPT_MCP_PORT, CHATGPT_READ_ONLY_MCP_PORT,
  createCompanionChatGptHttpServer, parseCompanionChatGptArgs,
} from '../companion-chatgpt.mjs';

const allowed=[
  'get_my_artwork','get_my_character_sheet','get_my_companion',
  'get_my_creature_growth','get_my_look','list_my_trained_brains',
].sort();
const forbidden=[
  'save_my_companion','save_my_look','view_my_artwork_image','preview_my_companion',
  'generate_character_parts','package_character_parts','register_demo_character',
];

function listen(server){
  return new Promise(resolve=>server.listen(0,'127.0.0.1',()=>{
    resolve('http://127.0.0.1:'+server.address().port);
  }));
}
function close(server){
  return new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});
}

async function fixture(t,readOnly,fn){
  const upstreamRequests=[];
  const upstream=createServer((req,res)=>{
    upstreamRequests.push([req.method,req.url]);
    const responses={
      '/api/artwork':{
        created:false,revision:0,slots:{
          base:{exists:false},hair:{exists:false},
          face:{exists:false},outfit:{exists:false},
        },
      },
      '/api/companion':{created:false,revision:0,companion:null},
      '/api/looks':{created:false,revision:0,look:null},
      '/api/growth':{revision:0,xp:0,level:1},
      '/api/trained/versions':{versions:[]},
    };
    if(req.method!=='GET'||!(req.url in responses)){
      res.writeHead(405).end('No writes allowed to the test upstream');return;
    }
    res.writeHead(200,{'Content-Type':'application/json'}).end(
      JSON.stringify(responses[req.url]));
  });
  const gameUrl=await listen(upstream);
  const bridge=createCompanionChatGptHttpServer({apiBase:gameUrl,readOnly});
  const bridgeUrl=await listen(bridge);
  const client=new Client({name:'creature-read-only-test',version:'1.0.0'});
  t.after(async()=>{
    await client.close().catch(()=>{});
    await close(bridge);
    await close(upstream);
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(bridgeUrl+'/mcp')));
  return fn({client,bridgeUrl,upstreamRequests});
}

test('read-only bridge exposes exactly six metadata tools, never images/writes/previews',async t=>{
  await fixture(t,true,async({client,bridgeUrl,upstreamRequests})=>{
    const health=await fetch(bridgeUrl+'/health').then(res=>res.json());
    assert.equal(health.tools,6);
    assert.equal(health.private,true);
    const tools=(await client.listTools()).tools;
    assert.deepEqual(tools.map(x=>x.name).sort(),allowed);
    assert.ok(tools.every(x=>x.annotations?.readOnlyHint===true));
    assert.ok(tools.every(x=>x.annotations?.destructiveHint===false));
    assert.ok(tools.every(x=>x.annotations?.openWorldHint===false));
    assert.deepEqual(upstreamRequests,[]);

    for(const name of forbidden) {
      let rejected=false;
      try {
        const response=await client.callTool({name,arguments:{}});
        rejected=response.isError===true;
      }catch {rejected=true;}
      assert.equal(rejected,true,name+' must not be invokable');
      assert.deepEqual(upstreamRequests,[],'blocked tool must never reach the game');
    }
    const artwork=await client.callTool({name:'get_my_artwork',arguments:{}});
    assert.equal(artwork.isError,undefined);
    assert.equal(artwork.structuredContent.slots.base.exists,false);
    assert.equal(JSON.stringify(artwork).includes('base64'),false);
    const sheet=await client.callTool({name:'get_my_character_sheet',arguments:{}});
    assert.equal(sheet.isError,undefined);
    assert.equal(sheet.structuredContent.read_only,true);
    assert.equal(JSON.stringify(sheet).includes('base64'),false);
    assert.ok(upstreamRequests.length>0);
    assert.ok(upstreamRequests.every(([method,url])=>
      method==='GET' && !url.startsWith('/api/artwork/image/')));
  });
});

test('full local MCP exposes all thirteen tools',async t=>{
  await fixture(t,false,async({client,bridgeUrl,upstreamRequests})=>{
    const health=await fetch(bridgeUrl+'/health').then(res=>res.json());
    assert.equal(health.tools,13);
    const names=(await client.listTools()).tools.map(x=>x.name);
    assert.equal(names.length,13);
    for(const name of [...allowed,...forbidden])assert.ok(names.includes(name),name);
    assert.deepEqual(upstreamRequests,[]);
  });
});

test('CLI defaults to isolated loopback port and rejects invalid options',()=>{
  assert.deepEqual(parseCompanionChatGptArgs([]),{readOnly:false,port:CHATGPT_MCP_PORT});
  assert.deepEqual(parseCompanionChatGptArgs(['--read-only']),
    {readOnly:true,port:CHATGPT_READ_ONLY_MCP_PORT});
  assert.deepEqual(parseCompanionChatGptArgs(['--port=9999','--read-only']),
    {readOnly:true,port:9999});
  for(const args of [
    ['--port=0'],['--port=-1'],['--port=65536'],['--port=99999'],
    ['--port=12345','--port=12346'],['--read-only','--read-only'],
    ['--host=0.0.0.0'],['--port=abc'],['--help'],
  ]) assert.throws(()=>parseCompanionChatGptArgs(args));
  assert.deepEqual(parseCompanionChatGptArgs(['--port=8897']),
    {readOnly:false,port:8897}); // An explicit port alone does not mean read-only.
});
