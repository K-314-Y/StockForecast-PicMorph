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

const model = {fast_window:3,slow_window:9,risk_fraction:.35,
  plugin_weights:{trend:100,momentum:0,volatility:0,reversion:0},
  plugin_strengths:{trend:100,momentum:100,volatility:100,reversion:100}};
const trainingId='tv_'+'b'.repeat(32);
const draftId='bp_'+'a'.repeat(32);
const trainedModel={...model,risk_fraction:.55,
  plugin_weights:{trend:0,momentum:100,volatility:0,reversion:0}};
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
  const loadSnapshot=async()=>{
    const growth=await growthStore.public();
    return {state:{model,revision:11},
      lineup:{slots:[{slot:'owl',model},{slot:'turtle',model}],revision:7},
      growth,source_revision:11,lineup_revision:7,growth_revision:growth.revision};
  };
  const game=createGameServer({companionStore,store:growthStore,loadSnapshot,
    trainedVersions:async()=>({versions:[{id:trainingId,source_draft_id:draftId,
      status:'practice_only',source_name:'手作りテスト版'}]}),
    trainedVersion:async id=>id===trainingId?{version_id:id,
      kind:'trained_practice_only',source_draft_id:draftId,
      parameters_sha256:'c'.repeat(64),model:trainedModel}:null,
  });
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

