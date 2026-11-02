import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createCompanionStore} from '../../game_runtime/companion.mjs';
import {createGrowthStore} from '../../game_runtime/growth.mjs';
import {createGameServer} from '../../game_runtime/server.mjs';
import {createCompanionChatGptHttpServer,CHATGPT_MCP_PORT} from '../companion-chatgpt.mjs';

async function listen(server) {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return 'http://127.0.0.1:'+server.address().port;
}
async function harness(t, callback) {
  const dir=await mkdtemp(join(tmpdir(),'creature-chatgpt-test-'));
  const companionFile=join(dir,'companion.json');
  const growthFile=join(dir,'growth.json');
  const companionStore=createCompanionStore({file:companionFile});
  const growthStore=createGrowthStore({file:growthFile,legacyFile:join(dir,'missing-old-growth.json')});
  const game=createGameServer({companionStore,store:growthStore});
  const gameUrl=await listen(game);
  const bridge=createCompanionChatGptHttpServer({apiBase:gameUrl});
  const bridgeUrl=await listen(bridge);
  t.after(async()=>{
    await new Promise(resolve=>bridge.close(resolve));
    await new Promise(resolve=>game.close(resolve));
    await rm(dir,{recursive:true,force:true});
  });
  await callback({bridgeUrl,gameUrl,companionFile,dir});
}
async function connect(url) {
  const client=new Client({name:'mcp-creator-test',version:'1.0.0'});
  await client.connect(new StreamableHTTPClientTransport(new URL(url+'/mcp')));
  return client;
}
const input={
  name:'ミオ',
  hair_color:'#FFAACC',
  clothing_color:'#44CCAA',
  approach:'momentum',
  risk_percent:75
};

test('ChatGPT adapter has only three dedicated tools, never legacy Python mutation tools',async t=>{
  await harness(t,async({bridgeUrl})=>{
    const client=await connect(bridgeUrl);
    try {
      const list=await client.listTools();
      const names=list.tools.map(x=>x.name);
      assert.deepEqual(names.sort(),['get_my_companion','get_my_creature_growth','save_my_companion'].sort());
      assert.equal(names.includes('set_model_parameters'),false);
      const writer=list.tools.find(x=>x.name==='save_my_companion');
      assert.equal(writer.annotations.readOnlyHint,false);
      const reader=list.tools.find(x=>x.name==='get_my_companion');
      assert.equal(reader.annotations.readOnlyHint,true);
    }finally{await client.close();}
  });
});

test('ChatGPT MCP writes the *same* Node game companion and restores after reconnect',async t=>{
  await harness(t,async({bridgeUrl,gameUrl,companionFile,dir})=>{
    const client=await connect(bridgeUrl);
    try {
      const before=await client.callTool({name:'get_my_companion',arguments:{}});
      assert.equal(before.isError,undefined);
      assert.equal(before.structuredContent.revision,0);
      assert.equal(before.structuredContent.created,false);
      await assert.rejects(stat(companionFile),{code:'ENOENT'});
      const write=await client.callTool({name:'save_my_companion',arguments:{expected_revision:0,...input}});
      assert.equal(write.isError,undefined,JSON.stringify(write));
      assert.equal(write.structuredContent.revision,1);
      assert.equal(write.structuredContent.companion.hair_color,'#ffaacc');
      const actual=await (await fetch(gameUrl+'/api/companion')).json();
      assert.equal(actual.companion.name,'ミオ');
      assert.equal(actual.companion.risk_percent,75);
      assert.equal(actual.companion.approach,'momentum');
      assert.deepEqual(await (await fetch(gameUrl+'/api/companion')).json(),await (await fetch(gameUrl+'/api/companion')).json());
      const existing=await readFile(companionFile,'utf8');
      assert.equal(JSON.parse(existing).revision,1);
      const stale=await client.callTool({name:'save_my_companion',arguments:{expected_revision:0,...input,name:'古い更新'}});
      assert.equal(stale.isError,true);
      assert.match(stale.content[0].text,/409/);
      assert.equal((await (await fetch(gameUrl+'/api/companion')).json()).revision,1);
      const growth=await client.callTool({name:'get_my_creature_growth',arguments:{}});
      assert.equal(growth.isError,undefined);
      assert.equal(growth.structuredContent.growth.slots.length,3);
      assert.deepEqual((await readdir(dir)).sort(),['companion.json']);
    }finally{await client.close();}
    const reconnect=await connect(bridgeUrl);
    try {
      const saved=await reconnect.callTool({name:'get_my_companion',arguments:{}});
      assert.equal(saved.structuredContent.companion.name,'ミオ');
    }finally{await reconnect.close();}
  });
});

test('Schema rejects arbitrary code, invalid colors and user-provided profit',async t=>{
  await harness(t,async({bridgeUrl,gameUrl})=>{
    const client=await connect(bridgeUrl);
    try {
      for(const bad of [
        {expected_revision:0,...input,profit_coins:99999999},
        {expected_revision:0,...input,hair_color:'red'},
        {expected_revision:0,...input,risk_percent:13},
        {expected_revision:0,...input,approach:'eval(__import__("os"))'},
      ]){
        const response=await client.callTool({name:'save_my_companion',arguments:bad});
        assert.equal(response.isError,true,JSON.stringify(bad));
      }
      assert.equal((await (await fetch(gameUrl+'/api/companion')).json()).created,false);
    }finally{await client.close();}
  });
});

test('MCP listener refuses attacker origin and forged remote host',async t=>{
  await harness(t,async({bridgeUrl})=>{
    const body=JSON.stringify({jsonrpc:'2.0',id:7,method:'tools/list',params:{}});
    const response=await fetch(bridgeUrl+'/mcp',{
      method:'POST',headers:{Origin:'https://attacker.example','Content-Type':'application/json'},body
    });
    assert.equal(response.status,403);
    const endpoint=new URL(bridgeUrl);
    const badHost=await new Promise((resolve,reject)=>{
      const request0=request({hostname:'127.0.0.1',port:Number(endpoint.port),path:'/mcp',method:'POST',
        headers:{Host:'attacker.example','Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},r=>{
          r.resume();r.on('end',()=>resolve(r.statusCode));
        });
      request0.on('error',reject);request0.end(body);
    });
    assert.equal(badHost,403);
    assert.equal((await fetch(bridgeUrl+'/health').then(r=>r.json())).private,true);
    assert.equal((await fetch(bridgeUrl+'/anything')).status,404);
    assert.equal((await fetch(bridgeUrl+'/api/companion')).status,404);
  });
});