test('ChatGPT adapter exposes sixteen private tools, never legacy Python mutation tools',async t=>{
  await harness(t,async({bridgeUrl})=>{
    const client=await connect(bridgeUrl);
    try {
      const list=await client.listTools();
      const names=list.tools.map(x=>x.name);
      assert.deepEqual(names.sort(),['get_my_companion','get_my_creature_growth','save_my_companion', 'preview_my_companion','list_my_trained_brains','get_my_look','save_my_look','get_my_artwork','get_my_character_sheet','view_my_artwork_image','generate_character_parts','package_character_parts','register_demo_character','inspect_character_image_for_parts','preview_segment_candidate','save_segment_candidate'].sort());
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

test('ChatGPT tries an unsaved character, without writing or earning XP',async t=>{
  await harness(t,async({bridgeUrl,gameUrl,dir,companionFile})=>{
    const client=await connect(bridgeUrl);
    try {
      const original=await (await fetch(gameUrl+'/api/companion')).json();
      assert.equal(original.created,false);
      const trial={name:'試作品ルナ',hair_color:'#aabbcc',clothing_color:'#ddeeff',
        approach:'momentum',risk_percent:70};
      const preview=await client.callTool({name:'preview_my_companion',arguments:{
        mine_pct:100,owl_pct:0,turtle_pct:0,candidate:trial
      }});
      assert.equal(preview.isError,undefined,JSON.stringify(preview));
      const result=preview.structuredContent.result;
      assert.equal(result.preview_only,true);
      assert.equal(result.training_ticket,null);
      assert.equal(result.brain.kind,'unsaved_candidate_preview');
      assert.equal(result.candidate_applied,true);
      assert.equal(result.companion_name,'試作品ルナ');
      assert.equal(result.risk_percent,70);
      assert.deepEqual(result.characters.mine.plugin_weights,{
        trend:0,momentum:100,volatility:0,reversion:0});
      assert.equal(result.characters.mine.risk_fraction,.7);
      assert.equal(result.steps,12);
      assert.equal((await (await fetch(gameUrl+'/api/companion')).json()).created,false);
      await assert.rejects(stat(companionFile),{code:'ENOENT'});
      assert.deepEqual(await readdir(dir),[]);
      // Client outcomes and allocation tricks are rejected at the MCP layer.
      for(const args of [
        {mine_pct:100,owl_pct:0,turtle_pct:0,candidate:trial,profit_coins:999999},
        {mine_pct:100,owl_pct:0,turtle_pct:0,candidate:{...trial,approach:'bad'}},
        {mine_pct:99,owl_pct:9,turtle_pct:0},
        {mine_pct:0,owl_pct:0,turtle_pct:0},
        {mine_pct:100,owl_pct:0,turtle_pct:0,candidate:trial,trained_version_id:trainingId},
      ]) {
        const rejected=await client.callTool({name:'preview_my_companion',arguments:args});
        assert.equal(rejected.isError,true,JSON.stringify(args));
      }
      assert.deepEqual(await readdir(dir),[]);
    }finally {await client.close();}
  });
});

test('ChatGPT lists trained practice brains, then previews one with source provenance',async t=>{
  await harness(t,async({bridgeUrl,dir})=>{
    const client=await connect(bridgeUrl);
    try {
      const catalog=await client.callTool({name:'list_my_trained_brains',arguments:{}});
      assert.equal(catalog.isError,undefined,JSON.stringify(catalog));
      assert.equal(catalog.structuredContent.versions[0].id,trainingId);
      const preview=await client.callTool({name:'preview_my_companion',arguments:{
        mine_pct:100,owl_pct:0,turtle_pct:0,trained_version_id:trainingId}});
      assert.equal(preview.isError,undefined,JSON.stringify(preview));
      const result=preview.structuredContent.result;
      assert.equal(result.preview_only,true);
      assert.equal(result.training_ticket,null);
      assert.equal(result.brain.kind,'trained_practice_only');
      assert.equal(result.brain.version_id,trainingId);
      assert.equal(result.brain.source_draft_id,draftId);
      assert.equal(result.companion_applied,false);
      assert.equal(result.characters.mine.risk_fraction,.55);
      assert.deepEqual(await readdir(dir),[]);
    }finally {await client.close();}
  });
});

test('Game preview API returns no reward ticket while actual practice still can issue one',async t=>{
  await harness(t,async({gameUrl,dir})=>{
    const request=async(path,body)=>{
      const response=await fetch(gameUrl+path,{method:'POST',
        headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      return {status:response.status, result:await response.json()};
    };
    const candidate={name:'自分の実験',hair_color:'#ffaa11',clothing_color:'#22bb66',
      approach:'trend',risk_percent:55};
    const preview=await request('/api/practice/preview',{allocations:{mine:100,owl:0,turtle:0},candidate});
    assert.equal(preview.status,200);
    assert.equal(preview.result.training_ticket,null);
    assert.equal(preview.result.preview_only,true);
    const invalid=await request('/api/practice/preview',{allocations:{mine:100,owl:0,turtle:0},
      candidate,trained_version_id:trainingId});
    assert.equal(invalid.status,400);
    const invalidProfit=await request('/api/practice/preview',{allocations:{mine:100,owl:0,turtle:0},profit_coins:9000});
    assert.equal(invalidProfit.status,400);
    const actual=await request('/api/practice',{allocations:{mine:100,owl:0,turtle:0}});
    assert.equal(actual.status,200);
    assert.match(actual.result.training_ticket,/^[a-f0-9]{48}$/);
    assert.equal(actual.result.preview_only,false);
    assert.deepEqual(await readdir(dir),[]);
  });
});

test('An unsaved draft trial and later saved game use the same prediction and coin logic',async t=>{
  await harness(t,async({bridgeUrl,gameUrl,companionFile})=>{
    const client=await connect(bridgeUrl);
    const candidate={name:'私の設計',hair_color:'#a1b2c3',clothing_color:'#11bb77',
      approach:'reversion',risk_percent:65};
    const preview=await client.callTool({name:'preview_my_companion',arguments:{
      mine_pct:100,owl_pct:0,turtle_pct:0,candidate}});
    assert.equal(preview.isError,undefined,JSON.stringify(preview));
    const trial=preview.structuredContent.result;
    assert.equal(trial.training_ticket,null);
    await assert.rejects(stat(companionFile),{code:'ENOENT'});
    const saved=await client.callTool({name:'save_my_companion',arguments:{
      expected_revision:0,...candidate}});
    assert.equal(saved.isError,undefined,JSON.stringify(saved));
    const response=await fetch(gameUrl+'/api/practice',{method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({allocations:{mine:100,owl:0,turtle:0}})});
    assert.equal(response.status,200);
    const actual=await response.json();
    assert.equal(actual.preview_only,false);
    assert.equal(actual.companion_applied,true);
    assert.equal(actual.candidate_applied,false);
    assert.match(actual.training_ticket,/^[a-f0-9]{48}$/);
    assert.equal(actual.final_coins,trial.final_coins);
    assert.deepEqual(actual.decisions,trial.decisions);
    assert.deepEqual(actual.equity_path,trial.equity_path);
    assert.equal(actual.characters.mine.effective_sha256,trial.characters.mine.effective_sha256);
    await client.close();
  });
});
